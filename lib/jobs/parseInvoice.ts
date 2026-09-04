import Decimal from "decimal.js";
import type { ServiceClient } from "@/lib/db/service";
import type { Database, Json } from "@/lib/db/types";
import { logLlmCall } from "@/lib/llm/anthropic";
import { isLlmConfigured, selectedProviderName } from "@/lib/llm/provider";
import { modelFor } from "@/lib/llm/models";
import { HEIC_NOT_SUPPORTED, normalizeMime, UnsupportedInvoiceMediaError, type DocumentValidation, type InvoiceParsedDocument } from "@/lib/llm/invoice-parse";
import { extractInvoiceFromFile, isRejectedDocument } from "@/lib/llm/invoice-extract";
import { downloadInvoiceBytes } from "@/lib/storage";
import { emailDomain, findOrCreateVendor, getLocation, type Logger } from "./intake";

/**
 * Parse job (architecture.md §4.3, CLAUDE.md rule 8). Downloads the stored
 * file, runs the structured extraction, and turns EVERY receipt/invoice found
 * on it into its own invoice_documents row (the first reuses this row, the
 * rest are siblings pointing at the same storage_path with the page region
 * noted in raw_extraction). Each document is validated (Σ extended_price ≈
 * subtotal ±2% AND line count == printed_item_count when printed); on failure
 * the model is asked once more with the discrepancy spelled out. Duplicates
 * are detected per receipt — unique (vendor_id, receipt_id), else
 * (vendor_id, invoice_date, invoice_time, total) — and deleted. Credits get
 * negative quantities; statements/other are rejected. map/post decide the rest.
 *
 * Without the selected provider's API key the document stays 'received' with parse_error set.
 */
export type ParseJobResult = {
  status: Database["public"]["Enums"]["invoice_status"] | "deleted";
  lines: number;
  documents: string[];
  duplicates: string[];
  error: string | null;
};

export type LlmExtraction = {
  kind: "llm";
  region: string | null;
  document_index: number;
  document_count: number;
  page_notes: string | null;
  document: InvoiceParsedDocument;
  validation: DocumentValidation;
  attempts: number;
  retry_hint: string | null;
  parent_document_id: string | null;
  sibling_document_ids: string[];
  duplicates_removed: string[];
};

const digits = (s: string | null | undefined) => (s ?? "").replace(/\D+/g, "");

/** Same printed receipt id, allowing for a barcode prefix cut off in one of the scans ("717-1155526" ~ "201717-1155526"). */
export function sameReceiptId(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = digits(a);
  const y = digits(b);
  if (x.length < 6 || y.length < 6) return false;
  return x === y || x.endsWith(y) || y.endsWith(x);
}

/**
 * An existing document for the same receipt (other than the ones being written
 * now): receipt id (exact or suffix match), else the same vendor + date + time + total.
 */
async function findExistingByReceipt(svc: ServiceClient, vendorId: string, doc: InvoiceParsedDocument, excludeIds: string[]): Promise<string | null> {
  if (doc.receipt_id) {
    const { data } = await svc.from("invoice_documents").select("id, receipt_id").eq("vendor_id", vendorId).not("receipt_id", "is", null).limit(500);
    const hit = (data ?? []).find((d) => !excludeIds.includes(d.id) && sameReceiptId(d.receipt_id, doc.receipt_id));
    if (hit) return hit.id;
  }
  if (doc.invoice_date && doc.invoice_time && doc.total != null) {
    const { data } = await svc
      .from("invoice_documents")
      .select("id")
      .eq("vendor_id", vendorId)
      .eq("invoice_date", doc.invoice_date)
      .eq("invoice_time", doc.invoice_time)
      .eq("total", doc.total)
      .limit(5);
    return (data ?? []).map((d) => d.id).find((id) => !excludeIds.includes(id)) ?? null;
  }
  return null;
}

