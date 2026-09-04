import { createHash, randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { ServiceClient } from "@/lib/db/service";
import type { Database, Json } from "@/lib/db/types";
import { ensureInvoicesBucket, extForMime, INVOICES_BUCKET, invoiceStoragePath, maxBytesFor } from "@/lib/storage";
import { isSpreadsheet } from "@/lib/core/sheets";
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
export async function findOrCreateVendor(svc: ServiceClient, tenantId: string, name: string, senderDomain?: string | null): Promise<{ id: string; name: string }> {
  const clean = name.replace(/\s+/g, " ").trim() || "Unknown vendor";
  const { data: vendors, error } = await svc.from("vendors").select("id, name, email_domains").eq("tenant_id", tenantId);
  if (error) throw new Error(`read vendors: ${error.message}`);
  const lower = clean.toLowerCase();
  let match = (vendors ?? []).find((v) => v.name.toLowerCase() === lower);
  if (!match && lower.length >= 3) {
    match = (vendors ?? []).find((v) => {
      const vn = v.name.toLowerCase();
      return vn.length >= 3 && (vn.includes(lower) || lower.includes(vn));
    });
  }
  if (!match && senderDomain) match = (vendors ?? []).find((v) => (v.email_domains ?? []).includes(senderDomain));
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
  const bytes = input.bytes && input.bytes.byteLength > 0 ? input.bytes : new Uint8Array(Buffer.from(text, "utf8"));
  if (bytes.byteLength === 0) throw new Error("empty document");
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
        if (parsed.status === "rejected" || parsed.status === "received") return counts();
      }
    } else if (spreadsheet) {
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
