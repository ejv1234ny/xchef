import { createHash } from "node:crypto";
import * as XLSX from "xlsx";
import { parse as parseCsv } from "csv-parse/sync";
import Decimal from "decimal.js";

/**
 * Spreadsheet invoices (csv / tsv / xlsx / xls) — pure parsing and column
 * mapping, no I/O. The job in lib/jobs/parseSpreadsheet.ts decides where a
 * column map comes from (saved layout → known layout → Haiku → heuristic);
 * everything here is deterministic given a map.
 */

export type ColumnRole =
  | "vendor_sku"
  | "description"
  | "pack_size"
  | "quantity"
  | "unit_price"
  | "extended_price"
  | "invoice_number"
  | "invoice_date"
  | "vendor_name"
  | "ignore";

export const COLUMN_ROLES: ColumnRole[] = [
  "vendor_sku",
  "description",
  "pack_size",
  "quantity",
  "unit_price",
  "extended_price",
  "invoice_number",
  "invoice_date",
  "vendor_name",
  "ignore",
];

/** `{ "<column index>": role }` — column indexes as strings so it round-trips through jsonb. */
export type ColumnMap = Record<string, ColumnRole>;

export type Cell = string | number | boolean | null;
export type Row = Cell[];
export type SheetData = { name: string; rows: Row[] };

export const SPREADSHEET_MIMES = {
  "text/csv": "csv",
  "text/tab-separated-values": "tsv",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
} as const;

export function spreadsheetExt(mimeType: string, filename: string): "csv" | "tsv" | "xlsx" | "xls" | null {
  const m = mimeType.toLowerCase().split(";")[0].trim() as keyof typeof SPREADSHEET_MIMES;
  if (SPREADSHEET_MIMES[m]) return SPREADSHEET_MIMES[m];
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return ext === "csv" || ext === "tsv" || ext === "xlsx" || ext === "xls" ? ext : null;
}

export function isSpreadsheet(mimeType: string, filename: string): boolean {
  return spreadsheetExt(mimeType, filename) !== null;
}

export function cellStr(c: Cell | undefined): string {
  return c == null ? "" : String(c).trim();
}

/** Read every sheet as rows of formatted strings. CSV/TSV via csv-parse, Excel via SheetJS. */
export function readSpreadsheet(bytes: Uint8Array, mimeType: string, filename: string): SheetData[] {
  const ext = spreadsheetExt(mimeType, filename);
  if (!ext) throw new Error(`not a spreadsheet: ${filename} (${mimeType})`);
  if (ext === "csv" || ext === "tsv") {
    let text = Buffer.from(bytes).toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    const delimiter = ext === "tsv" ? "\t" : text.split("\n")[0]?.includes("\t") && !text.split("\n")[0]?.includes(",") ? "\t" : ",";
    const rows = parseCsv(text, { delimiter, relax_column_count: true, relax_quotes: true, skip_empty_lines: false, trim: true, bom: true }) as string[][];
    return [{ name: filename, rows: rows.map((r) => r.map((c) => (c === "" ? null : c))) }];
  }
  const wb = XLSX.read(bytes, { type: "array", cellDates: false });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const rows = ws ? XLSX.utils.sheet_to_json<Row>(ws, { header: 1, raw: false, defval: null, blankrows: true }) : [];
    return { name, rows };
  });
}

// ---------------------------------------------------------------------------
// Header detection, fingerprinting, deterministic layouts
// ---------------------------------------------------------------------------

