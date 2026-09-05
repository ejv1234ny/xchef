import { pdfTextLength, renderPdfImages } from "@/lib/pdf-preview";
import { getProvider, type LlmFile, type LlmProvider, type ToolCallResult } from "./provider";
import { normalizeParsedDocument, parseInvoiceDocument, validateParsedDocument, type DocumentValidation, type InvoiceParse, type InvoiceParsedDocument } from "./invoice-parse";

/**
 * File → validated documents. Shared by the parse job and the fixture tests so
 * both see exactly the same media and retry behaviour:
 *  - text PDFs go to the model as PDFs;
 *  - scanned PDFs (no text layer) go as rendered page images PLUS
 *    high-resolution crops (2 columns × 3 rows per page), because the API
 *    downsamples whole pages below receipt legibility;
 *  - images go as-is;
 *  - every document is normalized (stray discount lines folded into the item
 *    above) and validated (Σ extended ≈ subtotal ±2%, line count == printed
 *    item count); when any real document fails, the model is asked once more
 *    with the discrepancy spelled out, and the better attempt wins.
 */
export type ExtractAttempt = { call: ToolCallResult<InvoiceParse>; documents: InvoiceParsedDocument[]; validations: DocumentValidation[]; failing: number; inexact: number };

export type ExtractResult = {
  documents: InvoiceParsedDocument[];
  validations: DocumentValidation[];
  page_notes: string | null;
  attempts: ExtractAttempt[];
  retry_hint: string | null;
  media: { scan: boolean; pages: number; textChars: number; images: number };
};

/** attempts: 2 when a document fails validation outright; a 3rd only to chase a sum that is off by cents (a dropped discount). */
export const MAX_ATTEMPTS = 3;
const SCAN_TEXT_CHARS_PER_PAGE = 40;

export function isRejectedDocument(doc: InvoiceParsedDocument): string | null {
  // A vendor price quote is not a purchase, but it is kept: lib/jobs/quoteIngest.ts writes vendor_quotes from it.
  if (doc.document_kind === "quote") return null;
  if (!doc.is_invoice) return "not an invoice";
  if (doc.document_kind === "statement" || doc.document_kind === "other") return `document is a ${doc.document_kind}`;
  return null;
}

/** Ask once more, spelling out each failing document's discrepancy. */
export function buildRetryHint(docs: InvoiceParsedDocument[], validations: DocumentValidation[]): string {
  const parts: string[] = [];
  docs.forEach((d, i) => {
    const v = validations[i];
    if (v.exact || isRejectedDocument(d)) return;
    const issue = v.issues.length ? v.issues.join("; ") : `Σ extended_price ${v.line_sum} does not equal the printed subtotal ${v.subtotal} to the cent`;
    parts.push(
      `- document ${i + 1}${d.region ? ` (${d.region})` : ""}, ${d.vendor_name}${d.receipt_id ? ` receipt ${d.receipt_id}` : ""}: ${issue}. Lines you returned: ${d.lines.map((l) => `${l.description} qty ${l.quantity} ext ${l.extended_price ?? "?"}${l.adjustment ? ` (adj ${l.adjustment})` : ""}`).join(" | ")}. Check: discounts / "Offer disc." printed under an item reduce THAT item's extended_price (they are not lines); lines further down the receipt or after a fold may be missing; re-read the subtotal digits (8 vs 0, 3 vs 8 on thermal print).`,
    );
  });
  return parts.join("\n");
}

export async function prepareInvoiceMedia(bytes: Uint8Array, mimeType: string, log?: (msg: string, meta?: Record<string, unknown>) => void): Promise<{ scan: boolean; pages: number; textChars: number; images: LlmFile[] }> {
  if (mimeType !== "application/pdf") return { scan: false, pages: 0, textChars: 0, images: [] };
  const t = await pdfTextLength(bytes);
  const scan = t.pages > 0 && t.textChars < SCAN_TEXT_CHARS_PER_PAGE * t.pages;
  let images: LlmFile[] = [];
  if (scan) images = await renderPdfImages(bytes, { maxPages: 3, pageWidth: 1600, crops: { cols: 2, rows: 3, width: 1300 } });
  log?.("invoice-extract: media", { pages: t.pages, textChars: t.textChars, scan, images: images.length });
  return { scan, pages: t.pages, textChars: t.textChars, images };
}

export async function extractInvoiceFromFile(
  input: { bytes?: Uint8Array; text?: string; mimeType: string; filename: string; vendorHint?: string | null },
  opts: { provider?: LlmProvider; log?: (msg: string, meta?: Record<string, unknown>) => void; maxAttempts?: number } = {},
): Promise<ExtractResult> {
  const provider = opts.provider ?? getProvider();
  const log = opts.log ?? (() => {});
  const maxAttempts = opts.maxAttempts ?? MAX_ATTEMPTS;
  const media = input.bytes && input.mimeType !== "text/plain" ? await prepareInvoiceMedia(input.bytes, input.mimeType, log) : { scan: false, pages: 0, textChars: 0, images: [] as LlmFile[] };
  const base =
    input.mimeType === "text/plain" || input.text != null
      ? { text: input.text ?? (input.bytes ? Buffer.from(input.bytes).toString("utf8") : ""), mimeType: "text/plain", filename: input.filename, vendorHint: input.vendorHint }
      : media.scan && media.images.length
        ? { mimeType: input.mimeType, filename: input.filename, vendorHint: input.vendorHint, extraImages: media.images }
        : { bytes: input.bytes, mimeType: input.mimeType, filename: input.filename, vendorHint: input.vendorHint };

  const attempts: ExtractAttempt[] = [];
  let retryHint: string | null = null;
  let best: ExtractAttempt | null = null;
  for (let n = 1; n <= maxAttempts; n++) {
    const call = await parseInvoiceDocument({ ...base, retryHint: n > 1 ? retryHint : null }, provider);
    // Blank crops / margins sometimes come back as an empty "document": drop anything with no lines and no totals.
    const documents = call.data.documents.map(normalizeParsedDocument).filter((d) => d.lines.length > 0 || d.subtotal != null || d.total != null || !d.is_invoice);
    const validations = documents.map(validateParsedDocument);
    const real = documents.map((d, i) => ({ d, v: validations[i] })).filter(({ d }) => !isRejectedDocument(d));
    const failing = real.filter(({ v }) => !v.ok).length;
    const inexact = real.filter(({ v }) => !v.exact).length;
    const attempt = { call, documents, validations, failing, inexact };
    attempts.push(attempt);
    const better = !best || failing < best.failing || (failing === best.failing && inexact < best.inexact) || (failing === best.failing && inexact === best.inexact && documents.length >= best.documents.length);
    if (better) best = attempt;
    if (failing === 0 && inexact === 0) break;
    if (failing === 0 && n >= 2 && best !== null && best.inexact === inexact) break; // no progress on exactness; stop spending
    retryHint = buildRetryHint(documents, validations);
    log("invoice-extract: validation failed", { attempt: n, failing, hint: retryHint.slice(0, 400) });
  }
  const chosen = best!;
  return {
    documents: chosen.documents,
    validations: chosen.validations,
    page_notes: chosen.call.data.page_notes ?? null,
    attempts,
    retry_hint: retryHint,
    media: { scan: media.scan, pages: media.pages, textChars: media.textChars, images: media.images.length },
  };
}