function lineRows(documentId: string, doc: InvoiceParsedDocument, isCredit: boolean): Database["public"]["Tables"]["invoice_lines"]["Insert"][] {
  const sign = isCredit ? -1 : 1;
  const money2 = (v: number | null | undefined, signed: boolean) => (v == null ? null : Number(new Decimal(Math.abs(v)).times(signed ? sign : 1).toFixed(2)));
  return doc.lines.map((l, i) => ({
    invoice_id: documentId,
    line_no: i + 1,
    vendor_sku: l.vendor_sku?.trim() || null,
    description: l.description.trim() || "(no description)",
    pack_size_text: l.pack_size_text?.trim() || null,
    quantity: Number(new Decimal(Math.abs(l.quantity)).times(sign).toFixed(4)),
    unit_price: l.unit_price == null ? null : Number(new Decimal(Math.abs(l.unit_price)).toFixed(4)),
    gross_price: money2(l.gross_price ?? l.extended_price, true),
    adjustment: l.adjustment == null ? null : Number(new Decimal(l.adjustment).toFixed(2)),
    extended_price: l.extended_price == null ? null : Number(new Decimal(l.extended_price).abs().times(sign).toFixed(2)),
    ai_category_guess: l.category_guess || null,
    ai_confidence: Number(Math.min(1, Math.max(0, l.confidence)).toFixed(2)),
    status: "unmapped",
  }));
}

