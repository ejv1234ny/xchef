import Decimal from "decimal.js";
import type { ServiceClient } from "@/lib/db/service";
import type { Database, Tables } from "@/lib/db/types";
import { quoteLineToVendorQuote, type QuoteMappingRef } from "@/lib/core/quotes";
import type { Logger } from "./intake";
import type { LlmExtraction } from "./parseInvoice";

/**
 * Quote reply ingestion (KICKOFF-2 Part 3). A vendor's reply to a pricing
 * request is an invoice_documents row like any other intake (BLUEPRINT §6.6):
 * it is parsed by the invoice parser (document_kind 'quote') and mapped by the
 * same map step. This module does the two quote-specific things:
 *
 *  - markQuoteDocuments: flag freshly created documents as quotes and link
 *    them to their quote_requests row by the [Q-…] token (status 'replied');
 *  - ingestQuoteLines: after mapping, turn every auto_mapped | confirmed line
 *    into a vendor_quotes row (cost_per_base_unit = quoted price ÷ base units
 *    per pack from the mapping) and mark the document posted. Quotes never
 *    become purchases: purchases_by_item / item_price_history exclude
 *    document_kind = 'quote', so posting only means "done".
 *
 * Idempotent: re-running deletes and rewrites the document's vendor_quotes.
 */

export type QuoteRequestRow = Pick<Tables<"quote_requests">, "id" | "tenant_id" | "location_id" | "vendor_id" | "token" | "status" | "reply_document_id">;

export async function findQuoteRequestByToken(svc: ServiceClient, token: string): Promise<QuoteRequestRow | null> {
  const { data, error } = await svc.from("quote_requests").select("id, tenant_id, location_id, vendor_id, token, status, reply_document_id").eq("token", token).maybeSingle();
  if (error) throw new Error(`read quote_requests: ${error.message}`);
  return data ?? null;
}

/**
 * Flag documents as quotes and link the request. The request's vendor becomes
 * the document's vendor when intake could not tell (so the parser gets the
 * vendor hint and the map step has a vendor to map against).
 */
export async function markQuoteDocuments(svc: ServiceClient, documentIds: string[], token: string, log: Logger = () => {}): Promise<{ requestId: string | null; vendorId: string | null }> {
  if (documentIds.length === 0) return { requestId: null, vendorId: null };
  const { error } = await svc.from("invoice_documents").update({ document_kind: "quote" }).in("id", documentIds);
  if (error) throw new Error(`mark quote documents: ${error.message}`);
  const request = await findQuoteRequestByToken(svc, token);
  if (!request) {
    log("quote-ingest: token without a request (still treated as a quote)", { token, documentIds });
    return { requestId: null, vendorId: null };
  }
  await svc.from("invoice_documents").update({ vendor_id: request.vendor_id }).in("id", documentIds).is("vendor_id", null);
  const { error: rerr } = await svc
    .from("quote_requests")
    .update({ status: "replied", reply_document_id: request.reply_document_id ?? documentIds[0] })
    .eq("id", request.id);
  if (rerr) throw new Error(`update quote_requests: ${rerr.message}`);
  log("quote-ingest: reply linked", { token, requestId: request.id, documentIds });
  return { requestId: request.id, vendorId: request.vendor_id };
}

export type QuoteIngestResult = {
  documentId: string;
  status: Database["public"]["Enums"]["invoice_status"];
  /** vendor_quotes rows written */
  quotes: number;
  /** mapped lines with no usable pack (no cost per base unit) — still written, without a cost */
  withoutCost: number;
  /** lines not auto_mapped | confirmed (unmapped or ignored) */
  skippedLines: number;
  quoteRequestId: string | null;
};

type ParsedQuoteLine = { line_no: number; special_terms?: string | null; min_quantity?: number | null };

const num = (s: string | null, digits: number): number | null => (s == null ? null : Number(new Decimal(s).toFixed(digits)));

/**
 * Write vendor_quotes for one quote document from its mapped lines, then post
 * it when every line is resolved. Safe on posted documents (re-ingest after the
 * owner confirms more lines on the review screen).
 */
