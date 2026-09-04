import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import { buildInvoiceInput, InvoiceParseSchema, normalizeMime, normalizeParsedDocument, UnsupportedInvoiceMediaError, validateParsedDocument, type InvoiceParsedDocument } from "./invoice-parse";
import { extractInvoiceFromFile } from "./invoice-extract";
import { isLlmConfigured } from "./provider";

config({ path: path.resolve(__dirname, "../../.env.local"), quiet: true });

const FIXTURES = path.join(__dirname, "../../fixtures/invoices");

type ExpectedDoc = { vendor_name: string; receipt_id?: string | null; invoice_date?: string | null; line_count: number; subtotal: number | null; printed_item_count?: number | null; has_adjustments?: boolean; exact_subtotal?: boolean };
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
        });
      },
      180_000,
    );
  }
});
