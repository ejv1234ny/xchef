import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { ServiceClient } from "@/lib/db/service";
import type { Database, Json, Tables } from "@/lib/db/types";
import { downloadInvoiceBytes, ensureInvoicesBucket, ensurePdfPreview, extForMime, INVOICES_BUCKET, invoiceStoragePath, maxBytesFor } from "@/lib/storage";
import { heicToJpeg, pdfTextLength } from "@/lib/pdf-preview";
import { columnMapIsUsable, detectHeaderRow, extractLines, groupByInvoice, inferColumnMap, isSpreadsheet, matchKnownLayout, readSpreadsheet, type SheetLine } from "@/lib/core/sheets";
import { logLlmCall } from "@/lib/llm/anthropic";
import { isLlmConfigured, selectedProviderName } from "@/lib/llm/provider";
import { modelFor } from "@/lib/llm/models";
import { normalizeMime, type InvoiceParseLine, type InvoiceParsedDocument } from "@/lib/llm/invoice-parse";
import { extractInvoiceFromFile, isRejectedDocument } from "@/lib/llm/invoice-extract";
import { parseInvoiceDocumentJob } from "./parseInvoice";
import { parseSpreadsheetDocumentJob } from "./parseSpreadsheet";
import { mapInvoiceDocument } from "./mapInvoice";
import { postInvoiceIfResolved } from "./postInvoice";

/**
 * Intake: every channel (email | forward | upload | paste | manual | api)
 * becomes one invoice_documents row and then runs the same parse → map → post
 * pipeline (CLAUDE.md rule 9). Dedupe: (location_id, content_hash) for files
 * and text; email_message_id for body-text documents (one email can carry
 * several attachments, so attachments dedupe by their own hash).
 */

export type Logger = (msg: string, meta?: Record<string, unknown>) => void;
export type IntakeSource = Database["public"]["Enums"]["invoice_source"];

export type IntakeInput = {
  locationId: string;
  source: IntakeSource;
  bytes?: Uint8Array;
  mimeType: string;
  filename: string;
  text?: string;
  emailFrom?: string | null;
  emailSubject?: string | null;
  emailMessageId?: string | null;
  vendorId?: string | null;
};

export function sha256(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export async function getLocation(svc: ServiceClient, locationId: string): Promise<{ id: string; tenant_id: string; name: string; timezone: string }> {
  const { data, error } = await svc.from("locations").select("id, tenant_id, name, timezone").eq("id", locationId).maybeSingle();
  if (error) throw new Error(`read location: ${error.message}`);
  if (!data) throw new Error(`location ${locationId} not found`);
  return data;
}

const GENERIC_EMAIL_DOMAINS = new Set(["gmail.com", "yahoo.com", "outlook.com", "hotmail.com", "icloud.com", "aol.com", "me.com", "live.com", "msn.com", "comcast.net"]);

export function emailDomain(address: string | null | undefined): string | null {
  const m = (address ?? "").toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})/);
  if (!m) return null;
  return GENERIC_EMAIL_DOMAINS.has(m[1]) ? null : m[1];
}

/**
 * Vendor upsert by (tenant_id, lower(name)); a parsed name that contains or is
 * contained by an existing vendor's name (case-insensitive, ≥ 3 chars) reuses
 * it ("Sysco Albany" ↔ "Sysco"). Adds the sender's domain to email_domains.
 */
type VendorRow = { id: string; name: string; email_domains: string[] | null };

/** The matching rule of findOrCreateVendor, without the create (pure over a vendor list). */
export function matchVendor<V extends VendorRow>(vendors: V[], name: string, senderDomain?: string | null): V | undefined {
  const lower = name.replace(/\s+/g, " ").trim().toLowerCase();
  let match = vendors.find((v) => v.name.toLowerCase() === lower);
  if (!match && lower.length >= 3) {
    match = vendors.find((v) => {
      const vn = v.name.toLowerCase();
      return vn.length >= 3 && (vn.includes(lower) || lower.includes(vn));
    });
  }
  if (!match && senderDomain) match = vendors.find((v) => (v.email_domains ?? []).includes(senderDomain));
  return match;
}

/** Lookup-only twin of findOrCreateVendor: null when no vendor matches (never creates one). */
export async function findVendorByName(svc: ServiceClient, tenantId: string, name: string): Promise<{ id: string; name: string } | null> {
  const { data: vendors, error } = await svc.from("vendors").select("id, name, email_domains").eq("tenant_id", tenantId);
  if (error) throw new Error(`read vendors: ${error.message}`);
  const match = matchVendor(vendors ?? [], name);
  return match ? { id: match.id, name: match.name } : null;
}

