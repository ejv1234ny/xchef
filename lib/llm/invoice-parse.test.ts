import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { buildInvoiceInput, InvoiceParseSchema, normalizeMime, parseInvoiceDocument, UnsupportedInvoiceMediaError } from "./invoice-parse";
import { isLlmConfigured } from "./provider";

const FIXTURES = path.join(__dirname, "../../fixtures/invoices");

type Expected = { vendor_name: string; line_count: number; subtotal: number | null };

/** Every <name>.expected.json with a sibling <name>.pdf|jpg|jpeg|png */
function expectedFixtures(): Array<{ name: string; file: string; expected: Expected }> {
  if (!existsSync(FIXTURES)) return [];
  const out: Array<{ name: string; file: string; expected: Expected }> = [];
  for (const f of readdirSync(FIXTURES)) {
    if (!f.endsWith(".expected.json")) continue;
    const name = f.slice(0, -".expected.json".length);
    const doc = ["pdf", "jpg", "jpeg", "png"].map((e) => path.join(FIXTURES, `${name}.${e}`)).find((p) => existsSync(p));
    if (!doc) continue;
    out.push({ name, file: doc, expected: JSON.parse(readFileSync(path.join(FIXTURES, f), "utf8")) as Expected });
  }
  return out;
}

const fixtures = expectedFixtures();

describe("InvoiceParseSchema", () => {
  it("accepts the documented shape", () => {
    const sample = InvoiceParseSchema.parse({
      is_invoice: true,
      document_kind: "invoice",
      vendor_name: "Sysco",
      invoice_number: "123",
      invoice_date: "2026-08-05",
      received_date: null,
      subtotal: 129.69,
      tax: 0,
      total: 129.69,
      currency: "USD",
      lines: [
        { line_no: 1, vendor_sku: "1234567", description: "KETCHUP FANCY", pack_size_text: "6/#10", quantity: 1, unit_price: 62.5, extended_price: 62.5, category_guess: "dry", confidence: 0.98 },
        { line_no: 2, vendor_sku: null, description: "KETCHUP", pack_size_text: "3/114OZ", quantity: 1, unit_price: 67.19, extended_price: 67.19, category_guess: "dry", confidence: 0.95 },
      ],
      overall_confidence: 0.96,
    });
    expect(sample.lines).toHaveLength(2);
    expect(() => InvoiceParseSchema.parse({ ...sample, invoice_date: "08/05/2026" })).toThrow();
    expect(() => InvoiceParseSchema.parse({ ...sample, document_kind: "receipt" })).toThrow();
  });

  it("builds a provider-neutral input (PDF / image attached, text inline) and refuses HEIC", () => {
    const pdf = buildInvoiceInput({ bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), mimeType: "application/pdf", filename: "a.pdf" });
    expect(pdf.files[0].mimeType).toBe("application/pdf");
    const img = buildInvoiceInput({ bytes: new Uint8Array([1, 2, 3]), mimeType: "image/jpg", filename: "a.jpg", vendorHint: "Sysco" });
    expect(img.files[0].mimeType).toBe("image/jpeg");
    expect(img.user).toContain("Vendor hint");
    const txt = buildInvoiceInput({ text: "SYSCO INVOICE 123", mimeType: "text/plain", filename: "paste.txt" });
    expect(txt.files).toHaveLength(0);
    expect(txt.user).toContain("SYSCO INVOICE 123");
    expect(() => buildInvoiceInput({ bytes: new Uint8Array([1]), mimeType: "image/heic", filename: "IMG_1.HEIC" })).toThrow(UnsupportedInvoiceMediaError);
    expect(() => buildInvoiceInput({ bytes: new Uint8Array([1]), mimeType: "application/octet-stream", filename: "IMG_1.heic" })).toThrow(/HEIC/);
    expect(normalizeMime("application/octet-stream", "scan.PDF")).toBe("application/pdf");
    expect(normalizeMime("", "export.XLSX")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });
});

describe.skipIf(!isLlmConfigured() || fixtures.length === 0)("parseInvoiceDocument against fixtures/invoices/*.expected.json", () => {
  for (const fx of fixtures) {
    it(
      `${fx.name}: vendor, line count ±1, Σ extended ≈ subtotal`,
      async () => {
        const bytes = new Uint8Array(readFileSync(fx.file));
        const { data } = await parseInvoiceDocument({ bytes, mimeType: normalizeMime("", fx.file), filename: path.basename(fx.file) });
        expect(data.is_invoice).toBe(true);
        expect(data.vendor_name.toLowerCase()).toContain(fx.expected.vendor_name.toLowerCase().split(" ")[0]);
        expect(Math.abs(data.lines.length - fx.expected.line_count)).toBeLessThanOrEqual(1);
        if (data.subtotal != null && data.subtotal > 0) {
          const sum = data.lines.filter((l) => !["tax", "fee", "deposit"].includes(l.category_guess)).reduce((a, l) => a + (l.extended_price ?? 0), 0);
          expect(Math.abs(sum - data.subtotal) / data.subtotal).toBeLessThan(0.02);
        }
      },
      120_000,
    );
  }
});
