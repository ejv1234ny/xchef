import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { MODELS, runTool, type ToolCallResult } from "./anthropic";

/**
 * Invoice parsing (architecture.md §4.3 "Parse job"). One forced tool call to
 * Sonnet with the document as a PDF / image / text block. The zod schema below
 * IS the contract: the parse job stores `raw` in invoice_documents.raw_extraction
 * and writes `lines` to invoice_lines.
 */

export const InvoiceLineSchema = z.object({
  line_no: z.number().int().min(1),
  vendor_sku: z.string().nullable().optional(),
  description: z.string().min(1),
  pack_size_text: z.string().nullable().optional(),
  quantity: z.number(),
  unit_price: z.number().nullable().optional(),
  extended_price: z.number().nullable().optional(),
  category_guess: z.string(),
  confidence: z.number().min(0).max(1),
});

export const InvoiceParseSchema = z.object({
  is_invoice: z.boolean(),
  document_kind: z.enum(["invoice", "credit", "statement", "other"]),
  vendor_name: z.string(),
  invoice_number: z.string().nullable().optional(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  received_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  subtotal: z.number().nullable().optional(),
  tax: z.number().nullable().optional(),
  total: z.number().nullable().optional(),
  currency: z.string(),
  lines: z.array(InvoiceLineSchema),
  overall_confidence: z.number().min(0).max(1),
});

export type InvoiceParse = z.infer<typeof InvoiceParseSchema>;
export type InvoiceParseLine = z.infer<typeof InvoiceLineSchema>;

/** JSON Schema handed to the API as the tool's input_schema (mirrors InvoiceParseSchema). */
export const INVOICE_PARSE_TOOL_SCHEMA: Record<string, unknown> = {
  properties: {
    is_invoice: { type: "boolean", description: "true for an invoice, delivery ticket, receipt or credit memo with product lines" },
    document_kind: { type: "string", enum: ["invoice", "credit", "statement", "other"] },
    vendor_name: { type: "string", description: "vendor / distributor name as printed (not the restaurant)" },
    invoice_number: { type: ["string", "null"] },
    invoice_date: { type: ["string", "null"], description: "YYYY-MM-DD" },
    received_date: { type: ["string", "null"], description: "delivery date if printed and different from invoice_date, YYYY-MM-DD" },
    subtotal: { type: ["number", "null"] },
    tax: { type: ["number", "null"] },
    total: { type: ["number", "null"] },
    currency: { type: "string", description: "ISO code, usually USD" },
    lines: {
      type: "array",
      items: {
        type: "object",
        properties: {
          line_no: { type: "integer", minimum: 1 },
          vendor_sku: { type: ["string", "null"], description: "vendor item code verbatim" },
          description: { type: "string" },
          pack_size_text: { type: ["string", "null"], description: 'pack size verbatim, e.g. "6/#10", "3/114OZ", "12/750ML", "40 LB"' },
          quantity: { type: "number", description: "quantity shipped (not ordered); positive" },
          unit_price: { type: ["number", "null"] },
          extended_price: { type: ["number", "null"] },
          category_guess: {
            type: "string",
            description: "one of: produce, meat, seafood, dairy, dry, frozen, bakery, beverage, liquor, beer, wine, supplies, fee, deposit, tax, discount, other",
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["line_no", "description", "quantity", "category_guess", "confidence"],
      },
    },
    overall_confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["is_invoice", "document_kind", "vendor_name", "currency", "lines", "overall_confidence"],
};

export const INVOICE_PARSE_SYSTEM = `You extract structured data from US foodservice invoices for a restaurant's inventory system. Documents come from broadline distributors (Sysco, PFG / Performance Food Group, US Foods, Reinhart), cash-and-carry (Restaurant Depot, Costco), produce houses, meat and seafood purveyors, bakeries, and liquor / beer / wine distributors. They may be PDFs, phone photos of paper, or pasted text.

Rules:
- One output line per product line on the document, in the order printed. Do not merge or split lines. Do not invent lines.
- Keep the vendor's SKU / item code verbatim (digits and letters exactly as printed). null when the document has none.
- Keep pack size text verbatim as printed, e.g. "6/#10", "3/114OZ", "12/750ML", "4/1GAL", "40 LB", "2/5LB", "CS". Put it in pack_size_text, not in the description, when the document prints it separately; if only embedded in the description, copy it to pack_size_text as well.
- quantity is the quantity SHIPPED / delivered when both ordered and shipped columns exist. Quantities are positive numbers; keep decimals for weighed items (e.g. 13.21 lb sold by weight → quantity 13.21 with pack_size_text "LB", or quantity 1 with pack_size_text "13.21 LB @ $6.49/LB" — copy what is printed).
- unit_price and extended_price as printed; extended_price is the line total.
- Deposits, delivery fees, fuel surcharges, tax lines and discounts are lines too, with category_guess 'deposit', 'fee', 'tax' or 'discount'.
- Statements of account, aging reports, marketing flyers, order guides, price lists, and receipts with no readable product lines are NOT invoices: set is_invoice=false and document_kind 'statement' or 'other'.
- A credit memo / return: document_kind 'credit' with POSITIVE quantities (the system negates them).
- vendor_name is the seller, never the restaurant (the bill-to / ship-to party).
- Dates as YYYY-MM-DD. If the year is missing, infer from context; if unreadable, null.
- confidence per line reflects legibility; overall_confidence reflects the whole document.`;

export class UnsupportedInvoiceMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedInvoiceMediaError";
  }
}

export const HEIC_NOT_SUPPORTED = "HEIC not supported by parser; upload as JPEG";

type ImageMime = "image/jpeg" | "image/png" | "image/gif" | "image/webp";
const IMAGE_MIMES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

export function normalizeMime(mimeType: string, filename: string): string {
  const m = mimeType.toLowerCase().split(";")[0].trim();
  if (m === "image/jpg") return "image/jpeg";
  if (m && m !== "application/octet-stream") return m;
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  const byExt: Record<string, string> = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic",
    heif: "image/heif",
    txt: "text/plain",
    json: "application/json",
  };
  return byExt[ext] ?? m;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

/** Build the user content blocks for a document. Throws UnsupportedInvoiceMediaError for HEIC/HEIF or unknown binaries. */
export function buildInvoiceContent(input: { bytes?: Uint8Array; text?: string; mimeType: string; filename: string; vendorHint?: string | null }): Anthropic.MessageParam["content"] {
  const blocks: Anthropic.ContentBlockParam[] = [];
  const mime = normalizeMime(input.mimeType, input.filename);
  const hint = [`Filename: ${input.filename}`, input.vendorHint ? `Vendor hint (from the sender's email domain; verify against the document): ${input.vendorHint}` : null]
    .filter(Boolean)
    .join("\n");

  if (input.bytes && input.bytes.byteLength > 0 && mime !== "text/plain") {
    if (mime === "image/heic" || mime === "image/heif") throw new UnsupportedInvoiceMediaError(HEIC_NOT_SUPPORTED);
    if (mime === "application/pdf") {
      blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: toBase64(input.bytes) } });
    } else if (IMAGE_MIMES.has(mime)) {
      blocks.push({ type: "image", source: { type: "base64", media_type: mime as ImageMime, data: toBase64(input.bytes) } });
    } else {
      throw new UnsupportedInvoiceMediaError(`Unsupported document type ${mime}; upload a PDF, JPEG, PNG or WebP`);
    }
  } else {
    const text = input.text ?? (input.bytes ? Buffer.from(input.bytes).toString("utf8") : "");
    if (!text.trim()) throw new UnsupportedInvoiceMediaError("Empty document");
    blocks.push({ type: "text", text: `Invoice text (pasted or emailed as plain text):\n\n${text}` });
  }
  blocks.push({ type: "text", text: `${hint}\n\nExtract this document with the extract_invoice tool.` });
  return blocks;
}

/**
 * Parse one invoice document with Sonnet. The caller logs the call
 * (logLlmCall kind 'invoice-parse', ref_id = document id) including on error.
 */
export async function parseInvoiceDocument(input: {
  bytes?: Uint8Array;
  text?: string;
  mimeType: string;
  filename: string;
  vendorHint?: string | null;
}): Promise<ToolCallResult<InvoiceParse>> {
  const content = buildInvoiceContent(input);
  return runTool({
    model: MODELS.sonnet,
    system: INVOICE_PARSE_SYSTEM,
    content,
    toolName: "extract_invoice",
    toolDescription: "Structured extraction of a foodservice invoice, credit memo, receipt or delivery ticket.",
    inputSchema: INVOICE_PARSE_TOOL_SCHEMA,
    schema: InvoiceParseSchema,
    maxTokens: 16384,
  });
}