export async function findOrCreateVendor(svc: ServiceClient, tenantId: string, name: string, senderDomain?: string | null): Promise<{ id: string; name: string }> {
  const clean = name.replace(/\s+/g, " ").trim() || "Unknown vendor";
  const { data: vendors, error } = await svc.from("vendors").select("id, name, email_domains").eq("tenant_id", tenantId);
  if (error) throw new Error(`read vendors: ${error.message}`);
  const match = matchVendor(vendors ?? [], clean, senderDomain);
  if (match) {
    if (senderDomain && !(match.email_domains ?? []).includes(senderDomain)) {
      await svc
        .from("vendors")
        .update({ email_domains: [...(match.email_domains ?? []), senderDomain] })
        .eq("id", match.id);
    }
    return { id: match.id, name: match.name };
  }
  const { data: created, error: ierr } = await svc
    .from("vendors")
    .insert({ tenant_id: tenantId, name: clean, email_domains: senderDomain ? [senderDomain] : [] })
    .select("id, name")
    .single();
  if (ierr) {
    // unique (tenant_id, name) race: read it back
    const { data: again } = await svc.from("vendors").select("id, name").eq("tenant_id", tenantId).eq("name", clean).maybeSingle();
    if (again) return again;
    throw new Error(`insert vendor: ${ierr.message}`);
  }
  return created;
}

/**
 * Store the file and insert the invoice_documents row (status 'received').
 * Returns the existing id with duplicate=true when the same content (or the
 * same email body) already landed for this location.
 */
export async function createInvoiceDocument(svc: ServiceClient, input: IntakeInput): Promise<{ documentId: string; duplicate: boolean }> {
  const isManual = input.source === "manual";
  const text = input.text ?? "";
  let bytes = input.bytes && input.bytes.byteLength > 0 ? input.bytes : new Uint8Array(Buffer.from(text, "utf8"));
  if (bytes.byteLength === 0) throw new Error("empty document");
  // Phone photos arrive as HEIC; browsers and the parser want JPEG. Convert before hashing so re-uploads dedupe.
  const inMime = (input.mimeType || "").toLowerCase().split(";")[0].trim();
  if (input.bytes && (inMime === "image/heic" || inMime === "image/heif" || /\.hei[cf]$/i.test(input.filename))) {
    const jpeg = await heicToJpeg(bytes);
    if (jpeg) {
      bytes = jpeg;
      input = { ...input, mimeType: "image/jpeg", filename: input.filename.replace(/\.hei[cf]$/i, "") + ".jpg" };
    }
  }
  const cap = maxBytesFor(input.mimeType);
  if (bytes.byteLength > cap) throw new Error(`${input.filename}: ${(bytes.byteLength / 1048576).toFixed(1)} MB exceeds the ${cap / 1048576} MB limit for this type`);
  const hash = sha256(bytes);

  const { data: dupe, error: derr } = await svc
    .from("invoice_documents")
    .select("id")
    .eq("location_id", input.locationId)
    .eq("content_hash", hash)
    .maybeSingle();
  if (derr) throw new Error(`dedupe lookup: ${derr.message}`);
  if (dupe) return { documentId: dupe.id, duplicate: true };

  if (input.emailMessageId && !input.bytes) {
    const { data: sameMsg } = await svc
      .from("invoice_documents")
      .select("id")
      .eq("location_id", input.locationId)
      .eq("email_message_id", input.emailMessageId)
      .limit(1);
    if (sameMsg && sameMsg.length > 0) return { documentId: sameMsg[0].id, duplicate: true };
  }

  const mime = isManual ? "application/json" : input.bytes ? input.mimeType || "application/octet-stream" : "text/plain";
  const storagePath = isManual ? `manual/${randomUUID()}.json` : invoiceStoragePath(input.locationId, new Date(), hash, extForMime(mime, input.filename));

  await ensureInvoicesBucket(svc);
  const { error: uerr } = await svc.storage.from(INVOICES_BUCKET).upload(storagePath, bytes, { contentType: mime, upsert: false });
  if (uerr && !/already exists|duplicate/i.test(uerr.message)) throw new Error(`storage upload ${storagePath}: ${uerr.message}`);
  if (mime === "application/pdf") {
    // First-page PNG for phones that cannot embed PDFs. Best-effort; never blocks intake.
    try {
      await ensurePdfPreview(svc, storagePath, bytes);
    } catch (e) {
      console.warn(JSON.stringify({ msg: "pdf-preview: skipped", storagePath, error: e instanceof Error ? e.message : String(e) }));
    }
  }

  const { data: doc, error: ierr } = await svc
    .from("invoice_documents")
    .insert({
      location_id: input.locationId,
      vendor_id: input.vendorId ?? null,
      source: input.source,
      status: "received",
      storage_path: storagePath,
      email_from: input.emailFrom ?? null,
      email_subject: input.emailSubject ?? null,
      email_message_id: input.emailMessageId ?? null,
      content_hash: hash,
    })
    .select("id")
    .single();
  if (ierr) {
    if (/duplicate|unique/i.test(ierr.message)) {
      const { data: again } = await svc.from("invoice_documents").select("id").eq("location_id", input.locationId).eq("content_hash", hash).maybeSingle();
      if (again) return { documentId: again.id, duplicate: true };
    }
    throw new Error(`insert invoice_documents: ${ierr.message}`);
  }
  return { documentId: doc.id, duplicate: false };
}