export function normalizeHeaderCell(c: Cell | undefined): string {
  return cellStr(c)
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/[^a-z0-9#/.\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeHeader(cells: Row): string[] {
  const out = cells.map(normalizeHeaderCell);
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/** Stable identity of a header row: sha256 of the normalized cells joined by '|'. */
export function fingerprintHeader(cells: Row): string {
  return createHash("sha256").update(normalizeHeader(cells).join("|")).digest("hex");
}

const ROLE_SYNONYMS: Array<{ role: ColumnRole; re: RegExp }> = [
  { role: "vendor_sku", re: /^(item ?(#|no\.?|number|code|id)|sku|supc|product ?(#|no\.?|number|code|id)|material( no\.?)?|code|part ?(#|no\.?))$/ },
  { role: "description", re: /^((product|item|line|material) ?desc(ription)?|description|desc|product name|item name|product|item)$/ },
  { role: "pack_size", re: /^(pack ?\/? ?size|pack ?\/ ?detail|pack ?size|pack|size|unit size|packaging|pack ?\/ ?uom|uom|unit of measure|detail)$/ },
  // "ordered" quantities are deliberately NOT a synonym: shipped/received is what arrived; an ordered column is ignored.
  { role: "quantity", re: /^(qty|quantity|qty ?(shipped|ship|shp|delivered|del|rec(eive)?d)|shipped|ship ?qty|units|cases)$/ },
  { role: "unit_price", re: /^(price|unit ?price|case ?price|each ?price|cost|unit ?cost|price ?each|price ?\/ ?unit|net ?price)$/ },
  { role: "extended_price", re: /^(amount|ext(ended)? ?(price|amt|amount|cost)?|ext\.? ?(amt|price)|extension|total|line ?total|net ?amount|amt|total ?price|total ?cost)$/ },
  { role: "invoice_number", re: /^(invoice ?(#|no\.?|number|num|id)|inv ?(#|no\.?|number)|invoice|order ?(#|no\.?|number)|po ?(#|number)?|receipt ?(#|no\.?)?)$/ },
  { role: "invoice_date", re: /^(invoice ?date|inv ?date|date|delivery ?date|ship(ped)? ?date|order ?date|receipt ?date|trans(action)? ?date)$/ },
  { role: "vendor_name", re: /^(vendor|supplier|vendor ?name|supplier ?name|distributor|seller)$/ },
];

export function roleForHeaderCell(cell: Cell | undefined): ColumnRole | null {
  const n = normalizeHeaderCell(cell);
  if (!n) return null;
  for (const { role, re } of ROLE_SYNONYMS) if (re.test(n)) return role;
  return null;
}

/**
 * Header row = the first row whose cells look like column titles: at least two
 * cells match a known role synonym, or (fallback) at least three non-empty
 * text cells followed by a row that contains a number. Returns -1 when none.
 */
export function detectHeaderRow(rows: Row[], maxScan = 40): number {
  const limit = Math.min(rows.length, maxScan);
  for (let i = 0; i < limit; i++) {
    const r = rows[i];
    if (!r) continue;
    const nonEmpty = r.filter((c) => cellStr(c) !== "");
    if (nonEmpty.length < 2) continue;
    const roles = new Set(r.map(roleForHeaderCell).filter(Boolean));
    if (roles.size >= 2 && (roles.has("description") || roles.has("vendor_sku"))) return i;
  }
  for (let i = 0; i < limit; i++) {
    const r = rows[i];
    if (!r) continue;
    const texts = r.filter((c) => cellStr(c) !== "" && Number.isNaN(Number(cellStr(c).replace(/[$,]/g, ""))));
    const next = rows[i + 1];
    const nextHasNumber = next?.some((c) => cellStr(c) !== "" && !Number.isNaN(Number(cellStr(c).replace(/[$,()]/g, ""))));
    if (texts.length >= 3 && nextHasNumber) return i;
  }
  return -1;
}

/** Deterministic map from header synonyms. `matched` counts columns that got a role other than ignore. */
export function inferColumnMap(headerCells: Row): { map: ColumnMap; matched: number } {
  const map: ColumnMap = {};
  const taken = new Set<ColumnRole>();
  let matched = 0;
  headerCells.forEach((c, i) => {
    const role = roleForHeaderCell(c);
    if (role && !taken.has(role)) {
      map[String(i)] = role;
      taken.add(role);
      matched++;
    } else if (cellStr(c) !== "") map[String(i)] = "ignore";
  });
  return { map, matched };
}

export function columnMapIsUsable(map: ColumnMap): boolean {
  const roles = new Set(Object.values(map));
  return roles.has("description") && (roles.has("quantity") || roles.has("extended_price"));
}

export type SheetMeta = {
  invoice_number?: string | null;
  invoice_date?: string | null;
  vendor_name?: string | null;
  subtotal?: string | null;
  tax?: string | null;
  total?: string | null;
};

export type KnownLayout = {
  id: string;
  label: string;
  vendor: string | null;
  /** normalized header cells, in order; the sheet's header must contain them in order */
  headers: string[];
  map: ColumnMap;
  /** rows above the header can carry invoice number/date/tallies */
  meta?: (rows: Row[], headerIdx: number) => SheetMeta;
  /** a description matching this ends the line list */
  footer?: RegExp;
};

/** "C16 I15336 OP288797  08-05-26 08:06" → { invoiceNumber: "I15336", date: "2026-08-05" } (Restaurant Depot receipts) */
export function parseTransactionLine(s: string): { invoiceNumber: string | null; date: string | null } {
  const inv = s.match(/\bI(\d+)\b/);
  const d = s.match(/\b(\d{2})-(\d{2})-(\d{2})\b/);
  return { invoiceNumber: inv ? `I${inv[1]}` : null, date: d ? `20${d[3]}-${d[1]}-${d[2]}` : null };
}

function rdMeta(rows: Row[], headerIdx: number): SheetMeta {
  const meta: SheetMeta = {};
  for (let i = 0; i < headerIdx; i++) {
    const a = cellStr(rows[i]?.[0]);
    const b = cellStr(rows[i]?.[1]);
    if (a === "Transaction") {
      const tx = parseTransactionLine(b);
      meta.invoice_number = tx.invoiceNumber;
      meta.invoice_date = tx.date;
    } else if (a === "Receipt tallies") {
      const grab = (re: RegExp) => b.match(re)?.[1] ?? null;
      meta.subtotal = grab(/Subtotal\s*\$?([\d,.]+)/i)?.replace(/,/g, "") ?? null;
      meta.tax = grab(/Tax\s*\$?([\d,.]+)/i)?.replace(/,/g, "") ?? null;
      meta.total = grab(/(?:^|[^a-z])Total\s*\$?([\d,.]+)/i)?.replace(/,/g, "") ?? null;
    }
  }
  return meta;
}

/**
 * Deterministic layouts. Add one entry per vendor export as fixtures arrive
 * (Sysco / US Foods / PFG "order guide" and "invoice export" layouts are
 * pending real samples; until then their exports go through Haiku once and
 * are then remembered in vendor_sheet_layouts).
 */
export const KNOWN_LAYOUTS: KnownLayout[] = [
  {
    id: "restaurant-depot-receipt",
    label: "Restaurant Depot receipt (transcribed)",
    vendor: "Restaurant Depot",
    headers: ["description", "item code", "pack / detail", "units", "amount"],
    map: { "0": "description", "1": "vendor_sku", "2": "pack_size", "3": "quantity", "4": "extended_price" },
    meta: rdMeta,
    footer: /^(sum of legible|printed receipt total)/i,
  },
  {
    id: "restaurant-depot-items",
    label: "Restaurant Depot items by category",
    vendor: "Restaurant Depot",
    headers: ["item", "detail", "qty", "amount", "source receipt"],
    map: { "0": "description", "1": "pack_size", "2": "quantity", "3": "extended_price", "4": "ignore" },
  },
];

export function matchKnownLayout(headerCells: Row): KnownLayout | null {
  const norm = normalizeHeader(headerCells);
  for (const layout of KNOWN_LAYOUTS) {
    let pos = 0;
    for (const h of layout.headers) {
      const idx = norm.indexOf(h, pos);
      if (idx === -1) {
        pos = -1;
        break;
      }
      pos = idx + 1;
    }
    if (pos !== -1) return layout;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export type SheetLine = {
  row_index: number;
  vendor_sku: string | null;
  description: string;
  pack_size_text: string | null;
  quantity: string;
  unit_price: string | null;
  extended_price: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  vendor_name: string | null;
  category_guess: string | null;
};

export type SkippedRow = { row_index: number; reason: string };

/** "$1,234.56" → 1234.56; "($53.38)" → -53.38; "-" / "—" / "" → null */
export function parseMoney(c: Cell | undefined): Decimal | null {
  const s = cellStr(c);
  if (!s || s === "—" || s === "-" || s === "–") return null;
  const neg = /^\(.*\)$/.test(s) || /^-/.test(s) || /-$/.test(s) || /\bcr\b/i.test(s);
  const digits = s.replace(/[^0-9.]/g, "");
  if (!digits || digits === ".") return null;
  const d = new Decimal(digits);
  return neg ? d.negated() : d;
}

export function parseQuantity(c: Cell | undefined): Decimal | null {
  const s = cellStr(c);
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/-?\d+(\.\d+)?/);
  if (!m) return null;
  return new Decimal(m[0]);
}

/** Accepts 2026-08-05, 08/05/2026, 8/5/26, 08-05-26, "Aug 5, 2026", Excel serials. Returns YYYY-MM-DD or null. */
export function parseDateCell(c: Cell | undefined): string | null {
  if (c == null) return null;
  if (typeof c === "number" && c > 20000 && c < 80000) {
    const d = new Date(Date.UTC(1899, 11, 30) + c * 86400_000);
    return d.toISOString().slice(0, 10);
  }
  const s = cellStr(c);
  if (!s) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
  m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
  }
  const t = Date.parse(s);
  if (!Number.isNaN(t)) return new Date(t).toISOString().slice(0, 10);
  return null;
}

const TOTALS_RE = /^\s*(sub-?\s*total|total|grand total|invoice total|tax|sales tax|nys? tax|vt tax|balance( due)?|amount due|net due|freight|sum of|printed receipt total|page \d)/i;
const FEE_RE = /\b(deposit|surcharge|fuel|delivery (fee|charge)|service (fee|charge)|freight|shipping|handling)\b/i;
const DISCOUNT_RE = /\b(discount|coupon|rebate|credit memo|promo)\b/i;
const TAX_RE = /^\s*(sales )?tax\b/i;

export function categoryGuessFor(description: string, packText: string | null): string | null {
  const s = `${description} ${packText ?? ""}`;
  if (TAX_RE.test(description)) return "tax";
  if (/deposit/i.test(s)) return "deposit";
  if (FEE_RE.test(s)) return "fee";
  if (DISCOUNT_RE.test(s)) return "discount";
  return null;
}

/**
 * Apply a column map to the rows after the header. Empty rows are skipped,
 * totals/tax/balance rows are ignored (a "description" that names a total
 * with no SKU and no unit quantity), a footer regex stops the scan.
 */
export function extractLines(rows: Row[], headerIdx: number, map: ColumnMap, opts: { footer?: RegExp; meta?: SheetMeta } = {}): { lines: SheetLine[]; skipped: SkippedRow[] } {
  const col = (role: ColumnRole): number[] =>
    Object.entries(map)
      .filter(([, r]) => r === role)
      .map(([i]) => Number(i));
  const first = (row: Row, role: ColumnRole): Cell | undefined => {
    for (const i of col(role)) if (cellStr(row[i]) !== "") return row[i];
    return undefined;
  };
  const lines: SheetLine[] = [];
  const skipped: SkippedRow[] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    if (row.every((c) => cellStr(c) === "")) continue;
    const description = cellStr(first(row, "description"));
    const sku = cellStr(first(row, "vendor_sku")) || null;
    if (opts.footer && description && opts.footer.test(description)) break;
    const qtyD = parseQuantity(first(row, "quantity"));
    const ext = parseMoney(first(row, "extended_price"));
    const unit = parseMoney(first(row, "unit_price"));
    if (!description && !sku) {
      skipped.push({ row_index: i, reason: ext ? "amount without description (totals?)" : "no description" });
      continue;
    }
    if (description && TOTALS_RE.test(description) && !sku && (qtyD == null || qtyD.isZero())) {
      skipped.push({ row_index: i, reason: "totals row" });
      continue;
    }
    if (description.startsWith("…") || description.startsWith("...")) {
      skipped.push({ row_index: i, reason: "gap marker" });
      continue;
    }
    if (qtyD == null && ext == null && unit == null) {
      skipped.push({ row_index: i, reason: "no quantity or amount" });
      continue;
    }
    let qty = qtyD ?? new Decimal(ext && ext.isNegative() ? -1 : 1);
    if (qty.isZero()) qty = new Decimal(1);
    const extended = ext ?? (unit ? unit.times(qty) : null);
    const unitPrice = unit ?? (extended ? extended.abs().div(qty.abs()) : null);
    const pack = cellStr(first(row, "pack_size")) || null;
    lines.push({
      row_index: i,
      vendor_sku: sku && !/illegible|n\/a/i.test(sku) ? sku : null,
      description: description || `(SKU ${sku})`,
      pack_size_text: pack,
      quantity: qty.toFixed(4),
      unit_price: unitPrice ? unitPrice.abs().toFixed(4) : null,
      extended_price: extended ? extended.toFixed(2) : null,
      invoice_number: cellStr(first(row, "invoice_number")) || opts.meta?.invoice_number || null,
      invoice_date: parseDateCell(first(row, "invoice_date")) ?? opts.meta?.invoice_date ?? null,
      vendor_name: cellStr(first(row, "vendor_name")) || opts.meta?.vendor_name || null,
      category_guess: categoryGuessFor(description, pack),
    });
  }
  return { lines, skipped };
}

export type InvoiceGroup = { key: string; invoice_number: string | null; invoice_date: string | null; vendor_name: string | null; lines: SheetLine[] };

/** One group per (invoice_number, invoice_date); a sheet with neither is one group. */
export function groupByInvoice(lines: SheetLine[]): InvoiceGroup[] {
  const groups = new Map<string, InvoiceGroup>();
  for (const l of lines) {
    const key = `${l.invoice_number ?? ""}|${l.invoice_date ?? ""}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, invoice_number: l.invoice_number, invoice_date: l.invoice_date, vendor_name: l.vendor_name, lines: [] };
      groups.set(key, g);
    }
    if (!g.vendor_name && l.vendor_name) g.vendor_name = l.vendor_name;
    g.lines.push(l);
  }
  return [...groups.values()];
}

export function sumExtended(lines: SheetLine[], excludeCategories = new Set(["tax"])): string {
  return lines
    .filter((l) => !excludeCategories.has(l.category_guess ?? ""))
    .reduce((a, l) => a.plus(l.extended_price ?? 0), new Decimal(0))
    .toFixed(2);
}

/** A human-readable one-liner for the review screen. */
export function describeColumnMap(headerCells: Row, map: ColumnMap): string {
  return Object.entries(map)
    .filter(([, r]) => r !== "ignore")
    .map(([i, r]) => `${cellStr(headerCells[Number(i)]) || `col ${i}`} → ${r}`)
    .join(", ");
}