export async function ingestQuoteLines(svc: ServiceClient, documentId: string, opts: { log?: Logger } = {}): Promise<QuoteIngestResult> {
  const log = opts.log ?? (() => {});
  const { data: doc, error } = await svc.from("invoice_documents").select("id, location_id, vendor_id, status, document_kind, raw_extraction, created_at, posted_at").eq("id", documentId).maybeSingle();
  if (error) throw new Error(`read invoice_documents: ${error.message}`);
  if (!doc) throw new Error(`document ${documentId} not found`);

  const { data: request } = await svc.from("quote_requests").select("id").eq("reply_document_id", documentId).limit(1).maybeSingle();
  const quoteRequestId = request?.id ?? null;
  const base: QuoteIngestResult = { documentId, status: doc.status, quotes: 0, withoutCost: 0, skippedLines: 0, quoteRequestId };

  if (doc.status === "rejected") {
    log("quote-ingest: document rejected, nothing to ingest", { documentId });
    return base;
  }
  if (!doc.vendor_id) {
    log("quote-ingest: document has no vendor, nothing to ingest", { documentId });
    return base;
  }
  const { data: location, error: lerr } = await svc.from("locations").select("tenant_id").eq("id", doc.location_id).single();
  if (lerr) throw new Error(`read location: ${lerr.message}`);

  const { data: lineRows, error: linesErr } = await svc.from("invoice_lines").select("*").eq("invoice_id", documentId).order("line_no");
  if (linesErr) throw new Error(`read invoice_lines: ${linesErr.message}`);
  const lines = lineRows ?? [];

  // Validity dates and per-line specials live in the parser output kept on the document.
  const ex = (doc.raw_extraction ?? null) as Partial<LlmExtraction> | null;
  const parsedDoc = ex?.kind === "llm" ? ex.document : undefined;
  const dates = { valid_from: parsedDoc?.valid_from ?? null, valid_through: parsedDoc?.valid_through ?? null };
  const parsedByLineNo = new Map<number, ParsedQuoteLine>((parsedDoc?.lines ?? []).map((l) => [l.line_no, l]));

  const mappingIds = [...new Set(lines.map((l) => l.mapping_id).filter((id): id is string => Boolean(id)))];
  const mappings = new Map<string, QuoteMappingRef>();
  if (mappingIds.length) {
    const { data: ms, error: merr } = await svc.from("vendor_item_mappings").select("id, inventory_item_id, units_per_pack, base_units_per_unit, pack_description").in("id", mappingIds);
    if (merr) throw new Error(`read vendor_item_mappings: ${merr.message}`);
    for (const m of ms ?? []) mappings.set(m.id, m);
  }

  const rows: Database["public"]["Tables"]["vendor_quotes"]["Insert"][] = [];
  let skipped = 0;
  let withoutCost = 0;
  for (const line of lines) {
    if (line.status !== "auto_mapped" && line.status !== "confirmed") {
      skipped += 1;
      continue;
    }
    let mapping: QuoteMappingRef | null = line.mapping_id ? (mappings.get(line.mapping_id) ?? null) : null;
    if (!mapping && line.inventory_item_id && line.quantity_base_unit != null && Number(line.quantity) !== 0) {
      // Mapped without a saved mapping row: the map step still stored base units for this line; recover the pack from them.
      const perPack = new Decimal(line.quantity_base_unit).abs().div(new Decimal(line.quantity).abs());
      mapping = { id: "", inventory_item_id: line.inventory_item_id, units_per_pack: 1, base_units_per_unit: perPack.toFixed(4), pack_description: line.pack_size_text };
    }
    const parsed = parsedByLineNo.get(line.line_no);
    const v = quoteLineToVendorQuote(
      {
        vendor_sku: line.vendor_sku,
        description: line.description,
        pack_size_text: line.pack_size_text,
        unit_price: line.unit_price ?? line.extended_price,
        special_terms: parsed?.special_terms ?? null,
        min_quantity: parsed?.min_quantity ?? null,
      },
      mapping,
      dates,
    );
    if (v.cost_per_base_unit == null) withoutCost += 1;
    rows.push({
      tenant_id: location.tenant_id,
      vendor_id: doc.vendor_id,
      inventory_item_id: v.inventory_item_id ?? line.inventory_item_id,
      mapping_id: line.mapping_id ?? null,
      vendor_sku: v.vendor_sku,
      description: v.description,
      pack_description: v.pack_description,
      units_per_pack: num(v.units_per_pack, 4) ?? 1,
      base_units_per_unit: num(v.base_units_per_unit, 4),
      quoted_unit_price: num(v.quoted_unit_price, 4),
      cost_per_base_unit: num(v.cost_per_base_unit, 6),
      special_terms: v.special_terms,
      min_quantity: num(v.min_quantity, 4),
      valid_from: v.valid_from,
      valid_through: v.valid_through,
      source_document_id: documentId,
      quote_request_id: quoteRequestId,
      received_at: doc.created_at,
    });
  }

  // Idempotent rewrite of this document's quotes.
  const { error: delErr } = await svc.from("vendor_quotes").delete().eq("source_document_id", documentId);
  if (delErr) throw new Error(`delete vendor_quotes: ${delErr.message}`);
  if (rows.length) {
    const { error: insErr } = await svc.from("vendor_quotes").insert(rows);
    if (insErr) throw new Error(`insert vendor_quotes: ${insErr.message}`);
  }

  const allResolved = lines.length > 0 && lines.every((l) => l.status === "auto_mapped" || l.status === "confirmed" || l.status === "ignored");
  const post = allResolved && rows.length > 0;
  const update: Database["public"]["Tables"]["invoice_documents"]["Update"] = { document_kind: "quote" };
  if (post) {
    update.status = "posted";
    update.posted_at = doc.posted_at ?? new Date().toISOString();
  } else if (doc.status === "posted") {
    // Posted by the generic post step before any line mapped (e.g. all ignored): keep it visible for review.
    update.status = "needs_review";
  }
  const { error: uerr } = await svc.from("invoice_documents").update(update).eq("id", documentId);
  if (uerr) throw new Error(`update invoice_documents: ${uerr.message}`);

  const status = post ? "posted" : doc.status === "posted" ? "needs_review" : doc.status;
  log("quote-ingest: done", { documentId, quotes: rows.length, withoutCost, skippedLines: skipped, status, quoteRequestId });
  return { documentId, status, quotes: rows.length, withoutCost, skippedLines: skipped, quoteRequestId };
}

