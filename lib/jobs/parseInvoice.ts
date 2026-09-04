import Decimal from "decimal.js";
import type { ServiceClient } from "@/lib/db/service";
import type { Database, Json } from "@/lib/db/types";
import { logLlmCall } from "@/lib/llm/anthropic";
import { isLlmConfigured, selectedProviderName } from "@/lib/llm/provider";
import { modelFor } from "@/lib/llm/models";
import { HEIC_NOT_SUPPORTED, normalizeMime, parseInvoiceDocument, UnsupportedInvoiceMediaError, type InvoiceParse } from "@/lib/llm/invoice-parse";
import { downloadInvoiceBytes } from "@/lib/storage";
import { emailDomain, findOrCreateVendor, getLocation, type Logger } from "./intake";

/**
 * Parse job (architecture.md §4.3). Downloads the stored file, runs the Sonnet
 * extraction, upserts the vendor, rewrites invoice_lines for the document
 * (delete + insert, so re-parsing is idempotent), negates credit quantities,
 * checks Σ extended vs subtotal (±2%, noted in parse_error but not fatal), and
 * moves the document to needs_review (map/post decide the rest) or rejected.
 *
 * Without the selected provider's API key the document stays 'received' with parse_error set.
 */
export type ParseJobResult = { status: Database["public"]["Enums"]["invoice_status"]; lines: number; error: string | null };

const SUBTOTAL_TOLERANCE = 0.02;

export function checkSubtotal(parsed: InvoiceParse): string | null {
  if (parsed.subtotal == null || parsed.subtotal <= 0) return null;
  const sum = parsed.lines
    .filter((l) => !["tax", "fee", "deposit"].includes(l.category_guess.toLowerCase()))
    .reduce((a, l) => a.plus(l.extended_price ?? 0), new Decimal(0));
  const subtotal = new Decimal(parsed.subtotal);
  const diff = sum.minus(subtotal).abs().div(subtotal);
  if (diff.lte(SUBTOTAL_TOLERANCE)) return null;
  const fmt = (d: Decimal) => d.toNumber().toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `line total ${fmt(sum)} vs subtotal ${fmt(subtotal)}`;
}

