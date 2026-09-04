import * as XLSX from "xlsx";
import Decimal from "decimal.js";
import type { ServiceClient } from "@/lib/db/service";
import type { Json } from "@/lib/db/types";
import { createManualInvoiceDocument, runInvoicePipeline, type Logger, type ManualLine } from "./intake";

/**
 * Restaurant Depot spreadsheet import (fixtures/invoices/*.xlsx, transcribed
 * from receipt scans). One invoice_documents row per receipt sheet, source
 * 'manual', dedupe by content hash of the receipt rows JSON, then the normal
 * map → post jobs.
 *
 * Column mapping found in the workbooks (2026-09):
 *
 * Restaurant_Depot_Receipts.xlsx — one sheet per receipt, plus 'Summary' and
 * 'Receipt Index' (skipped):
 *   A1              business name ("Mad Moose Bar and Grill", "Moose on the Loose", "(customer header not captured)")
 *   A3/B3           "Transaction" | "C16 I15336 OP288797  08-05-26 08:06"  → invoice_number "I15336", invoice_date 2026-08-05
 *   A4/B4           "Account"     | store account number
 *   A5/B5           "Payment"     | tender line
 *   A6/B6           "Receipt tallies" | "… Subtotal $1,094.14 · NY Tax $37.60 · Total $792.24" → subtotal/tax/total when printed
 *   A7              "Note: …" provenance (scan names, what was cut off)
 *   header row      ["Description", "Item Code", "Pack / Detail", "Units", "Amount"]
 *     Description   → invoice_lines.description
 *     Item Code     → vendor_sku ("(illegible)" → null)
 *     Pack / Detail → pack_size_text ("13.21 LB @ $6.49/LB", "U", "C · 1cs/7u", "case $15.00 / 12", "V void", "2X U @ $13.61")
 *     Units         → quantity (negative on voids)
 *     Amount        → extended_price ("$85.73"; "($53.38)" = negative); unit_price = amount / units
 *   footer rows     "Sum of legible line items", "Printed receipt total (from scan)", "… cut off …" → stop
 *   'Summary' sheet "Date / Time" column is the fallback date for sheets without a transaction line.
 *
 * Restaurant_Depot_Items_8-6.xlsx — 'By Category' sheet: section heading rows
 * "Meats, Poultry & Seafood   (39 items)" followed by ["Item","Detail","Qty","Amount","Source (receipt)"]
 * rows. Used only to derive ai_category_guess per description (meat, dairy,
 * produce, frozen, bakery, dry, beverage, supplies, discount). 'Category Summary' is skipped.
 */

export type ImportOptions = {
  locationId: string;
  itemsPath: string;
  receiptsPath: string;
  log?: Logger;
  /** only import receipts whose business name matches (case-insensitive substring); default all */
  business?: string | null;
};

export type ImportedReceipt = {
  sheet: string;
  business: string;
  invoiceNumber: string;
  invoiceDate: string | null;
  lines: number;
  documentId: string;
  duplicate: boolean;
  status: string;
  mapped: number;
  unmapped: number;
};

const VENDOR_NAME = "Restaurant Depot";
const SKIP_SHEETS = new Set(["Summary", "Receipt Index"]);

const CATEGORY_MAP: Array<{ re: RegExp; cat: string }> = [
  { re: /meat|poultry|seafood/i, cat: "meat" },
  { re: /cheese|dairy|egg/i, cat: "dairy" },
  { re: /fruit|vegetable|produce/i, cat: "produce" },
  { re: /frozen/i, cat: "frozen" },
  { re: /bakery|snack|candy/i, cat: "bakery" },
  { re: /pantry|sauce|seasoning/i, cat: "dry" },
  { re: /beverage/i, cat: "beverage" },
  { re: /suppl|disposable/i, cat: "supplies" },
  { re: /discount|adjust/i, cat: "discount" },
];

type Cell = string | number | null | undefined;
type Row = Cell[];

function cellStr(c: Cell): string {
  return c == null ? "" : String(c).trim();
}

