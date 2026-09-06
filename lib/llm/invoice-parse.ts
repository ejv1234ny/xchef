import { z } from "zod";
import Decimal from "decimal.js";
import { getProvider, toToolCallResult, type LlmFile, type LlmProvider, type ToolCallResult } from "./provider";

/**
 * Invoice parsing (architecture.md §4.3 "Parse job"). One structured call per
 * stored file. A file (page, scan, photo) may hold SEVERAL receipts or
 * invoices, so the result is documents[]; the parse job writes one
 * invoice_documents row per entry, all pointing at the same storage_path.
 * The zod schema below IS the contract: raw output lands in
 * invoice_documents.raw_extraction and lines in invoice_lines.
 */

export const InvoiceLineSchema = z.object({
  line_no: z.number().int().min(1),
  vendor_sku: z.string().nullable().optional(),
  description: z.string().min(1),
  pack_size_text: z.string().nullable().optional(),
  quantity: z.number(),
  unit_price: z.number().nullable().optional(),
  /** line amount before any discount/promo/deposit/credit printed under it */
  gross_price: z.number().nullable().optional(),
  /** positive amount taken off this item by the following discount/promo/credit line(s); null when none */
  adjustment: z.number().nullable().optional(),
  /** what the item actually cost: gross_price − adjustment */
  extended_price: z.number().nullable().optional(),
  category_guess: z.string(),
  confidence: z.number().min(0).max(1),
  /** quotes only: specials / case-deal wording for this item ("buy 5 cases get 1 free", "case of 12 $480") */
  special_terms: z.string().nullable().optional(),
  /** quotes only: minimum order quantity (packs) the quoted price requires */
  min_quantity: z.number().nullable().optional(),
});

export const InvoiceDocumentSchema = z.object({
  is_invoice: z.boolean(),
  document_kind: z.enum(["invoice", "credit", "statement", "other", "quote"]),
  vendor_name: z.string(),
  /** the unique printed number: barcode / receipt number when present, else the invoice number */
  receipt_id: z.string().nullable().optional(),
  /** non-unique register / store / terminal codes (e.g. "2017-2017-1-176") — never used as a key */
  transaction_code: z.string().nullable().optional(),
  invoice_number: z.string().nullable().optional(),
  invoice_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  /** HH:MM (24h) when printed */
  invoice_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  received_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  /** quotes only: first day the quoted prices apply (YYYY-MM-DD) */
  valid_from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  /** quotes only: last day the quoted prices apply (YYYY-MM-DD) */
  valid_through: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  subtotal: z.number().nullable().optional(),
  tax: z.number().nullable().optional(),
  total: z.number().nullable().optional(),
  currency: z.string(),
  /** e.g. "Total Sales Quantity 15" / "ITEMS 57" — number of item lines the document says it has */
  printed_item_count: z.number().int().nullable().optional(),
  /** where on the page: "full", "left", "right", "top", "bottom", "page 2", … */
  region: z.string().nullable().optional(),
  lines: z.array(InvoiceLineSchema),
  confidence: z.number().min(0).max(1),
});

export const InvoiceParseSchema = z.object({
  documents: z.array(InvoiceDocumentSchema),
  page_notes: z.string().nullable().optional(),
});

export type InvoiceParse = z.infer<typeof InvoiceParseSchema>;
export type InvoiceParsedDocument = z.infer<typeof InvoiceDocumentSchema>;
export type InvoiceParseLine = z.infer<typeof InvoiceLineSchema>;

