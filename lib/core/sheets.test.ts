import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  categoryGuessFor,
  columnMapIsUsable,
  detectHeaderRow,
  extractLines,
  fingerprintHeader,
  groupByInvoice,
  inferColumnMap,
  matchKnownLayout,
  parseDateCell,
  parseMoney,
  readSpreadsheet,
  sumExtended,
} from "./sheets";

const fx = (name: string) => new Uint8Array(readFileSync(path.join(__dirname, "../../fixtures/invoices", name)));

describe("readSpreadsheet + header detection", () => {
  it("reads a CSV with meta rows above the header and finds the header", () => {
    const [sheet] = readSpreadsheet(fx("synthetic-rd-receipt.csv"), "text/csv", "synthetic-rd-receipt.csv");
    expect(detectHeaderRow(sheet.rows)).toBe(6);
  });
  it("reads an xlsx and finds the header on row 0", () => {
    const [sheet] = readSpreadsheet(fx("synthetic-sysco-unknown-layout.xlsx"), "", "synthetic-sysco-unknown-layout.xlsx");
    expect(sheet.name).toBe("Invoice Export");
    expect(detectHeaderRow(sheet.rows)).toBe(0);
  });
  it("skips a title row before the header", () => {
    const [sheet] = readSpreadsheet(fx("synthetic-totals-row.csv"), "text/csv", "synthetic-totals-row.csv");
    expect(detectHeaderRow(sheet.rows)).toBe(1);
  });
});

describe("known layout (deterministic)", () => {
  it("matches the Restaurant Depot receipt layout and extracts invoice number/date from the Transaction row", () => {
    const [sheet] = readSpreadsheet(fx("synthetic-rd-receipt.csv"), "text/csv", "x.csv");
    const h = detectHeaderRow(sheet.rows);
    const layout = matchKnownLayout(sheet.rows[h]);
    expect(layout?.id).toBe("restaurant-depot-receipt");
    const meta = layout!.meta!(sheet.rows, h);
    expect(meta.invoice_number).toBe("I99001");
    expect(meta.invoice_date).toBe("2026-08-20");
    expect(meta.subtotal).toBe("271.76");
    const { lines, skipped } = extractLines(sheet.rows, h, layout!.map, { footer: layout!.footer, meta });
    expect(lines.map((l) => l.description)).toEqual(["KETCHUP 3/114OZ", "KETCHUP 3/114OZ", "BOTTLE DEPOSIT"]);
    expect(lines[0].vendor_sku).toBe("RD-8891");
    expect(lines[0].quantity).toBe("2.0000");
    expect(lines[0].unit_price).toBe("67.1900");
    expect(lines[0].extended_price).toBe("134.38");
    expect(lines[0].invoice_number).toBe("I99001");
    expect(lines[2].category_guess).toBe("deposit");
    expect(skipped.length).toBe(0); // footer stopped the scan before the tallies rows
    expect(sumExtended(lines)).toBe("271.76");
  });
  it("does not match an unknown header", () => {
    const [sheet] = readSpreadsheet(fx("synthetic-sysco-unknown-layout.xlsx"), "", "x.xlsx");
    expect(matchKnownLayout(sheet.rows[0])).toBeNull();
  });
});