/** "$1,234.56" → 1234.56; "($53.38)" → -53.38; "—" → null */
export function parseMoney(c: Cell): Decimal | null {
  const s = cellStr(c);
  if (!s || s === "—" || s === "-") return null;
  const neg = /^\(.*\)$/.test(s) || s.startsWith("-");
  const digits = s.replace(/[^0-9.]/g, "");
  if (!digits) return null;
  const d = new Decimal(digits);
  return neg ? d.negated() : d;
}

/** "C16 I15336 OP288797  08-05-26 08:06" → { invoiceNumber: "I15336", date: "2026-08-05" } */
export function parseTransaction(s: string): { invoiceNumber: string | null; date: string | null } {
  const inv = s.match(/\bI(\d+)\b/);
  const d = s.match(/\b(\d{2})-(\d{2})-(\d{2})\b/);
  return { invoiceNumber: inv ? `I${inv[1]}` : null, date: d ? `20${d[3]}-${d[1]}-${d[2]}` : null };
}

function parseTallies(s: string): { subtotal: Decimal | null; tax: Decimal | null; total: Decimal | null } {
  const grab = (re: RegExp) => {
    const m = s.match(re);
    return m ? parseMoney(m[1]) : null;
  };
  return {
    subtotal: grab(/Subtotal\s*(\$[\d,.]+)/i),
    tax: grab(/Tax\s*(\$[\d,.]+)/i),
    total: grab(/(?:^|[^a-z])Total\s*(\$[\d,.]+)/i),
  };
}

function sheetRows(wb: XLSX.WorkBook, name: string): Row[] {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json<Row>(ws, { header: 1, raw: false, defval: null });
}

/** description (upper, collapsed) → category from the Items workbook */
export function loadCategoryIndex(itemsPath: string): Map<string, string> {
  const wb = XLSX.readFile(itemsPath);
  const out = new Map<string, string>();
  const rows = sheetRows(wb, "By Category");
  let current: string | null = null;
  for (const r of rows) {
    const a = cellStr(r[0]);
    if (!a) continue;
    const heading = a.match(/^(.+?)\s+\(\d+\s+items?\)$/i);
    if (heading && cellStr(r[1]) === "") {
      current = CATEGORY_MAP.find((c) => c.re.test(heading[1]))?.cat ?? "other";
      continue;
    }
    if (a === "Item" || /—\s*subtotal$/i.test(a) || !current) continue;
    const key = a.toUpperCase().replace(/\s+/g, " ");
    if (!out.has(key)) out.set(key, current);
  }
  return out;
}

export type ParsedReceipt = {
  sheet: string;
  business: string;
  transaction: string;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  note: string | null;
  tallies: string | null;
  subtotal: string | null;
  tax: string | null;
  total: string | null;
  lines: ManualLine[];
};