export async function parseInvoiceDocumentJob(svc: ServiceClient, documentId: string, opts: { log?: Logger } = {}): Promise<ParseJobResult> {
  const log = opts.log ?? (() => {});
  const { data: doc, error } = await svc.from("invoice_documents").select("*").eq("id", documentId).maybeSingle();
  if (error) throw new Error(`read invoice_documents: ${error.message}`);
  if (!doc) throw new Error(`document ${documentId} not found`);
  const location = await getLocation(svc, doc.location_id);
  const provider = selectedProviderName();
  const model = modelFor(provider, "invoice-parse");

  if (!isLlmConfigured()) {
    const msg = `${provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} not configured`;
    await svc.from("invoice_documents").update({ status: "received", parse_error: msg }).eq("id", documentId);
    log("invoice-parse: skipped", { documentId, reason: msg });
    return { status: "received", lines: 0, documents: [documentId], duplicates: [], error: msg };
  }

  const filename = doc.storage_path.split("/").pop() ?? doc.storage_path;
  const mime = normalizeMime("", filename);
  if (mime === "image/heic" || mime === "image/heif") {
    await svc.from("invoice_documents").update({ status: "needs_review", parse_error: HEIC_NOT_SUPPORTED }).eq("id", documentId);
    return { status: "needs_review", lines: 0, documents: [documentId], duplicates: [], error: HEIC_NOT_SUPPORTED };
  }

  let vendorHint: string | null = null;
  if (doc.vendor_id) {
    const { data: v } = await svc.from("vendors").select("name").eq("id", doc.vendor_id).maybeSingle();
    vendorHint = v?.name ?? null;
  }
  await svc.from("invoice_documents").update({ status: "parsing", parse_error: null }).eq("id", documentId);

  // ---- extraction (media prep + validation + one retry in lib/llm/invoice-extract.ts) ----
  let docs: InvoiceParsedDocument[] = [];
  let validations: DocumentValidation[] = [];
  let pageNotes: string | null = null;
  let attempts = 0;
  let retryHint: string | null = null;
  try {
    const bytes = await downloadInvoiceBytes(svc, doc.storage_path);
    const input = mime === "text/plain" ? { text: Buffer.from(bytes).toString("utf8"), mimeType: mime, filename, vendorHint } : { bytes, mimeType: mime, filename, vendorHint };
    let result;
    try {
      result = await extractInvoiceFromFile(input, { log });
    } finally {
      // log whatever calls happened, even when the last one threw
    }
    for (const a of result.attempts) {
      await logLlmCall(svc, { tenant_id: location.tenant_id, kind: "invoice-parse", ref_id: documentId, model: a.call.model, provider: a.call.provider, usage: a.call.usage, raw: a.call.raw });
    }
    docs = result.documents;
    validations = result.validations;
    pageNotes = result.page_notes;
    attempts = result.attempts.length;
    retryHint = result.retry_hint;
    log("invoice-parse: extracted", { documentId, documents: docs.length, attempts, media: result.media });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logLlmCall(svc, { tenant_id: location.tenant_id, kind: "invoice-parse", ref_id: documentId, model, provider, error: msg });
    const unsupported = e instanceof UnsupportedInvoiceMediaError;
    await svc.from("invoice_documents").update({ status: "needs_review", parse_error: unsupported ? msg : `parse failed: ${msg}` }).eq("id", documentId);
    log("invoice-parse: error", { documentId, error: msg });
    return { status: "needs_review", lines: 0, documents: [documentId], duplicates: [], error: msg };
  }

  // ---- which documents are real invoices ---------------------------------
  const keep = docs.map((d, i) => ({ d, v: validations[i], i })).filter(({ d }) => !isRejectedDocument(d));
  if (keep.length === 0) {
    const reason = docs.length ? [...new Set(docs.map((d) => isRejectedDocument(d) ?? "not an invoice"))].join("; ") : "no receipt or invoice found on the document";
    const first = docs[0];
    await svc
      .from("invoice_documents")
      .update({
        status: "rejected",
        parse_error: reason,
        raw_extraction: { kind: "llm", documents: docs, page_notes: pageNotes, attempts } as unknown as Json,
        parse_confidence: first ? Number(first.confidence.toFixed(2)) : null,
      })
      .eq("id", documentId);
    log("invoice-parse: rejected", { documentId, reason, vendor: first?.vendor_name });
    return { status: "rejected", lines: 0, documents: [documentId], duplicates: [], error: reason };
  }

  // ---- wipe this file's previous output (idempotent re-parse) -------------
  const { data: previous } = await svc.from("invoice_documents").select("id").eq("location_id", doc.location_id).like("content_hash", `${doc.content_hash}:%`);
  const fileDocIds = [documentId, ...(previous ?? []).map((p) => p.id)];
  const { error: delErr } = await svc.from("invoice_lines").delete().in("invoice_id", fileDocIds);
  if (delErr) throw new Error(`delete invoice_lines: ${delErr.message}`);

  const senderDomain = emailDomain(doc.email_from);
  const written: string[] = [];
  const duplicates: string[] = [];
  let totalLines = 0;
  let firstError: string | null = null;
  let primaryUsed = false;
  let siblingIdx = 0;

  for (const { d, v, i } of keep) {
    const vendor = await findOrCreateVendor(svc, location.tenant_id, d.vendor_name || vendorHint || "Unknown vendor", senderDomain);
    const existing = await findExistingByReceipt(svc, vendor.id, d, fileDocIds);
    if (existing) {
      duplicates.push(existing);
      log("invoice-parse: duplicate receipt, skipped", { documentId, region: d.region, receipt_id: d.receipt_id, existing });
      continue;
    }

    let targetId: string;
    if (!primaryUsed) {
      targetId = documentId;
      primaryUsed = true;
    } else {
      siblingIdx += 1;
      const hash = `${doc.content_hash}:r${siblingIdx}`;
      const { data: prior } = await svc.from("invoice_documents").select("id").eq("location_id", doc.location_id).eq("content_hash", hash).maybeSingle();
      if (prior) targetId = prior.id;
      else {
        const { data: created, error: ierr } = await svc
          .from("invoice_documents")
          .insert({ location_id: doc.location_id, vendor_id: vendor.id, source: doc.source, status: "parsing", storage_path: doc.storage_path, email_from: doc.email_from, email_subject: doc.email_subject, email_message_id: doc.email_message_id, content_hash: hash })
          .select("id")
          .single();
        if (ierr) throw new Error(`insert sibling invoice_documents: ${ierr.message}`);
        targetId = created.id;
      }
    }

    const isCredit = d.document_kind === "credit";
    const rows = lineRows(targetId, d, isCredit);
    if (rows.length) {
      const { error: insErr } = await svc.from("invoice_lines").insert(rows);
      if (insErr) throw new Error(`insert invoice_lines: ${insErr.message}`);
    }
    const extraction: LlmExtraction = {
      kind: "llm",
      region: d.region ?? null,
      document_index: i,
      document_count: docs.length,
      page_notes: pageNotes,
      document: d,
      validation: v,
      attempts,
      retry_hint: retryHint,
      parent_document_id: targetId === documentId ? null : documentId,
      sibling_document_ids: [],
      duplicates_removed: [],
    };
    const note = v.ok ? null : v.issues.join("; ");
    const { error: uerr } = await svc
      .from("invoice_documents")
      .update({
        vendor_id: vendor.id,
        status: "needs_review",
        receipt_id: d.receipt_id?.trim() || null,
        transaction_code: d.transaction_code?.trim() || null,
        invoice_number: d.invoice_number?.trim() || d.receipt_id?.trim() || null,
        invoice_date: d.invoice_date ?? null,
        invoice_time: d.invoice_time ?? null,
        received_date: d.received_date ?? d.invoice_date ?? null,
        subtotal: d.subtotal ?? null,
        tax: d.tax ?? null,
        total: d.total ?? null,
        printed_item_count: d.printed_item_count ?? null,
        parse_confidence: Number(Math.min(1, Math.max(0, d.confidence)).toFixed(2)),
        parse_error: note,
        raw_extraction: extraction as unknown as Json,
      })
      .eq("id", targetId);
    if (uerr) {
      if (/duplicate key|unique/i.test(uerr.message)) {
        // The same receipt was written by a concurrent parse (or twice on this page): treat as duplicate.
        duplicates.push(targetId);
        await svc.from("invoice_lines").delete().eq("invoice_id", targetId);
        if (targetId !== documentId) await svc.from("invoice_documents").delete().eq("id", targetId);
        else primaryUsed = false;
        log("invoice-parse: unique receipt violation, dropped", { targetId, receipt_id: d.receipt_id });
        continue;
      }
      throw new Error(`update invoice_documents: ${uerr.message}`);
    }
    written.push(targetId);
    totalLines += rows.length;
    firstError = firstError ?? note;
    log("invoice-parse: document", { documentId: targetId, region: d.region, vendor: vendor.name, receipt_id: d.receipt_id, date: d.invoice_date, lines: rows.length, printed: d.printed_item_count, sum: v.line_sum, subtotal: v.subtotal, ok: v.ok, attempts });
  }

  // Siblings from earlier runs that this run did not reproduce are gone.
  for (const stale of fileDocIds.filter((id) => id !== documentId && !written.includes(id))) {
    await svc.from("invoice_documents").delete().eq("id", stale);
  }

  if (!primaryUsed) {
    // Every receipt on this file already exists elsewhere: this document is a duplicate scan.
    await svc.from("invoice_documents").delete().eq("id", documentId);
    log("invoice-parse: document deleted as duplicate", { documentId, duplicates });
    return { status: "deleted", lines: 0, documents: [], duplicates, error: `duplicate of ${duplicates.join(", ")}` };
  }

  const siblings = written.filter((id) => id !== documentId);
  {
    const { data: primary } = await svc.from("invoice_documents").select("raw_extraction").eq("id", documentId).single();
    const ex = (primary?.raw_extraction ?? {}) as Record<string, unknown>;
    await svc.from("invoice_documents").update({ raw_extraction: { ...ex, sibling_document_ids: siblings, duplicates_removed: duplicates } as unknown as Json }).eq("id", documentId);
  }
  return { status: "needs_review", lines: totalLines, documents: written, duplicates, error: firstError };
}
