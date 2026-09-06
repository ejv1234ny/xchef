import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import { buildInvoiceInput, InvoiceParseSchema, normalizeMime, normalizeParsedDocument, UnsupportedInvoiceMediaError, validateParsedDocument, type InvoiceParsedDocument } from "./invoice-parse";
import { extractInvoiceFromFile } from "./invoice-extract";
import { isLlmConfigured } from "./provider";

config({ path: path.resolve(__dirname, "../../.env.local"), quiet: true });

const FIXTURES = path.join(__dirname, "../../fixtures/invoices");

type ExpectedDoc = {
  vendor_name: string;
  receipt_id?: string | null;
  invoice_date?: string | null;
  line_count: number;
  subtotal: number | null;
  printed_item_count?: number | null;
  has_adjustments?: boolean;
  exact_subtotal?: boolean;
  /** regex (case-insensitive) no line description may match — e.g. a category header the parser used to emit as a product */
  forbid_description_pattern?: string;
  /** every product line carries its own vendor_sku and no two product lines share one */
  distinct_skus?: boolean;
  /** lines that must be present: description contains (case-insensitive) → expected pack / quantity / extended */
  lines_must_include?: Array<{ description_contains: string; pack_size_text?: string | null; quantity?: number; extended_price?: number }>;
};
type Expected = { documents: ExpectedDoc[] } | { vendor_name: string; line_count: number; subtotal: number | null };

function toDocs(e: Expected): ExpectedDoc[] {
  return "documents" in e ? e.documents : [{ vendor_name: e.vendor_name, line_count: e.line_count, subtotal: e.subtotal }];
}