const LINE_TOOL_SCHEMA = {
  type: "object",
  properties: {
    line_no: { type: "integer", minimum: 1 },
    vendor_sku: { type: ["string", "null"], description: "vendor item code / UPC verbatim" },
    description: { type: "string" },
    pack_size_text: { type: ["string", "null"], description: 'pack size verbatim, e.g. "6/#10", "3/114OZ", "12/750ML", "40 LB", "750ML", "1.75L"' },
    quantity: { type: "number", description: "quantity shipped / bottles sold (not ordered); positive" },
    unit_price: { type: ["number", "null"] },
    gross_price: { type: ["number", "null"], description: "line amount before the discount/promo/deposit/credit printed under it" },
    adjustment: { type: ["number", "null"], description: "positive amount taken off this item by the following discount/promo/credit line(s); null when none" },
    extended_price: { type: ["number", "null"], description: "net line total = gross_price − adjustment" },
    category_guess: { type: "string", description: "one of: produce, meat, seafood, dairy, dry, frozen, bakery, beverage, liquor, beer, wine, supplies, fee, deposit, tax, other" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    special_terms: { type: ["string", "null"], description: 'quotes only: specials / case-deal wording for this item ("buy 5 get 1 free", "case of 12 $480"); null otherwise' },
    min_quantity: { type: ["number", "null"], description: "quotes only: minimum order quantity (packs) the quoted price requires; null otherwise" },
  },
  required: ["line_no", "description", "quantity", "category_guess", "confidence"],
};

/** JSON Schema handed to Claude as the tool's input_schema (mirrors InvoiceParseSchema). OpenAI derives a strict schema from zod. */
export const INVOICE_PARSE_TOOL_SCHEMA: Record<string, unknown> = {
  properties: {
    documents: {
      type: "array",
      description: "One entry per receipt / invoice / credit memo found on the page(s). Two receipts side by side are two entries.",
      items: {
        type: "object",
        properties: {
          is_invoice: { type: "boolean", description: "true for an invoice, receipt, delivery ticket or credit memo with product lines" },
          document_kind: { type: "string", enum: ["invoice", "credit", "statement", "other", "quote"], description: "quote = a price quote / price list / current-pricing reply from a vendor (nothing was purchased)" },
          vendor_name: { type: "string", description: "vendor / store / distributor name as printed (not the restaurant)" },
          receipt_id: { type: ["string", "null"], description: "the unique printed number: barcode number or receipt number when present, else the invoice number" },
          transaction_code: { type: ["string", "null"], description: "non-unique register / store / terminal codes printed on every receipt from that register" },
          invoice_number: { type: ["string", "null"], description: "printed invoice number (distributor invoices)" },
          invoice_date: { type: ["string", "null"], description: "YYYY-MM-DD" },
          invoice_time: { type: ["string", "null"], description: "HH:MM 24h when printed" },
          received_date: { type: ["string", "null"], description: "delivery date if printed and different, YYYY-MM-DD" },
          valid_from: { type: ["string", "null"], description: "quotes only: first day the prices apply, YYYY-MM-DD" },
          valid_through: { type: ["string", "null"], description: 'quotes only: last day the prices apply ("through 9/30", "good until", "expires"), YYYY-MM-DD' },
          subtotal: { type: ["number", "null"] },
          tax: { type: ["number", "null"] },
          total: { type: ["number", "null"] },
          currency: { type: "string" },
          printed_item_count: { type: ["integer", "null"], description: 'number of item lines the document says it has ("Total Sales Quantity 15", "ITEMS 57")' },
          region: { type: ["string", "null"], description: "where on the page: full, left, right, top, bottom, page N" },
          lines: { type: "array", items: LINE_TOOL_SCHEMA },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: ["is_invoice", "document_kind", "vendor_name", "currency", "lines", "confidence"],
      },
    },
    page_notes: { type: ["string", "null"] },
  },
  required: ["documents"],
};

export const INVOICE_PARSE_SYSTEM = `You extract structured data from US foodservice purchase documents for a restaurant's inventory system: broadline distributor invoices (Sysco, PFG / Performance Food Group, US Foods, Reinhart), cash-and-carry receipts (Restaurant Depot, Costco), produce / meat / seafood / bakery invoices, RETAIL LIQUOR STORE receipts (Vermont 802 Spirits, package stores) where the restaurant buys bottles over the counter, and PRICE QUOTES / price lists that vendor sales reps send in reply to a pricing request. Documents may be PDFs, scans, phone photos, or pasted / emailed text.

A single page can contain SEVERAL receipts or invoices (e.g. two register receipts scanned side by side, or two invoices stapled together). Return one entry in documents[] per receipt/invoice, in reading order (left before right, top before bottom), and say where it was in "region". Never merge two receipts into one.

Identity fields per document:
- receipt_id: the UNIQUE printed number for that document — the barcode number / receipt number / ticket number when present (retail receipts), otherwise the invoice number. Digits and dashes verbatim.
- transaction_code: register / store / terminal / clerk codes that repeat on every receipt from that register (e.g. "2017-2017-1-176"). These are NOT unique and must not go in receipt_id.
- invoice_date as YYYY-MM-DD and invoice_time as HH:MM (24h) when printed.
- printed_item_count: the document's own item/quantity count when printed ("Total Sales Quantity 15", "ITEMS 57", "NET PRODUCT QTY 10"); null when nothing is printed.

Lines:
- One output line per PRODUCT line, in the order printed. A product printed once with QTY 2 is ONE line with quantity 2. Do not merge or split product lines. Do not invent lines. Category / group header rows and their group subtotals (e.g. "2.5 GALLO 1-Ls JUICE DRI 3/3 253.17" above the products in that group), "DELIVERY RECAP" summaries, and totals rows are NOT lines — only the individual products underneath them are.
- Discount, promo, coupon, "Offer disc.", and credit lines printed directly under an item BELONG TO THAT ITEM (Vermont 802 Spirits receipts print "  Offer disc.  12.51 %" with the amount in parentheses, e.g. "($3.00)", on the line right under the discounted bottle — capture EVERY one of them as that bottle's adjustment): put the amount in that item's adjustment (positive number = reduction), set gross_price to the amount before it, and extended_price = gross_price − adjustment. Do NOT emit discounts, promos or credits as their own lines. Receipt-level discounts that are not under any item stay out of lines and are reflected only in subtotal/total.
- Deposits: a deposit printed under an item is a NEGATIVE adjustment on that item (it adds to the line). A separate deposits section ("DEPOSITS ON SALES", bottle/keg/CO2 deposits listed apart from products) becomes lines with category_guess 'deposit' — they are not products and are excluded when you check Σ extended_price against the products subtotal ("TOTAL PRODUCTS").
- Keep the vendor's SKU / item code / UPC verbatim; null when none.
- Keep pack size text verbatim ("6/#10", "3/114OZ", "12/750ML", "40 LB", "2/5LB", "CS"). On retail liquor receipts the size is usually inside the item name ("TITOS 1.75L", "BEEFEATER 750ML"): copy it to pack_size_text; when the receipt prints no size at all leave pack_size_text null (the system assumes 750 ml).
- quantity is the quantity SHIPPED / delivered when both ordered and shipped exist; for retail receipts it is the number of bottles/cans/packs. Positive numbers; keep decimals for weighed items (13.21 lb → quantity 13.21 with pack_size_text "LB").
- unit_price and extended_price as printed; extended_price is the net line total.
- Delivery fees, fuel surcharges and tax lines that are NOT attached to a specific item are lines with category_guess 'fee' or 'tax'.
- BEVERAGE DISTRIBUTOR delivery tickets (Coca-Cola Beverages Northeast, Pepsi): the SALES section is grouped under bold category headers such as "2.5 GALLO 1-Ls JUICE DRI 3/3 253.17", "2.5 GALLO 1-Ls SPARKLING 5/5 334.00", "20 POUND 1-Ls OTHER NON 1/1 80.00" — these headers carry a group count and a group subtotal and are NOT lines. The products are the small rows beneath each header: a product name ("2.5GBIB COKE", "2.5GBIB DT COKE", "2.5GBIB SPRITE", "2.5GBIB SEAG G ALE", "2.5GBIB MM LMNT NC", "20#CYL CO2 FULL #1"), a MAT# (material number, e.g. 103886), QTY, PRICE, EXTENDED, and a UPC printed on the next line. One output line per product row: description = the product name as printed followed by the group family in brackets when the name is abbreviated or hard to read ("2.5GBIB GP PRE-LMND T [TEA]" — the header says which family the product belongs to: JUICE DRI = juice / lemonade, SPARKLING = carbonated soda, TEA = iced tea), vendor_sku = the MAT#, pack_size_text = the box size read from the name ("2.5GBIB" → "2.5 GAL BIB", "5GBIB" → "5 GAL BIB"; a CO2 cylinder has none), quantity = QTY. A "2.5GBIB" is a 2.5-gallon bag-in-box of fountain syrup. The CO2 cylinder that appears both under OTHER NON (as a sale) and under DEPOSITS ON SALES is a product line the first time (category_guess 'supplies') and a 'deposit' line the second. Σ product lines = TOTAL PRODUCTS; NET PRODUCT QTY is the quantity sum. invoice_number = INV#, receipt_id = the barcode number (same as INV#), invoice_date = DEL DATE (MM/DD/YYYY — read the year carefully).
- Statements of account, aging reports, marketing flyers and order guides WITHOUT prices are NOT invoices: is_invoice=false and document_kind 'statement' or 'other'.
- PRICE QUOTES: a price quote, price list, bid sheet, "current pricing" or "this week's prices" reply from a vendor sales rep is document_kind 'quote' (is_invoice=false is fine — keep document_kind 'quote'). Nothing was purchased. One line per quoted product with: vendor_sku when given, description, pack_size_text verbatim ("6/#10", "12/750ML", "750ML", "case of 12"), unit_price = the quoted price PER PACK AS SOLD (per case when quoted by the case, per bottle when quoted by the bottle), quantity = 1, extended_price = unit_price, category_guess as usual. When one product is quoted two ways ("Tito's 750 $41.50/btl, case of 12 $480") emit ONE line with the per-unit price (unit_price 41.50, pack_size_text "750ML") and put the case deal in that line's special_terms ("case of 12 $480"); a stated minimum ("min 5 cases") goes in min_quantity as a number. Specials, promos, "deal", "closeout" and rebate wording go in special_terms. Validity: valid_from / valid_through as YYYY-MM-DD from "through 9/30", "good until", "valid", "expires", "prices for the week of" (take the year from the email / quote date, else the current year); null when nothing is stated. invoice_date = the date of the quote / email when known; subtotal, total and printed_item_count are null unless printed. Plain-text emails like "Tito's 750 $41.50/btl, case of 12 $480 through 9/30" are quotes: parse each product from the text. In an email reply, ignore the quoted original request (lines starting with ">" or below "On … wrote:", "From:", "-----Original Message-----"): extract only the vendor's own pricing, never the list of items that was asked about.
- A credit memo / return: document_kind 'credit' with POSITIVE quantities (the system negates them).
- vendor_name is the seller / store, never the restaurant (bill-to / ship-to party).
- Check your own totals: Σ extended_price of product lines should equal the printed subtotal (before tax), and the number of product lines should equal printed_item_count when the document prints one. If they disagree, re-read the document before answering.
- confidence per line reflects legibility; confidence per document reflects the whole document.`;

/**
 * Belt and braces after the model: any leftover discount/promo/credit line
 * (negative amount, or a discount/promo/coupon description with no SKU) is
 * folded into the preceding product line as an adjustment, and
 * extended_price is recomputed from gross − adjustment where both are known.
 */
export function normalizeParsedDocument(doc: InvoiceParsedDocument): InvoiceParsedDocument {
  const out: InvoiceParseLine[] = [];
  for (const raw of doc.lines) {
    const l = { ...raw };
    const negative = (l.extended_price ?? 0) < 0 || (l.gross_price ?? 0) < 0;
    const looksLikeAdjustment = /\b(discount|promo|coupon|markdown|price ?adj|credit|refund)\b/i.test(l.description) && !l.vendor_sku;
    const prev = out[out.length - 1];
    if (prev && (negative || looksLikeAdjustment) && !/deposit/i.test(l.description)) {
      const amount = new Decimal(Math.abs(l.extended_price ?? l.gross_price ?? 0));
      const gross = new Decimal(prev.gross_price ?? prev.extended_price ?? 0);
      prev.gross_price = Number(gross.toFixed(2));
      prev.adjustment = Number(new Decimal(prev.adjustment ?? 0).plus(amount).toFixed(2));
      prev.extended_price = Number(gross.minus(prev.adjustment).toFixed(2));
      continue;
    }
    if (l.gross_price != null && l.adjustment != null) l.extended_price = Number(new Decimal(l.gross_price).minus(l.adjustment).toFixed(2));
    else if (l.gross_price != null && l.extended_price == null) l.extended_price = l.gross_price;
    else if (l.gross_price == null && l.extended_price != null && (l.adjustment ?? 0) === 0) l.gross_price = l.extended_price;
    out.push(l);
  }
  return { ...doc, lines: out.map((l, i) => ({ ...l, line_no: i + 1 })) };
}

export type DocumentValidation = { ok: boolean; /** Σ lines equals the printed subtotal to the cent (when printed) */ exact: boolean; issues: string[]; line_sum: string; subtotal: string | null; line_count: number; printed_item_count: number | null };

const SUBTOTAL_TOLERANCE = 0.02;

/** Σ extended_price of product lines ≈ subtotal (±2%) AND line count == printed_item_count when printed. */
export function validateParsedDocument(doc: InvoiceParsedDocument): DocumentValidation {
  const products = doc.lines.filter((l) => !["tax", "fee", "deposit"].includes(l.category_guess.toLowerCase()));
  const sum = products.reduce((a, l) => a.plus(l.extended_price ?? 0), new Decimal(0));
  const issues: string[] = [];
  let exact = true;
  if (doc.subtotal != null && doc.subtotal > 0) {
    const subtotal = new Decimal(doc.subtotal);
    const diff = sum.minus(subtotal).abs();
    exact = diff.lt(0.005);
    if (diff.div(subtotal).gt(SUBTOTAL_TOLERANCE)) issues.push(`Σ extended_price ${sum.toFixed(2)} vs printed subtotal ${subtotal.toFixed(2)}`);
  }
  if (doc.printed_item_count != null && doc.printed_item_count > 0) {
    // Receipts print either a line count ("ITEMS 57") or a quantity sum ("Total Sales Quantity 15", "NET PRODUCT QTY 10"); accept either.
    const qty = products.reduce((a, l) => a.plus(Math.abs(l.quantity)), new Decimal(0));
    if (products.length !== doc.printed_item_count && !qty.eq(doc.printed_item_count)) {
      issues.push(`${products.length} product lines (quantity ${qty.toFixed(0)}) vs printed item count ${doc.printed_item_count}`);
    }
  }
  return { ok: issues.length === 0, exact: exact && issues.length === 0, issues, line_sum: sum.toFixed(2), subtotal: doc.subtotal == null ? null : new Decimal(doc.subtotal).toFixed(2), line_count: products.length, printed_item_count: doc.printed_item_count ?? null };
}

export class UnsupportedInvoiceMediaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedInvoiceMediaError";
  }
}

