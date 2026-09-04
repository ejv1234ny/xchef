/**
 * pnpm tsx scripts/gen-sheet-fixtures.ts — writes the SYNTHETIC spreadsheet
 * fixtures used by lib/core/sheets.test.ts and `pnpm invoices:replay`. They are
 * committed (unlike real invoices). SKUs match the demo seed's vendor mappings
 * (Sysco 1234567/2345678/3456789, Restaurant Depot RD-8891) so replay posts
 * them without any LLM call.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as XLSX from "xlsx";

const dir = path.resolve(process.cwd(), "fixtures/invoices");
mkdirSync(dir, { recursive: true });

// 1. Known layout: a Restaurant Depot receipt transcription with meta rows above the header.
const rdReceipt = [
  ["Mad Moose Bar and Grill"],
  [],
  ["Transaction", "C16 I99001 OP1  08-20-26 10:12"],
  ["Account", "0000123"],
  ["Receipt tallies", "Subtotal $271.76 · VT Tax $0.00 · Total $271.76"],
  ["Note: synthetic fixture for tests"],
  ["Description", "Item Code", "Pack / Detail", "Units", "Amount"],
  ["KETCHUP 3/114OZ", "RD-8891", "C · 1cs/3u", "2", "$134.38"],
  ["KETCHUP 3/114OZ", "RD-8891", "C · 1cs/3u", "2", "$134.38"],
  ["BOTTLE DEPOSIT", "", "U", "1", "$3.00"],
  ["Sum of legible line items", "", "", "", "$271.76"],
  ["Printed receipt total (from scan)", "", "", "", "$271.76"],
];
writeFileSync(path.join(dir, "synthetic-rd-receipt.csv"), rdReceipt.map((r) => r.map((c) => (c.includes(",") || c.includes("·") ? `"${c}"` : c)).join(",")).join("\n"));

// 2. Unknown layout (Sysco-style invoice export): goes through Haiku once (or the header heuristic), then is remembered.
const syscoHeader = ["Item #", "Product Description", "Pack/Size", "Brand", "Qty Ordered", "Qty Shipped", "Price", "Ext Price", "Invoice #", "Invoice Date", "Vendor"];
const syscoUnknown = [
  syscoHeader,
  ["1234567", "KETCHUP 6/#10", "6/#10", "HEINZ", "2", "2", "62.50", "125.00", "SY-880001", "08/21/2026", "Sysco"],
  ["2345678", "TOMATOES 25 LB", "25 LB", "", "1", "1", "56.00", "56.00", "SY-880001", "08/21/2026", "Sysco"],
  ["3456789", "TEQUILA BLANCO 12/750ML", "12/750ML", "", "1", "1", "360.00", "360.00", "SY-880001", "08/21/2026", "Sysco"],
];
const wb1 = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb1, XLSX.utils.aoa_to_sheet(syscoUnknown), "Invoice Export");
XLSX.writeFile(wb1, path.join(dir, "synthetic-sysco-unknown-layout.xlsx"));

// 3. Multi-invoice sheet: two invoices in one export → two invoice_documents rows.
const multi = [
  syscoHeader,
  ["1234567", "KETCHUP 6/#10", "6/#10", "HEINZ", "1", "1", "62.50", "62.50", "SY-880010", "08/24/2026", "Sysco"],
  ["2345678", "TOMATOES 25 LB", "25 LB", "", "2", "2", "56.00", "112.00", "SY-880010", "08/24/2026", "Sysco"],
  ["3456789", "TEQUILA BLANCO 12/750ML", "12/750ML", "", "2", "2", "360.00", "720.00", "SY-880011", "08/27/2026", "Sysco"],
  ["1234567", "KETCHUP 6/#10", "6/#10", "HEINZ", "3", "3", "62.50", "187.50", "SY-880011", "08/27/2026", "Sysco"],
];
const wb2 = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb2, XLSX.utils.aoa_to_sheet(multi), "Export");
XLSX.writeFile(wb2, path.join(dir, "synthetic-multi-invoice.xlsx"));

// 4. Totals rows that must be ignored, plus a fee line that must be ignored by mapping (not by parsing).
const totals = [
  ["Sysco Vermont — Invoice SY-880020", "", "", "", "", "", "", "", "", "", ""],
  syscoHeader,
  ["2345678", "TOMATOES 25 LB", "25 LB", "", "3", "3", "56.00", "168.00", "SY-880020", "08/30/2026", "Sysco"],
  ["3456789", "TEQUILA BLANCO 12/750ML", "12/750ML", "", "1", "1", "360.00", "360.00", "SY-880020", "08/30/2026", "Sysco"],
  ["", "FUEL SURCHARGE", "", "", "", "1", "8.50", "8.50", "SY-880020", "08/30/2026", "Sysco"],
  ["", "Subtotal", "", "", "", "", "", "536.50", "", "", ""],
  ["", "Sales Tax", "", "", "", "", "", "0.00", "", "", ""],
  ["", "Total", "", "", "", "", "", "536.50", "", "", ""],
];
writeFileSync(path.join(dir, "synthetic-totals-row.csv"), totals.map((r) => r.map((c) => (/[",]/.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(",")).join("\n"));

console.log("wrote 4 synthetic spreadsheet fixtures to", dir);