/** Every <name>.expected.json with a sibling <name>.pdf|jpg|jpeg|png */
function expectedFixtures(): Array<{ name: string; file: string; expected: ExpectedDoc[] }> {
  if (!existsSync(FIXTURES)) return [];
  const out: Array<{ name: string; file: string; expected: ExpectedDoc[] }> = [];
  for (const f of readdirSync(FIXTURES)) {
    if (!f.endsWith(".expected.json")) continue;
    const name = f.slice(0, -".expected.json".length);
    const doc = ["pdf", "jpg", "jpeg", "png"].map((e) => path.join(FIXTURES, `${name}.${e}`)).find((p) => existsSync(p));
    if (!doc) continue;
    out.push({ name, file: doc, expected: toDocs(JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8")) as Expected) });
  }
  return out;
}

const fixtures = expectedFixtures();

const sampleDoc: InvoiceParsedDocument = {
  is_invoice: true,
  document_kind: "invoice",
  vendor_name: "802 Spirits",
  receipt_id: "201717-1155731",
  transaction_code: "2017-2017-1-176",
  invoice_number: null,
  invoice_date: "2025-12-21",
  invoice_time: "14:32",
  received_date: null,
  subtotal: 100,
  tax: 0,
  total: 100,
  currency: "USD",
  printed_item_count: 2,
  region: "left",
  lines: [
    { line_no: 1, vendor_sku: "0001", description: "TITOS VODKA 1.75L", pack_size_text: "1.75L", quantity: 2, unit_price: 30, gross_price: 60, adjustment: 5, extended_price: 55, category_guess: "liquor", confidence: 0.98 },
    { line_no: 2, vendor_sku: null, description: "BEEFEATER GIN 750ML", pack_size_text: "750ML", quantity: 2, unit_price: 22.5, gross_price: 45, adjustment: null, extended_price: 45, category_guess: "liquor", confidence: 0.95 },
  ],
  confidence: 0.96,
};

describe("InvoiceParseSchema (documents[])", () => {
  it("accepts the documented shape and rejects bad dates / kinds", () => {
    const page = InvoiceParseSchema.parse({ documents: [sampleDoc], page_notes: null });
    expect(page.documents).toHaveLength(1);
    expect(page.documents[0].lines[0].adjustment).toBe(5);
    expect(() => InvoiceParseSchema.parse({ documents: [{ ...sampleDoc, invoice_date: "12/21/2025" }] })).toThrow();
    expect(() => InvoiceParseSchema.parse({ documents: [{ ...sampleDoc, invoice_time: "2:32 PM" }] })).toThrow();
    expect(() => InvoiceParseSchema.parse({ documents: [{ ...sampleDoc, document_kind: "receipt" }] })).toThrow();
  });

  it("normalizeParsedDocument folds stray discount lines into the preceding item and keeps extended = gross − adjustment", () => {
    const messy: InvoiceParsedDocument = {
      ...sampleDoc,
      lines: [
        { line_no: 1, vendor_sku: "0001", description: "TITOS VODKA 1.75L", pack_size_text: null, quantity: 2, unit_price: 30, gross_price: null, adjustment: null, extended_price: 60, category_guess: "liquor", confidence: 0.9 },
        { line_no: 2, vendor_sku: null, description: "PROMO DISCOUNT", pack_size_text: null, quantity: 1, unit_price: null, gross_price: null, adjustment: null, extended_price: -5, category_guess: "discount", confidence: 0.9 },
        { line_no: 3, vendor_sku: null, description: "BEEFEATER GIN 750ML", pack_size_text: null, quantity: 1, unit_price: 45, gross_price: 45, adjustment: 3, extended_price: null, category_guess: "liquor", confidence: 0.9 },
      ],
    };
    const n = normalizeParsedDocument(messy);
    expect(n.lines).toHaveLength(2);
    expect(n.lines[0]).toMatchObject({ line_no: 1, gross_price: 60, adjustment: 5, extended_price: 55 });
    expect(n.lines[1]).toMatchObject({ line_no: 2, gross_price: 45, adjustment: 3, extended_price: 42 });
  });

  it("validateParsedDocument checks Σ extended vs subtotal and line count vs printed count", () => {
    expect(validateParsedDocument(sampleDoc)).toMatchObject({ ok: true, line_count: 2, printed_item_count: 2, line_sum: "100.00", subtotal: "100.00" });
    const bad = validateParsedDocument({ ...sampleDoc, subtotal: 120, printed_item_count: 3 });
    expect(bad.ok).toBe(false);
    expect(bad.issues).toHaveLength(2);
    expect(bad.issues[0]).toContain("100.00 vs printed subtotal 120.00");
    expect(bad.issues[1]).toContain("2 product lines (quantity 4) vs printed item count 3");
    // tax / fee lines are not product lines
    const withTax = validateParsedDocument({ ...sampleDoc, lines: [...sampleDoc.lines, { line_no: 3, description: "SALES TAX", quantity: 1, extended_price: 6, category_guess: "tax", confidence: 1 }] });
    expect(withTax.ok).toBe(true);
  });

  it("builds a provider-neutral input (PDF / image attached, text inline) and refuses HEIC", () => {
    const pdf = buildInvoiceInput({ bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mimeType: "application/pdf", filename: "a.pdf" });
    expect(pdf.files[0].mimeType).toBe("application/pdf");
    expect(pdf.user).toContain("every receipt or invoice");
    const img = buildInvoiceInput({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpg", filename: "a.jpg", vendorHint: "Sysco" });
    expect(img.files[0].mimeType).toBe("image/jpeg");
    const txt = buildInvoiceInput({ text: "SYSCO INVOICE 123", mimeType: "text/plain", filename: "paste.txt" });
    expect(txt.files).toHaveLength(0);
    expect(() => buildInvoiceInput({ bytes: new Uint8Array([1]), mimeType: "image/heic", filename: "IMG_1.HEIC" })).toThrow(UnsupportedInvoiceMediaError);
    expect(normalizeMime("application/octet-stream", "scan.PDF")).toBe("application/pdf");
  });
});

describe.skipIf(!isLlmConfigured() || fixtures.length === 0)("parseInvoiceDocument against fixtures/invoices/*.expected.json (real model)", () => {
  for (const fx of fixtures) {
    it(
      `${fx.name}: ${fx.expected.length} document(s), exact line counts, Σ extended ≈ subtotal, discounts applied`,
      async () => {
        const bytes = new Uint8Array(readFileSync(fx.file));
        const result = await extractInvoiceFromFile({ bytes, mimeType: normalizeMime("", fx.file), filename: path.basename(fx.file) });
        const docs = result.documents;
        console.log(`${fx.name}: ${docs.length} document(s) after ${result.attempts.length} attempt(s), media=${JSON.stringify(result.media)}: ${docs.map((d, i) => `${d.region ?? "?"} ${d.receipt_id ?? "-"} lines=${result.validations[i].line_count}/${d.printed_item_count ?? "?"} Σ=${result.validations[i].line_sum}/${d.subtotal ?? "?"}`).join(" | ")}`);
        expect(docs).toHaveLength(fx.expected.length);
        fx.expected.forEach((exp, i) => {
          const d = docs[i];
          const v = result.validations[i];
          expect(d.is_invoice).toBe(true);
          expect(d.vendor_name.toLowerCase()).toContain(exp.vendor_name.toLowerCase().split(" ")[0]);
          expect(v.line_count).toBe(exp.line_count);
          if (exp.receipt_id) expect(d.receipt_id?.replace(/\s+/g, "")).toBe(exp.receipt_id.replace(/\s+/g, ""));
          if (exp.invoice_date) expect(d.invoice_date).toBe(exp.invoice_date);
          if (exp.printed_item_count != null) expect(d.printed_item_count).toBe(exp.printed_item_count);
          expect(v.ok).toBe(true);
          if (exp.subtotal != null) {
            // Σ of the extracted lines is the number that matters (the model can misread a faint subtotal digit).
            const diff = Math.abs(Number(v.line_sum) - exp.subtotal);
            if (exp.exact_subtotal) expect(diff).toBeLessThan(0.01);
            else expect(diff / exp.subtotal).toBeLessThan(0.02);
          }
          if (exp.has_adjustments) expect(d.lines.some((l) => (l.adjustment ?? 0) > 0)).toBe(true);
          expect(d.lines.some((l) => /discount|promo|coupon/i.test(l.description) && !l.vendor_sku)).toBe(false);
          if (exp.forbid_description_pattern) {
            const re = new RegExp(exp.forbid_description_pattern, "i");
            expect(d.lines.filter((l) => re.test(l.description)).map((l) => l.description)).toEqual([]);
          }
          if (exp.distinct_skus) {
            const products = d.lines.filter((l) => !["tax", "fee", "deposit"].includes(l.category_guess.toLowerCase()));
            const skus = products.map((l) => (l.vendor_sku ?? "").trim());
            expect(skus.every(Boolean)).toBe(true);
            expect(new Set(skus).size).toBe(skus.length);
          }
          const squash = (t: string | null | undefined) => (t == null ? null : t.replace(/\s+/g, ""));
          for (const want of exp.lines_must_include ?? []) {
            const hit = d.lines.find((l) => l.description.toLowerCase().includes(want.description_contains.toLowerCase()));
            expect(hit, `line containing "${want.description_contains}"`).toBeDefined();
            if (want.pack_size_text !== undefined) expect(squash(hit!.pack_size_text)).toBe(squash(want.pack_size_text));
            if (want.quantity !== undefined) expect(hit!.quantity).toBe(want.quantity);
            if (want.extended_price !== undefined) expect(hit!.extended_price).toBeCloseTo(want.extended_price, 2);
          }
        });
      },
      180_000,
    );
  }
});

// ---- Quotes (KICKOFF-2 Part 3): vendor replies to a pricing request ------------------------------------

const QUOTE_FIXTURES = path.join(__dirname, "../../fixtures/quotes");

type ExpectedQuote = {
  vendor_name: string;
  document_kind: "quote";
  line_count: number;
  first_line: { vendor_sku?: string; description_contains?: string; unit_price: number; pack_size_text?: string; has_special_terms?: boolean };
  valid_from: string | null;
  valid_through: string | null;
  line_with_min_quantity?: { vendor_sku: string; min_quantity: number };
  must_not_contain_description?: string;
};

function quoteFixtures(): Array<{ name: string; file: string; expected: ExpectedQuote }> {
  if (!existsSync(QUOTE_FIXTURES)) return [];
  return readdirSync(QUOTE_FIXTURES)
    .filter((f) => f.endsWith(".expected.json"))
    .map((f) => {
      const name = f.slice(0, -".expected.json".length);
      return { name, file: path.join(QUOTE_FIXTURES, `${name}.txt`), expected: JSON.parse(readFileSync(path.join(QUOTE_FIXTURES, f), "utf8")) as ExpectedQuote };
    })
    .filter((fx) => existsSync(fx.file));
}

const quoteFx = quoteFixtures();

describe("InvoiceParseSchema: quotes", () => {
  it("accepts document_kind 'quote' with validity dates and per-line special_terms / min_quantity", () => {
    const quote = InvoiceParseSchema.parse({
      documents: [
        {
          ...sampleDoc,
          is_invoice: false,
          document_kind: "quote",
          receipt_id: null,
          subtotal: null,
          total: null,
          printed_item_count: null,
          valid_from: "2026-09-08",
          valid_through: "2026-09-30",
          lines: [{ line_no: 1, vendor_sku: "0001", description: "TITOS VODKA 750ML", pack_size_text: "750ML", quantity: 1, unit_price: 41.5, extended_price: 41.5, category_guess: "liquor", confidence: 0.95, special_terms: "case of 12 $480", min_quantity: null }],
        },
      ],
    });
    expect(quote.documents[0].document_kind).toBe("quote");
    expect(quote.documents[0].valid_through).toBe("2026-09-30");
    expect(quote.documents[0].lines[0].special_terms).toBe("case of 12 $480");
    expect(() => InvoiceParseSchema.parse({ documents: [{ ...sampleDoc, valid_through: "9/30/2026" }] })).toThrow();
    // a quote without prices printed still validates (no subtotal to check)
    expect(validateParsedDocument({ ...quote.documents[0], subtotal: null, printed_item_count: null }).ok).toBe(true);
  });
});

describe.skipIf(!isLlmConfigured() || quoteFx.length === 0)("quote replies in fixtures/quotes/*.txt (real model)", () => {
  for (const fx of quoteFx) {
    it(
      `${fx.name}: document_kind quote, ${fx.expected.line_count} lines, valid_through ${fx.expected.valid_through}`,
      async () => {
        const text = readFileSync(fx.file, "utf8");
        const result = await extractInvoiceFromFile({ text, mimeType: "text/plain", filename: path.basename(fx.file) });
        const quotes = result.documents.filter((d) => d.document_kind === "quote");
        console.log(`${fx.name}: ${result.documents.length} document(s) after ${result.attempts.length} attempt(s): ${result.documents.map((d) => `${d.document_kind} ${d.vendor_name} lines=${d.lines.length} valid ${d.valid_from ?? "-"}→${d.valid_through ?? "-"}`).join(" | ")}`);
        expect(result.documents).toHaveLength(1);
        expect(quotes).toHaveLength(1);
        const d = quotes[0];
        expect(d.vendor_name.toLowerCase()).toContain(fx.expected.vendor_name.toLowerCase().split(" ")[0]);
        expect(d.lines).toHaveLength(fx.expected.line_count);
        expect(d.valid_through ?? null).toBe(fx.expected.valid_through);
        if (fx.expected.valid_from) expect(d.valid_from ?? null).toBe(fx.expected.valid_from);
        const first = d.lines[0];
        expect(first.unit_price).toBeCloseTo(fx.expected.first_line.unit_price, 2);
        if (fx.expected.first_line.vendor_sku) expect(first.vendor_sku).toBe(fx.expected.first_line.vendor_sku);
        if (fx.expected.first_line.description_contains) expect(first.description.toLowerCase()).toContain(fx.expected.first_line.description_contains.toLowerCase());
        if (fx.expected.first_line.pack_size_text) expect(first.pack_size_text?.replace(/\s+/g, "")).toBe(fx.expected.first_line.pack_size_text.replace(/\s+/g, ""));
        if (fx.expected.first_line.has_special_terms) expect((first.special_terms ?? "").length).toBeGreaterThan(0);
        if (fx.expected.line_with_min_quantity) {
          const l = d.lines.find((x) => x.vendor_sku === fx.expected.line_with_min_quantity!.vendor_sku);
          expect(l?.min_quantity).toBe(fx.expected.line_with_min_quantity.min_quantity);
        }
        if (fx.expected.must_not_contain_description) {
          // the quoted original request (what we asked about) must not leak into the lines
          expect(d.lines.some((l) => l.description.toUpperCase().includes(fx.expected.must_not_contain_description!.toUpperCase()))).toBe(false);
        }
        // every quoted line carries a per-pack price
        expect(d.lines.every((l) => l.unit_price != null && l.unit_price > 0)).toBe(true);
      },
      180_000,
    );
  }
});