export const HEIC_NOT_SUPPORTED = "HEIC not supported by parser; upload as JPEG";

const IMAGE_MIMES: ReadonlySet<string> = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

/** Normalize a MIME type, falling back to the filename extension for octet-stream / empty types. */
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
    csv: "text/csv",
    tsv: "text/tab-separated-values",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
  };
  return byExt[ext] ?? m;
}

/** Provider-neutral prompt for a document: the user text plus the file (PDF/image) to attach. Throws UnsupportedInvoiceMediaError for HEIC/HEIF or unknown binaries. */
export function buildInvoiceInput(input: { bytes?: Uint8Array; text?: string; mimeType: string; filename: string; vendorHint?: string | null; extraImages?: LlmFile[] }): { user: string; files: LlmFile[] } {
  const mime = normalizeMime(input.mimeType, input.filename);
  const hint = [`Filename: ${input.filename}`, input.vendorHint ? `Vendor hint (from the sender's email domain; verify against the document): ${input.vendorHint}` : null]
    .filter(Boolean)
    .join("\n");
  const files: LlmFile[] = [];
  let body = "";
  if (input.bytes && input.bytes.byteLength > 0 && mime !== "text/plain") {
    if (mime === "image/heic" || mime === "image/heif") throw new UnsupportedInvoiceMediaError(HEIC_NOT_SUPPORTED);
    if (mime === "application/pdf" || IMAGE_MIMES.has(mime)) files.push({ bytes: input.bytes, mimeType: mime, name: input.filename });
    else throw new UnsupportedInvoiceMediaError(`Unsupported document type ${mime}; upload a PDF, JPEG, PNG or WebP`);
    body = "The invoice document is attached.";
  } else if (input.extraImages?.length) {
    body = "The document is a scan; its page renders are attached as images.";
  } else {
    const text = input.text ?? (input.bytes ? Buffer.from(input.bytes).toString("utf8") : "");
    if (!text.trim()) throw new UnsupportedInvoiceMediaError("Empty document");
    body = `Invoice text (pasted or emailed as plain text):\n\n${text}`;
  }
  const extras = input.extraImages ?? [];
  const extraNote = extras.length
    ? `\n\nAttached images: ${extras.map((f, i) => `image ${i + 1 + files.length} = ${f.name.replace(/\.[a-z]+$/i, "").replace(/-/g, " ")}`).join(", ")}. Whole-page images show layout (how many receipts, where); the crops are high-resolution views of parts of the same page — read every line from them. A crop can be blank or show only part of one receipt: never create a document for a blank region, and never split one receipt into two because it spans several crops.`
    : "";
  return { user: `${body}${extraNote}\n\n${hint}\n\nExtract every receipt or invoice on this document as extract_invoice (documents[] has one entry per receipt/invoice; a vendor price quote / price list is one entry with document_kind 'quote').`, files: [...files, ...extras] };
}