export type ManualLine = {
  description: string;
  vendor_sku?: string | null;
  pack_size_text?: string | null;
  quantity: string | number;
  unit_price?: string | number | null;
  extended_price?: string | number | null;
  category_guess?: string | null;
};

export type ManualInvoiceInput = {
  locationId: string;
  source?: "manual" | "api";
  vendorName: string;
  invoiceDate: string | null;
  invoiceNumber?: string | null;
  receivedDate?: string | null;
  subtotal?: string | number | null;
  tax?: string | number | null;
  total?: string | number | null;
  lines: ManualLine[];
  /** stored in raw_extraction for audit (e.g. spreadsheet provenance) */
  meta?: Json;
  /** what to hash for dedupe; defaults to the vendor/number/date/lines JSON */
  contentKey?: unknown;
};

function toNum(v: string | number | null | undefined, digits: number): number | null {
  if (v == null || v === "") return null;
  const d = new Decimal(v);
  return d.isNaN() ? null : Number(d.toFixed(digits));
}

/**
 * Manual intake: no parsing. Writes the lines directly (status needs_review),
 * stores the lines JSON at manual/<uuid>.json so it is auditable, then map + post
 * happen in runInvoicePipeline. Dedupes on the content hash of the lines JSON.
 */
export async function createManualInvoiceDocument(svc: ServiceClient, input: ManualInvoiceInput): Promise<{ documentId: string; duplicate: boolean; vendorId: string }> {
  const location = await getLocation(svc, input.locationId);
  const vendor = await findOrCreateVendor(svc, location.tenant_id, input.vendorName);
  const key = input.contentKey ?? { vendor: vendor.name, invoiceNumber: input.invoiceNumber ?? null, invoiceDate: input.invoiceDate, lines: input.lines };
  const payload = JSON.stringify({ vendorName: vendor.name, invoiceNumber: input.invoiceNumber ?? null, invoiceDate: input.invoiceDate, lines: input.lines, meta: input.meta ?? null, key });

  const created = await createInvoiceDocument(svc, {
    locationId: input.locationId,
    source: input.source ?? "manual",
    mimeType: "application/json",
    filename: "manual.json",
    text: payload,
    vendorId: vendor.id,
  });
  if (created.duplicate) return { ...created, vendorId: vendor.id };

  const rows: Database["public"]["Tables"]["invoice_lines"]["Insert"][] = input.lines.map((l, i) => ({
    invoice_id: created.documentId,
    line_no: i + 1,
    vendor_sku: l.vendor_sku?.trim() || null,
    description: l.description.trim() || "(no description)",
    pack_size_text: l.pack_size_text?.trim() || null,
    quantity: toNum(l.quantity, 4) ?? 0,
    unit_price: toNum(l.unit_price, 4),
    extended_price: toNum(l.extended_price, 2),
    ai_category_guess: l.category_guess ?? null,
    ai_confidence: null,
    status: "unmapped",
  }));
  if (rows.length) {
    const { error } = await svc.from("invoice_lines").insert(rows);
    if (error) throw new Error(`insert invoice_lines: ${error.message}`);
  }
  const subtotal = toNum(input.subtotal, 2) ?? Number(rows.reduce((a, r) => a.plus(r.extended_price ?? 0), new Decimal(0)).toFixed(2));
  const { error: uerr } = await svc
    .from("invoice_documents")
    .update({
      status: "needs_review",
      vendor_id: vendor.id,
      invoice_number: input.invoiceNumber ?? null,
      invoice_date: input.invoiceDate,
      received_date: input.receivedDate ?? input.invoiceDate,
      subtotal,
      tax: toNum(input.tax, 2),
      total: toNum(input.total, 2),
      parse_confidence: 1,
      raw_extraction: (input.meta ?? { source: input.source ?? "manual", lines: input.lines }) as Json,
    })
    .eq("id", created.documentId);
  if (uerr) throw new Error(`update invoice_documents: ${uerr.message}`);
  return { ...created, vendorId: vendor.id };
}

export type PipelineResult = { status: string; lines: number; mapped: number; unmapped: number; /** extra invoice_documents created from a multi-invoice spreadsheet */ siblings?: number };

/**
 * parse (unless source is manual or lines already exist) → map → post.
 * Idempotent: a posted or rejected document is left alone; a document that
 * already has lines is not re-parsed unless `reparse` is set (re-parsing
 * deletes and rewrites its lines, including human confirmations).
 */