describe("unknown layout → header heuristic (what Haiku is asked to do; used as the fallback)", () => {
  it("maps Sysco-style headers, preferring shipped over ordered", () => {
    const [sheet] = readSpreadsheet(fx("synthetic-sysco-unknown-layout.xlsx"), "", "x.xlsx");
    const { map } = inferColumnMap(sheet.rows[0]);
    expect(map["0"]).toBe("vendor_sku");
    expect(map["1"]).toBe("description");
    expect(map["2"]).toBe("pack_size");
    expect(map["3"]).toBe("ignore"); // Brand
    expect(map["5"]).toBe("quantity"); // Qty Shipped wins because quantity is assigned once and "Qty Ordered" is not a synonym
    expect(map["4"]).toBe("ignore");
    expect(map["6"]).toBe("unit_price");
    expect(map["7"]).toBe("extended_price");
    expect(map["8"]).toBe("invoice_number");
    expect(map["9"]).toBe("invoice_date");
    expect(map["10"]).toBe("vendor_name");
    expect(columnMapIsUsable(map)).toBe(true);
    const { lines } = extractLines(sheet.rows, 0, map);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ vendor_sku: "1234567", description: "KETCHUP 6/#10", pack_size_text: "6/#10", quantity: "2.0000", unit_price: "62.5000", extended_price: "125.00", invoice_number: "SY-880001", invoice_date: "2026-08-21", vendor_name: "Sysco" });
  });
  it("fingerprints are stable across whitespace/case and differ across layouts", () => {
    const a = fingerprintHeader(["Item #", "Product Description", " Pack/Size "]);
    const b = fingerprintHeader(["item #", "PRODUCT DESCRIPTION", "pack/size"]);
    const c = fingerprintHeader(["Description", "Item Code", "Pack / Detail", "Units", "Amount"]);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

describe("multi-invoice sheet", () => {
  it("groups rows into one invoice per (number, date)", () => {
    const [sheet] = readSpreadsheet(fx("synthetic-multi-invoice.xlsx"), "", "x.xlsx");
    const { map } = inferColumnMap(sheet.rows[0]);
    const { lines } = extractLines(sheet.rows, 0, map);
    const groups = groupByInvoice(lines);
    expect(groups.map((g) => [g.invoice_number, g.invoice_date, g.lines.length])).toEqual([
      ["SY-880010", "2026-08-24", 2],
      ["SY-880011", "2026-08-27", 2],
    ]);
    expect(sumExtended(groups[1].lines)).toBe("907.50");
  });
  it("a sheet without invoice columns is one group", () => {
    const groups = groupByInvoice([
      { row_index: 1, vendor_sku: "a", description: "A", pack_size_text: null, quantity: "1.0000", unit_price: null, extended_price: "1.00", invoice_number: null, invoice_date: null, vendor_name: null, category_guess: null },
      { row_index: 2, vendor_sku: "b", description: "B", pack_size_text: null, quantity: "1.0000", unit_price: null, extended_price: "2.00", invoice_number: null, invoice_date: null, vendor_name: null, category_guess: null },
    ]);
    expect(groups).toHaveLength(1);
  });
});

describe("totals rows", () => {
  it("ignores Subtotal / Sales Tax / Total rows and keeps the fee line for mapping to ignore", () => {
    const [sheet] = readSpreadsheet(fx("synthetic-totals-row.csv"), "text/csv", "x.csv");
    const h = detectHeaderRow(sheet.rows);
    const { map } = inferColumnMap(sheet.rows[h]);
    const { lines, skipped } = extractLines(sheet.rows, h, map);
    expect(lines.map((l) => l.description)).toEqual(["TOMATOES 25 LB", "TEQUILA BLANCO 12/750ML", "FUEL SURCHARGE"]);
    expect(skipped.map((s) => s.reason)).toEqual(["totals row", "totals row", "totals row"]);
    expect(lines[2].category_guess).toBe("fee");
    expect(sumExtended(lines)).toBe("536.50");
  });
});

describe("cell parsers", () => {
  it("parseMoney", () => {
    expect(parseMoney("$1,234.56")?.toFixed(2)).toBe("1234.56");
    expect(parseMoney("($53.38)")?.toFixed(2)).toBe("-53.38");
    expect(parseMoney("-8.5")?.toFixed(2)).toBe("-8.50");
    expect(parseMoney("—")).toBeNull();
    expect(parseMoney("")).toBeNull();
  });
  it("parseDateCell", () => {
    expect(parseDateCell("2026-08-05")).toBe("2026-08-05");
    expect(parseDateCell("08/05/2026")).toBe("2026-08-05");
    expect(parseDateCell("8/5/26")).toBe("2026-08-05");
    expect(parseDateCell("08-05-26")).toBe("2026-08-05");
    expect(parseDateCell(46239)).toBe("2026-08-05"); // Excel serial
    expect(parseDateCell("nope")).toBeNull();
  });
  it("categoryGuessFor", () => {
    expect(categoryGuessFor("BOTTLE DEPOSIT", null)).toBe("deposit");
    expect(categoryGuessFor("FUEL SURCHARGE", null)).toBe("fee");
    expect(categoryGuessFor("Sales Tax", null)).toBe("tax");
    expect(categoryGuessFor("KETCHUP 6/#10", "6/#10")).toBeNull();
  });
});