/**
 * Parse one invoice document with the configured provider (OpenAI by default).
 * The caller logs the call (logLlmCall kind 'invoice-parse', ref_id = document id) including on error.
 */
export async function parseInvoiceDocument(
  input: { bytes?: Uint8Array; text?: string; mimeType: string; filename: string; vendorHint?: string | null; retryHint?: string | null; extraImages?: LlmFile[] },
  provider: LlmProvider = getProvider(),
): Promise<ToolCallResult<InvoiceParse>> {
  const built = buildInvoiceInput(input);
  const user = input.retryHint
    ? `${built.user}\n\nA previous extraction of this same document was checked against the printed totals and failed:\n${input.retryHint}\nRe-read the document carefully (every receipt on the page, discounts folded into their items) and return a corrected extraction.`
    : built.user;
  const r = await provider.structured<InvoiceParse>({
    task: "invoice-parse",
    system: INVOICE_PARSE_SYSTEM,
    user,
    files: built.files,
    schema: InvoiceParseSchema,
    schemaName: "extract_invoice",
    toolSchema: INVOICE_PARSE_TOOL_SCHEMA,
    toolDescription: "Structured extraction of a foodservice invoice, credit memo, receipt, delivery ticket or vendor price quote.",
    maxTokens: 8192,
  });
  return toToolCallResult(r);
}