export async function runInvoicePipeline(svc: ServiceClient, documentId: string, opts: { log?: Logger; reparse?: boolean } = {}): Promise<PipelineResult> {
  const log = opts.log ?? (() => {});
  const { data: doc, error } = await svc.from("invoice_documents").select("id, source, status, storage_path").eq("id", documentId).maybeSingle();
  if (error) throw new Error(`read invoice_documents: ${error.message}`);
  if (!doc) throw new Error(`document ${documentId} not found`);

  const counts = async (): Promise<PipelineResult> => {
    const { data: d } = await svc.from("invoice_documents").select("status").eq("id", documentId).single();
    const { data: ls } = await svc.from("invoice_lines").select("status").eq("invoice_id", documentId);
    const lines = ls ?? [];
    return {
      status: d?.status ?? doc.status,
      lines: lines.length,
      mapped: lines.filter((l) => l.status === "auto_mapped" || l.status === "confirmed").length,
      unmapped: lines.filter((l) => l.status === "unmapped").length,
    };
  };

  if (doc.status === "posted" || doc.status === "rejected") {
    log("invoice-pipeline: skipped", { documentId, status: doc.status });
    return counts();
  }

  const filename = doc.storage_path.split("/").pop() ?? doc.storage_path;
  const spreadsheet = doc.source !== "manual" && isSpreadsheet("", filename);
  let siblings: string[] = [];

  if (doc.source !== "manual") {
    const { count } = await svc.from("invoice_lines").select("id", { count: "exact", head: true }).eq("invoice_id", documentId);
    if (opts.reparse || !count) {
      if (spreadsheet) {
        // Deterministic sheet parse (lib/jobs/parseSpreadsheet.ts); may split one file into several invoices.
        const parsed = await parseSpreadsheetDocumentJob(svc, documentId, { log });
        log("invoice-pipeline: parsed spreadsheet", { documentId, ...parsed });
        siblings = parsed.documents.filter((d) => d !== documentId);
        if (parsed.status === "rejected") return counts();
      } else {
        const parsed = await parseInvoiceDocumentJob(svc, documentId, { log });
        log("invoice-pipeline: parsed", { documentId, ...parsed });
        if (parsed.status === "deleted") return { status: "deleted", lines: 0, mapped: 0, unmapped: 0, siblings: 0 };
        siblings = parsed.documents.filter((d) => d !== documentId);
        if (parsed.status === "rejected" || parsed.status === "received") return counts();
      }
    } else {
      const { data: d } = await svc.from("invoice_documents").select("raw_extraction").eq("id", documentId).single();
      const ex = d?.raw_extraction as { sibling_document_ids?: string[] } | null;
      siblings = Array.isArray(ex?.sibling_document_ids) ? ex.sibling_document_ids : [];
    }
  }

  for (const id of [documentId, ...siblings]) {
    const mapped = await mapInvoiceDocument(svc, id, { log });
    log("invoice-pipeline: mapped", { documentId: id, ...mapped });
    const posted = await postInvoiceIfResolved(svc, id);
    log("invoice-pipeline: post", { documentId: id, result: posted });
  }
  const result = await counts();
  return siblings.length ? { ...result, siblings: siblings.length } : result;
}

// ============================================================================
//  Vendor-portal pull (KICKOFF-2 Part 2): `api` documents, attach / dedupe
// ============================================================================
//
// Paper arrives at delivery (upload/forward/email); the authoritative copy is
// pulled from the vendor's portal the next morning (source 'api'). Decision
// table for an `api` arrival carrying (vendor, invoice_number):
//
//   no document with that (vendor_id, invoice_number) at the location
//       → createInvoiceDocument(source 'api') + runInvoicePipeline      outcome 'created'
//   same bytes already stored for the location (content_hash match)
//       → nothing written                                               outcome 'duplicate'
//   existing document, not paper (api / manual / paste / spreadsheet /
//   text PDF)  → clean file stored next to it, clean_storage_path set   outcome 'stored'
//   existing paper document (upload/forward/email + image, or a PDF
//   with no text layer):
//       → clean copy stored, then re-read from the clean bytes;
//         Σ extended_price within $0.01 AND same line count
//           → verified_by_clean_copy_at = now, posted lines kept        outcome 'verified'
//         otherwise
//           → status 'needs_review', parse_diff = paper said / portal says
//                                                                      outcome 'needs_review'
// Every arrival is recorded in inbound_events (provider 'portal').

export type DiffLine = {
  line_no: number;
  vendor_sku: string | null;
  description: string;
  /** Decimal strings — never floats (CLAUDE.md conventions). */
  quantity: string;
  unit_price: string | null;
  extended_price: string | null;
};

export type ParseDiffEntry = {
  kind: "changed" | "missing_on_portal" | "missing_on_paper";
  paper: DiffLine | null;
  portal: DiffLine | null;
  /** which of quantity / unit_price / extended_price differ (kind 'changed') */
  fields: string[];
};

export type ParseDiffSide = { line_count: number; sum: string; lines: DiffLine[] };

export type ParseDiff = {
  paper: ParseDiffSide;
  portal: ParseDiffSide;
  diffs: ParseDiffEntry[];
  /** portal Σ − paper Σ, 2 dp */
  sum_delta: string;
  /** true when line counts agree and |sum_delta| ≤ 0.01 — the "keep the posted lines" gate */
  matches: boolean;
  compared_at: string;
};

const CENT = new Decimal("0.01");

function dec(v: string | number | null | undefined): Decimal | null {
  if (v == null || v === "") return null;
  const d = new Decimal(v);
  return d.isNaN() ? null : d;
}

function decStr(v: string | number | null | undefined, dp: number): string | null {
  const d = dec(v);
  return d ? d.toFixed(dp) : null;
}