export async function parseInvoiceDocumentJob(svc: ServiceClient, documentId: string, opts: { log?: Logger } = {}): Promise<ParseJobResult> {
  const log = opts.log ?? (() => {});
  const { data: doc, error } = await svc.from("invoice_documents").select("*").eq("id", documentId).maybeSingle();
  if (error) throw new Error(`read invoice_documents: ${error.message}`);
  if (!doc) throw new Error(`document ${documentId} not found`);
  const location = await getLocation(svc, doc.location_id);

  if (!isLlmConfigured()) {
    const msg = `${selectedProviderName() === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"} not configured`;
    await svc.from("invoice_documents").update({ status: "received", parse_error: msg }).eq("id", documentId);
    log("invoice-parse: skipped", { documentId, reason: msg });
    return { status: "received", lines: 0, error: msg };
  }

  const filename = doc.storage_path.split("/").pop() ?? doc.storage_path;
  const mime = normalizeMime("", filename);
  if (mime === "image/heic" || mime === "image/heif") {
    await svc.from("invoice_documents").update({ status: "needs_review", parse_error: HEIC_NOT_SUPPORTED }).eq("id", documentId);
    return { status: "needs_review", lines: 0, error: HEIC_NOT_SUPPORTED };
  }

  let vendorHint: string | null = null;
  if (doc.vendor_id) {
    const { data: v } = await svc.from("vendors").select("name").eq("id", doc.vendor_id).maybeSingle();
    vendorHint = v?.name ?? null;
  }

  await svc.from("invoice_documents").update({ status: "parsing", parse_error: null }).eq("id", documentId);

  let parsed: InvoiceParse;
  let raw: unknown = null;
  try {
    const bytes = await downloadInvoiceBytes(svc, doc.storage_path);
    const input =
      mime === "text/plain" ? { text: Buffer.from(bytes).toString("utf8"), mimeType: mime, filename, vendorHint } : { bytes, mimeType: mime, filename, vendorHint };
    const result = await parseInvoiceDocument(input);
    parsed = result.data;
    raw = result.raw;
    await logLlmCall(svc, { tenant_id: location.tenant_id, kind: "invoice-parse", ref_id: documentId, model: result.model, provider: result.provider, usage: result.usage, raw: result.raw });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await logLlmCall(svc, { tenant_id: location.tenant_id, kind: "invoice-parse", ref_id: documentId, model: modelFor(selectedProviderName(), "invoice-parse"), provider: selectedProviderName(), raw, error: msg });
    const unsupported = e instanceof UnsupportedInvoiceMediaError;
    await svc.from("invoice_documents").update({ status: "needs_review", parse_error: unsupported ? msg : `parse failed: ${msg}` }).eq("id", documentId);
    log("invoice-parse: error", { documentId, error: msg });
    return { status: "needs_review", lines: 0, error: msg };
  }

  const confidence = Number(Math.min(1, Math.max(0, parsed.overall_confidence)).toFixed(2));
  const base = {
    raw_extraction: parsed as unknown as Json,
    parse_confidence: confidence,
    invoice_number: parsed.invoice_number ?? null,
    invoice_date: parsed.invoice_date ?? null,
    received_date: parsed.received_date ?? parsed.invoice_date ?? null,
    subtotal: parsed.subtotal ?? null,
    tax: parsed.tax ?? null,
    total: parsed.total ?? null,
  };

  if (!parsed.is_invoice || parsed.document_kind === "statement" || parsed.document_kind === "other") {
    const reason = !parsed.is_invoice ? "not an invoice" : `document is a ${parsed.document_kind}`;
    await svc.from("invoice_documents").update({ ...base, status: "rejected", parse_error: reason }).eq("id", documentId);
    log("invoice-parse: rejected", { documentId, reason, vendor: parsed.vendor_name });
    return { status: "rejected", lines: 0, error: reason };
  }

  const vendor = await findOrCreateVendor(svc, location.tenant_id, parsed.vendor_name || vendorHint || "Unknown vendor", emailDomain(doc.email_from));
  const isCredit = parsed.document_kind === "credit";
  const sign = isCredit ? -1 : 1;

  const { error: delErr } = await svc.from("invoice_lines").delete().eq("invoice_id", documentId);
  if (delErr) throw new Error(`delete invoice_lines: ${delErr.message}`);

  const seen = new Set<number>();
  const rows: Database["public"]["Tables"]["invoice_lines"]["Insert"][] = parsed.lines.map((l, i) => {
    let lineNo = Number.isInteger(l.line_no) && l.line_no > 0 && !seen.has(l.line_no) ? l.line_no : i + 1;
    while (seen.has(lineNo)) lineNo += 1;
    seen.add(lineNo);
    return {
      invoice_id: documentId,
      line_no: lineNo,
      vendor_sku: l.vendor_sku?.trim() || null,
      description: l.description.trim() || "(no description)",
      pack_size_text: l.pack_size_text?.trim() || null,
      quantity: Number(new Decimal(Math.abs(l.quantity)).times(sign).toFixed(4)),
      unit_price: l.unit_price == null ? null : Number(new Decimal(Math.abs(l.unit_price)).toFixed(4)),
      extended_price: l.extended_price == null ? null : Number(new Decimal(l.extended_price).abs().times(sign).toFixed(2)),
      ai_category_guess: l.category_guess || null,
      ai_confidence: Number(Math.min(1, Math.max(0, l.confidence)).toFixed(2)),
      status: "unmapped",
    };
  });
  if (rows.length) {
    const { error: insErr } = await svc.from("invoice_lines").insert(rows);
    if (insErr) throw new Error(`insert invoice_lines: ${insErr.message}`);
  }

  const note = checkSubtotal(parsed);
  const { error: uerr } = await svc
    .from("invoice_documents")
    .update({ ...base, vendor_id: vendor.id, status: "needs_review", parse_error: note })
    .eq("id", documentId);
  if (uerr) throw new Error(`update invoice_documents: ${uerr.message}`);
  log("invoice-parse: done", { documentId, vendor: vendor.name, kind: parsed.document_kind, lines: rows.length, confidence, note });
  return { status: "needs_review", lines: rows.length, error: note };
}