export function parseReceiptsWorkbook(receiptsPath: string, categories: Map<string, string>): ParsedReceipt[] {
  const wb = XLSX.readFile(receiptsPath);
  const summaryDates = new Map<string, string | null>();
  for (const r of sheetRows(wb, "Summary")) {
    const sheet = cellStr(r[0]);
    const dt = cellStr(r[2]).match(/(\d{2})-(\d{2})-(\d{2})/);
    if (sheet && wb.SheetNames.includes(sheet)) summaryDates.set(sheet, dt ? `20${dt[3]}-${dt[1]}-${dt[2]}` : null);
  }

  const receipts: ParsedReceipt[] = [];
  for (const name of wb.SheetNames) {
    if (SKIP_SHEETS.has(name)) continue;
    const rows = sheetRows(wb, name);
    if (rows.length === 0) continue;
    const business = cellStr(rows[0]?.[0]) || "(unknown)";
    const meta = new Map<string, string>();
    let note: string | null = null;
    let headerIdx = -1;
    for (let i = 0; i < rows.length; i++) {
      const a = cellStr(rows[i][0]);
      if (a === "Description" && cellStr(rows[i][1]) === "Item Code") {
        headerIdx = i;
        break;
      }
      if (a.startsWith("Note:")) note = a.slice(5).trim();
      else if (a) meta.set(a, cellStr(rows[i][1]));
    }
    if (headerIdx < 0) continue;
    const transaction = meta.get("Transaction") ?? "";
    const tx = parseTransaction(transaction);
    const tallies = meta.get("Receipt tallies") ?? null;
    const t = parseTallies(tallies ?? "");

    const lines: ManualLine[] = [];
    for (const r of rows.slice(headerIdx + 1)) {
      const desc = cellStr(r[0]);
      if (!desc) continue;
      if (/^(Sum of legible|Printed receipt total)/i.test(desc)) break;
      if (desc.startsWith("…") || desc.startsWith("...")) continue; // "… N items not captured on scan …" gap markers
      const amount = parseMoney(r[4]);
      const unitsRaw = cellStr(r[3]);
      const units = unitsRaw ? new Decimal(unitsRaw.replace(/[^0-9.-]/g, "") || "0") : new Decimal(amount && amount.isNegative() ? -1 : 1);
      const detail = cellStr(r[2]) || null;
      const sku = cellStr(r[1]);
      const isDiscount = /discount|applied to preceding|coupon/i.test(detail ?? "") || /^\d+%/.test(detail ?? "") || /discount|coupon/i.test(desc);
      const isDeposit = /deposit/i.test(desc);
      const key = desc.toUpperCase().replace(/\s+/g, " ");
      const category = isDeposit ? "deposit" : isDiscount ? "discount" : (categories.get(key) ?? null);
      const qty = units.isZero() ? new Decimal(1) : units;
      lines.push({
        description: desc,
        vendor_sku: sku && !/illegible/i.test(sku) ? sku : null,
        pack_size_text: detail,
        quantity: qty.toFixed(4),
        unit_price: amount ? amount.abs().div(qty.abs()).toFixed(4) : null,
        extended_price: amount ? amount.toFixed(2) : null,
        category_guess: category,
      });
    }
    receipts.push({
      sheet: name,
      business,
      transaction,
      invoiceNumber: tx.invoiceNumber ?? name,
      invoiceDate: tx.date ?? summaryDates.get(name) ?? null,
      note,
      tallies,
      subtotal: t.subtotal?.toFixed(2) ?? null,
      tax: t.tax?.toFixed(2) ?? null,
      total: t.total?.toFixed(2) ?? null,
      lines,
    });
  }
  return receipts;
}

export async function importRestaurantDepot(svc: ServiceClient, opts: ImportOptions): Promise<ImportedReceipt[]> {
  const log = opts.log ?? (() => {});
  const categories = loadCategoryIndex(opts.itemsPath);
  const receipts = parseReceiptsWorkbook(opts.receiptsPath, categories);
  const out: ImportedReceipt[] = [];
  for (const rc of receipts) {
    if (opts.business && !rc.business.toLowerCase().includes(opts.business.toLowerCase())) {
      log("import: skipped (business filter)", { sheet: rc.sheet, business: rc.business });
      continue;
    }
    if (rc.lines.length === 0) {
      log("import: skipped (no lines)", { sheet: rc.sheet });
      continue;
    }
    const meta: Json = {
      source: "restaurant-depot-xlsx",
      workbook: opts.receiptsPath.split(/[\\/]/).pop() ?? opts.receiptsPath,
      sheet: rc.sheet,
      business: rc.business,
      transaction: rc.transaction,
      tallies: rc.tallies,
      note: rc.note,
      lines: rc.lines as unknown as Json,
    };
    const created = await createManualInvoiceDocument(svc, {
      locationId: opts.locationId,
      source: "manual",
      vendorName: VENDOR_NAME,
      invoiceDate: rc.invoiceDate,
      invoiceNumber: rc.invoiceNumber,
      subtotal: rc.subtotal,
      tax: rc.tax,
      total: rc.total,
      lines: rc.lines,
      meta,
      contentKey: { vendor: VENDOR_NAME, sheet: rc.sheet, transaction: rc.transaction, lines: rc.lines },
    });
    log(created.duplicate ? "import: duplicate" : "import: created", { sheet: rc.sheet, documentId: created.documentId, lines: rc.lines.length });
    const res = await runInvoicePipeline(svc, created.documentId, { log });
    out.push({
      sheet: rc.sheet,
      business: rc.business,
      invoiceNumber: rc.invoiceNumber ?? rc.sheet,
      invoiceDate: rc.invoiceDate,
      lines: rc.lines.length,
      documentId: created.documentId,
      duplicate: created.duplicate,
      status: res.status,
      mapped: res.mapped,
      unmapped: res.unmapped,
    });
  }
  return out;
}