/**
 * Ingest a quote file: the document plus the sibling documents the parser
 * split from the same file (raw_extraction.sibling_document_ids).
 */
export async function ingestQuoteDocument(svc: ServiceClient, documentId: string, opts: { log?: Logger } = {}): Promise<QuoteIngestResult[]> {
  const { data: d } = await svc.from("invoice_documents").select("raw_extraction").eq("id", documentId).maybeSingle();
  const ex = d?.raw_extraction as { sibling_document_ids?: unknown } | null;
  const siblings = Array.isArray(ex?.sibling_document_ids) ? ex.sibling_document_ids.filter((s): s is string => typeof s === "string") : [];
  const out: QuoteIngestResult[] = [];
  for (const id of [documentId, ...siblings]) out.push(await ingestQuoteLines(svc, id, opts));
  return out;
}

/** Is this document a quote (flagged by intake or by the parser)? */
export async function isQuoteDocument(svc: ServiceClient, documentId: string): Promise<boolean> {
  const { data } = await svc.from("invoice_documents").select("document_kind").eq("id", documentId).maybeSingle();
  return data?.document_kind === "quote";
}

/**
 * For the prices page and `pnpm quotes:request --ingest <id>`: force the kind to
 * 'quote' (an upload-channel price list the parser may have called an invoice)
 * and ingest. Lines must already be mapped (runInvoicePipeline did that).
 */
export async function finalizeQuoteDocument(svc: ServiceClient, documentId: string, opts: { log?: Logger } = {}): Promise<QuoteIngestResult[]> {
  const { error } = await svc.from("invoice_documents").update({ document_kind: "quote" }).eq("id", documentId);
  if (error) throw new Error(`mark quote document: ${error.message}`);
  return ingestQuoteDocument(svc, documentId, opts);
}