/** Exact per-line equality (a cent on a line is shown); the one-cent tolerance applies to the document sum only. */
function sameAmount(a: string | null, b: string | null): boolean {
  const x = dec(a);
  const y = dec(b);
  if (!x && !y) return true;
  if (!x || !y) return false;
  return x.eq(y);
}

function normDescription(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

export function sumDiffLines(lines: DiffLine[]): string {
  return lines.reduce((a, l) => a.plus(dec(l.extended_price) ?? 0), new Decimal(0)).toFixed(2);
}

/**
 * Pure: pair the paper lines with the portal lines (vendor SKU first, then
 * normalized description, preferring the candidate with the same amount) and
 * list what differs. `matches` is the verification gate the attach job uses.
 */
export function diffParsedLines(paperLines: DiffLine[], portalLines: DiffLine[], now: Date = new Date()): ParseDiff {
  const unusedPortal = new Set(portalLines.map((_, i) => i));
  const diffs: ParseDiffEntry[] = [];

  const pick = (paper: DiffLine): number | null => {
    const bySku = paper.vendor_sku
      ? [...unusedPortal].filter((i) => portalLines[i].vendor_sku && portalLines[i].vendor_sku!.trim().toLowerCase() === paper.vendor_sku!.trim().toLowerCase())
      : [];
    const byDesc = bySku.length ? bySku : [...unusedPortal].filter((i) => normDescription(portalLines[i].description) === normDescription(paper.description));
    if (byDesc.length === 0) return null;
    return byDesc.find((i) => sameAmount(portalLines[i].extended_price, paper.extended_price)) ?? byDesc[0];
  };

  for (const paper of paperLines) {
    const idx = pick(paper);
    if (idx == null) {
      diffs.push({ kind: "missing_on_portal", paper, portal: null, fields: [] });
      continue;
    }
    unusedPortal.delete(idx);
    const portal = portalLines[idx];
    const fields: string[] = [];
    if (!sameAmount(paper.quantity, portal.quantity)) fields.push("quantity");
    if (!sameAmount(paper.unit_price, portal.unit_price)) fields.push("unit_price");
    if (!sameAmount(paper.extended_price, portal.extended_price)) fields.push("extended_price");
    if (fields.length) diffs.push({ kind: "changed", paper, portal, fields });
  }
  for (const i of [...unusedPortal].sort((a, b) => a - b)) diffs.push({ kind: "missing_on_paper", paper: null, portal: portalLines[i], fields: [] });

  const paperSum = sumDiffLines(paperLines);
  const portalSum = sumDiffLines(portalLines);
  const delta = new Decimal(portalSum).minus(paperSum);
  return {
    paper: { line_count: paperLines.length, sum: paperSum, lines: paperLines },
    portal: { line_count: portalLines.length, sum: portalSum, lines: portalLines },
    diffs,
    sum_delta: delta.toFixed(2),
    matches: paperLines.length === portalLines.length && delta.abs().lte(CENT),
    compared_at: now.toISOString(),
  };
}

export function diffLineFromInvoiceLine(l: Pick<Tables<"invoice_lines">, "line_no" | "vendor_sku" | "description" | "quantity" | "unit_price" | "extended_price">): DiffLine {
  return { line_no: l.line_no, vendor_sku: l.vendor_sku, description: l.description, quantity: decStr(l.quantity, 4) ?? "0", unit_price: decStr(l.unit_price, 4), extended_price: decStr(l.extended_price, 2) };
}

export function diffLineFromParsed(l: InvoiceParseLine, index: number, isCredit: boolean): DiffLine {
  const sign = isCredit ? -1 : 1;
  const q = new Decimal(Math.abs(l.quantity)).times(sign);
  const ext = l.extended_price == null ? null : new Decimal(l.extended_price).abs().times(sign).toFixed(2);
  return {
    line_no: index + 1,
    vendor_sku: l.vendor_sku?.trim() || null,
    description: l.description.trim() || "(no description)",
    quantity: q.toFixed(4),
    unit_price: l.unit_price == null ? null : new Decimal(Math.abs(l.unit_price)).toFixed(4),
    extended_price: ext,
  };
}

export function diffLineFromSheet(l: SheetLine, index: number): DiffLine {
  return { line_no: index + 1, vendor_sku: l.vendor_sku, description: l.description, quantity: decStr(l.quantity, 4) ?? "0", unit_price: decStr(l.unit_price, 4), extended_price: decStr(l.extended_price, 2) };
}

const IMAGE_EXT = /\.(jpe?g|png|webp|gif|heic|heif)$/i;
const PAPER_SOURCES = new Set<IntakeSource>(["upload", "forward", "email"]);
const SCAN_TEXT_CHARS_PER_PAGE = 40;

/**
 * "Paper" = the document came in through a human/email channel as a photo, or
 * as a PDF without a text layer (a scan). A text PDF from the vendor is
 * already authoritative and is not re-read.
 */
export async function isPaperDocument(svc: ServiceClient, doc: Pick<Tables<"invoice_documents">, "source" | "storage_path">): Promise<boolean> {
  if (!PAPER_SOURCES.has(doc.source)) return false;
  if (IMAGE_EXT.test(doc.storage_path)) return true;
  if (!/\.pdf$/i.test(doc.storage_path)) return false;
  try {
    const bytes = await downloadInvoiceBytes(svc, doc.storage_path);
    const t = await pdfTextLength(bytes);
    return t.pages > 0 && t.textChars < SCAN_TEXT_CHARS_PER_PAGE * t.pages;
  } catch {
    return false;
  }
}

const digitsOf = (s: string | null | undefined) => (s ?? "").replace(/\D+/g, "");
function sameInvoiceNumber(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  if (a.trim().toLowerCase() === b.trim().toLowerCase()) return true;
  const x = digitsOf(a);
  const y = digitsOf(b);
  return x.length >= 4 && y.length >= 4 && (x === y || x.endsWith(y) || y.endsWith(x));
}

export type CleanCopyRead = { lines: DiffLine[]; subtotal: string | null; how: "spreadsheet" | "llm" };

/**
 * Read the lines off the clean copy WITHOUT touching invoice_documents /
 * invoice_lines: spreadsheets through the deterministic sheet reader, PDFs and
 * images through the same LLM extraction the parse job uses (calls logged to
 * llm_calls against the existing document). Null when it cannot be read.
 */
export async function readCleanCopyLines(
  svc: ServiceClient,
  ctx: { tenantId: string; documentId: string; vendorHint: string | null; invoiceNumber: string | null },
  file: { bytes: Uint8Array; mimeType: string; filename: string },
  log: Logger,
): Promise<{ read: CleanCopyRead | null; note: string | null }> {
  const mime = normalizeMime(file.mimeType, file.filename);
  if (isSpreadsheet(mime, file.filename)) {
    const sheets = readSpreadsheet(file.bytes, mime, file.filename);
    for (const s of sheets) {
      const headerIdx = detectHeaderRow(s.rows);
      if (headerIdx < 0) continue;
      const header = s.rows[headerIdx];
      const known = matchKnownLayout(header);
      const map = known?.map ?? inferColumnMap(header).map;
      if (!columnMapIsUsable(map)) continue;
      const { lines } = extractLines(s.rows, headerIdx, map, { footer: known?.footer, meta: known?.meta?.(s.rows, headerIdx) });
      if (!lines.length) continue;
      const groups = groupByInvoice(lines);
      const group = groups.find((g) => sameInvoiceNumber(g.invoice_number, ctx.invoiceNumber)) ?? groups[0];
      const meta = known?.meta?.(s.rows, headerIdx);
      return { read: { lines: group.lines.map(diffLineFromSheet), subtotal: meta?.subtotal ?? null, how: "spreadsheet" }, note: null };
    }
    return { read: null, note: "clean copy: no invoice rows found in the spreadsheet" };
  }

  if (!isLlmConfigured()) return { read: null, note: "clean copy not re-read: LLM API key not configured" };
  const provider = selectedProviderName();
  try {
    const result = await extractInvoiceFromFile({ bytes: file.bytes, mimeType: mime, filename: file.filename, vendorHint: ctx.vendorHint }, { log });
    for (const a of result.attempts) {
      await logLlmCall(svc, { tenant_id: ctx.tenantId, kind: "invoice-parse", ref_id: ctx.documentId, model: a.call.model, provider: a.call.provider, usage: a.call.usage, raw: a.call.raw });
    }
    const real = result.documents.filter((d) => !isRejectedDocument(d));
    const doc: InvoiceParsedDocument | undefined =
      real.find((d) => sameInvoiceNumber(d.invoice_number, ctx.invoiceNumber) || sameInvoiceNumber(d.receipt_id, ctx.invoiceNumber)) ?? real[0];
    if (!doc) return { read: null, note: "clean copy: parser found no invoice on the file" };
    const isCredit = doc.document_kind === "credit";
    return { read: { lines: doc.lines.map((l, i) => diffLineFromParsed(l, i, isCredit)), subtotal: doc.subtotal == null ? null : new Decimal(doc.subtotal).toFixed(2), how: "llm" }, note: null };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logLlmCall(svc, { tenant_id: ctx.tenantId, kind: "invoice-parse", ref_id: ctx.documentId, model: modelFor(provider, "invoice-parse"), provider, error: msg });
    return { read: null, note: `clean copy re-read failed: ${msg}` };
  }
}

export type AttachInput = {
  locationId: string;
  vendorId?: string | null;
  vendorName?: string | null;
  invoiceNumber: string;
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  log?: Logger;
};

export type AttachOutcome = "duplicate" | "stored" | "verified" | "needs_review";

export type AttachResult =
  | { attached: false; reason: string; vendorId: string | null }
  | { attached: true; documentId: string; vendorId: string; outcome: AttachOutcome; cleanStoragePath: string | null; diff: ParseDiff | null; note: string | null };

/**
 * Attach a portal copy to the document that already carries the same
 * (vendor_id, invoice_number) at this location. See the decision table above.
 * Returns attached:false when there is nothing to attach to (caller then runs
 * the normal intake).
 */
export async function attachCleanCopy(svc: ServiceClient, input: AttachInput): Promise<AttachResult> {
  const log = input.log ?? (() => {});
  const invoiceNumber = input.invoiceNumber.trim();
  if (!invoiceNumber) return { attached: false, reason: "no invoice number", vendorId: input.vendorId ?? null };
  const location = await getLocation(svc, input.locationId);

  let vendorId = input.vendorId ?? null;
  let vendorName = input.vendorName ?? null;
  if (!vendorId && vendorName) {
    const v = await findVendorByName(svc, location.tenant_id, vendorName);
    if (v) {
      vendorId = v.id;
      vendorName = v.name;
    }
  }
  if (!vendorId) return { attached: false, reason: "vendor unknown", vendorId: null };
  if (!vendorName) {
    const { data: v } = await svc.from("vendors").select("name").eq("id", vendorId).maybeSingle();
    vendorName = v?.name ?? null;
  }

  // Candidates: exact number first, then a case-insensitive match; prefer a live document over a rejected one.
  const { data: exact, error } = await svc
    .from("invoice_documents")
    .select("id, source, status, storage_path, content_hash, clean_storage_path, invoice_number, invoice_date")
    .eq("location_id", input.locationId)
    .eq("vendor_id", vendorId)
    .eq("invoice_number", invoiceNumber)
    .order("created_at")
    .limit(10);
  if (error) throw new Error(`attach lookup: ${error.message}`);
  let candidates = exact ?? [];
  if (candidates.length === 0) {
    const { data: loose } = await svc
      .from("invoice_documents")
      .select("id, source, status, storage_path, content_hash, clean_storage_path, invoice_number, invoice_date")
      .eq("location_id", input.locationId)
      .eq("vendor_id", vendorId)
      .ilike("invoice_number", invoiceNumber.replace(/[%_\\]/g, (c) => `\\${c}`))
      .order("created_at")
      .limit(10);
    candidates = loose ?? [];
  }
  const existing = candidates.find((c) => c.status !== "rejected") ?? candidates[0];
  if (!existing) return { attached: false, reason: "no document with this invoice number", vendorId };

  const hash = sha256(input.bytes);
  if (existing.content_hash === hash || (existing.clean_storage_path ?? "").includes(hash)) {
    log("portal-attach: identical bytes already on the document", { documentId: existing.id, invoiceNumber });
    return { attached: true, documentId: existing.id, vendorId, outcome: "duplicate", cleanStoragePath: existing.clean_storage_path, diff: null, note: null };
  }
  const { data: anywhere } = await svc.from("invoice_documents").select("id").eq("location_id", input.locationId).eq("content_hash", hash).maybeSingle();
  if (anywhere) {
    log("portal-attach: identical bytes already stored on another document", { documentId: existing.id, other: anywhere.id });
    return { attached: true, documentId: existing.id, vendorId, outcome: "duplicate", cleanStoragePath: existing.clean_storage_path, diff: null, note: `same file already stored as document ${anywhere.id}` };
  }

  // Store the clean copy next to the paper one (same path convention, its own hash).
  const mime = normalizeMime(input.mimeType, input.filename);
  const cleanPath = invoiceStoragePath(input.locationId, new Date(), hash, extForMime(mime, input.filename));
  await ensureInvoicesBucket(svc);
  const { error: uerr } = await svc.storage.from(INVOICES_BUCKET).upload(cleanPath, input.bytes, { contentType: mime, upsert: false });
  if (uerr && !/already exists|duplicate/i.test(uerr.message)) throw new Error(`storage upload ${cleanPath}: ${uerr.message}`);
  if (mime === "application/pdf") {
    try {
      await ensurePdfPreview(svc, cleanPath, input.bytes);
    } catch (e) {
      console.warn(JSON.stringify({ msg: "pdf-preview: skipped", storagePath: cleanPath, error: e instanceof Error ? e.message : String(e) }));
    }
  }
  const { error: perr } = await svc.from("invoice_documents").update({ clean_storage_path: cleanPath }).eq("id", existing.id);
  if (perr) throw new Error(`set clean_storage_path: ${perr.message}`);

  const paper = existing.status !== "rejected" && (await isPaperDocument(svc, existing));
  if (!paper) {
    log("portal-attach: clean copy stored", { documentId: existing.id, source: existing.source, cleanPath });
    return { attached: true, documentId: existing.id, vendorId, outcome: "stored", cleanStoragePath: cleanPath, diff: null, note: null };
  }

  // Paper document: re-read from the clean copy and compare with what was posted.
  const { read, note } = await readCleanCopyLines(svc, { tenantId: location.tenant_id, documentId: existing.id, vendorHint: vendorName, invoiceNumber }, { bytes: input.bytes, mimeType: mime, filename: input.filename }, log);
  if (!read) {
    log("portal-attach: clean copy stored but not compared", { documentId: existing.id, note });
    return { attached: true, documentId: existing.id, vendorId, outcome: "stored", cleanStoragePath: cleanPath, diff: null, note };
  }
  const { data: posted, error: lerr } = await svc.from("invoice_lines").select("line_no, vendor_sku, description, quantity, unit_price, extended_price").eq("invoice_id", existing.id).order("line_no");
  if (lerr) throw new Error(`read invoice_lines: ${lerr.message}`);
  const diff = diffParsedLines((posted ?? []).map(diffLineFromInvoiceLine), read.lines);

  if (diff.matches) {
    const { error: verr } = await svc.from("invoice_documents").update({ verified_by_clean_copy_at: new Date().toISOString(), parse_diff: null }).eq("id", existing.id);
    if (verr) throw new Error(`mark verified: ${verr.message}`);
    log("portal-attach: verified by clean copy", { documentId: existing.id, lines: diff.paper.line_count, sum: diff.paper.sum, how: read.how });
    return { attached: true, documentId: existing.id, vendorId, outcome: "verified", cleanStoragePath: cleanPath, diff, note: null };
  }
  const { error: derr } = await svc
    .from("invoice_documents")
    .update({ status: "needs_review", parse_diff: diff as unknown as Json, verified_by_clean_copy_at: null })
    .eq("id", existing.id);
  if (derr) throw new Error(`set parse_diff: ${derr.message}`);
  log("portal-attach: paper and portal disagree", { documentId: existing.id, paper: diff.paper.line_count, portal: diff.portal.line_count, sum_delta: diff.sum_delta, diffs: diff.diffs.length });
  return { attached: true, documentId: existing.id, vendorId, outcome: "needs_review", cleanStoragePath: cleanPath, diff, note: null };
}

export type ApiIntakeInput = {
  locationId: string;
  bytes: Uint8Array;
  mimeType: string;
  filename: string;
  /** `x-vendor` header: the portal the file came from */
  vendorName?: string | null;
  /** `x-invoice-number` header, as printed on the portal */
  invoiceNumber?: string | null;
  log?: Logger;
};

export type ApiIntakeResult = PipelineResult & {
  documentId: string;
  duplicate: boolean;
  attached: boolean;
  outcome: "created" | AttachOutcome;
  eventId: string | null;
};

/**
 * Intake for source 'api' (vendor-portal pull). Tries attachCleanCopy when
 * the caller names the vendor and invoice number; otherwise (or when nothing
 * matches) it is a normal createInvoiceDocument + runInvoicePipeline. Every
 * arrival — including failures — lands in inbound_events as provider 'portal'.
 */
export async function createApiDocument(svc: ServiceClient, input: ApiIntakeInput): Promise<ApiIntakeResult> {
  const log = input.log ?? (() => {});
  const vendorName = input.vendorName?.trim() || null;
  const invoiceNumber = input.invoiceNumber?.trim() || null;

  const record = async (r: { documentId: string | null; created: boolean; error: string | null }) => {
    const { data: ev } = await svc
      .from("inbound_events")
      .insert({
        location_id: input.locationId,
        provider: "portal",
        event_type: "portal.pull",
        from_address: vendorName,
        subject: input.filename,
        to_addresses: [],
        attachment_count: 1,
        documents_created: r.created ? 1 : 0,
        document_ids: r.documentId ? [r.documentId] : [],
        error: r.error,
      })
      .select("id")
      .single();
    return ev?.id ?? null;
  };

  try {
    if (vendorName && invoiceNumber) {
      const attached = await attachCleanCopy(svc, { locationId: input.locationId, vendorName, invoiceNumber, bytes: input.bytes, mimeType: input.mimeType, filename: input.filename, log });
      if (attached.attached) {
        const { data: d } = await svc.from("invoice_documents").select("status").eq("id", attached.documentId).single();
        const { data: ls } = await svc.from("invoice_lines").select("status").eq("invoice_id", attached.documentId);
        const lines = ls ?? [];
        const eventId = await record({ documentId: attached.documentId, created: false, error: attached.note });
        return {
          documentId: attached.documentId,
          status: d?.status ?? "needs_review",
          duplicate: attached.outcome === "duplicate",
          attached: true,
          outcome: attached.outcome,
          lines: lines.length,
          mapped: lines.filter((l) => l.status === "auto_mapped" || l.status === "confirmed").length,
          unmapped: lines.filter((l) => l.status === "unmapped").length,
          eventId,
        };
      }
      log("portal-intake: nothing to attach to, normal intake", { vendorName, invoiceNumber, reason: attached.reason });
    }

    const location = await getLocation(svc, input.locationId);
    const vendor = vendorName ? await findVendorByName(svc, location.tenant_id, vendorName) : null;
    const created = await createInvoiceDocument(svc, { locationId: input.locationId, source: "api", bytes: input.bytes, mimeType: input.mimeType, filename: input.filename, vendorId: vendor?.id ?? null });
    const result = await runInvoicePipeline(svc, created.documentId, { log });
    const eventId = await record({ documentId: created.documentId, created: !created.duplicate, error: null });
    return { ...result, documentId: created.documentId, duplicate: created.duplicate, attached: false, outcome: created.duplicate ? "duplicate" : "created", eventId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await record({ documentId: null, created: false, error: msg });
    throw e;
  }
}
