import { COLUMN_ROLES, type ColumnMap, type ColumnRole, type Row } from "@/lib/core/sheets";
import type { SpreadsheetExtraction } from "@/lib/jobs/parseSpreadsheet";

const ROLE_LABEL: Record<ColumnRole, string> = {
  vendor_sku: "SKU",
  description: "Description",
  pack_size: "Pack size",
  quantity: "Quantity",
  unit_price: "Unit price",
  extended_price: "Line total",
  invoice_number: "Invoice #",
  invoice_date: "Invoice date",
  vendor_name: "Vendor",
  ignore: "— ignore —",
};

export function isSpreadsheetExtraction(x: unknown): x is SpreadsheetExtraction {
  return Boolean(x) && typeof x === "object" && (x as { kind?: unknown }).kind === "spreadsheet" && Array.isArray((x as { preview_rows?: unknown }).preview_rows);
}

/**
 * Spreadsheet-origin documents show the source rows instead of an image. The
 * header row is a row of <select>s, one per column, prefilled with the
 * detected role; saving re-parses the file with the new roles and re-runs
 * mapping (the layout is remembered for every future export with this header).
 */
export function SheetReview({ extraction, documentId, action }: { extraction: SpreadsheetExtraction; documentId: string; action: (formData: FormData) => Promise<void> }) {
  const rows: Row[] = extraction.preview_rows;
  const headerIdx = extraction.header_row_index;
  const header = rows[headerIdx] ?? [];
  const width = Math.max(header.length, ...rows.map((r) => r.length));
  const map: ColumnMap = extraction.layout.column_map ?? {};
  const dataRows = rows.slice(headerIdx + 1);
  const metaRows = rows.slice(0, headerIdx);
  const sourceLabel: Record<string, string> = {
    builtin: "known layout",
    saved: "remembered layout",
    ai: "mapped by AI",
    heuristic: "guessed from headers",
    human: "confirmed by you",
  };

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="document_id" value={documentId} />
      <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-600">
        <span className="rounded-full bg-neutral-100 px-2 py-1">{extraction.filename}</span>
        <span className="rounded-full bg-neutral-100 px-2 py-1">sheet “{extraction.sheet}”</span>
        <span className="rounded-full bg-neutral-100 px-2 py-1">
          {extraction.line_count} line{extraction.line_count === 1 ? "" : "s"} from {extraction.row_count} rows
        </span>
        <span className={`rounded-full px-2 py-1 ${extraction.layout.source === "ai" || extraction.layout.source === "heuristic" ? "bg-violet-100 text-violet-900" : "bg-emerald-100 text-emerald-900"}`}>
          {sourceLabel[extraction.layout.source] ?? extraction.layout.source}
          {extraction.layout.confidence != null && extraction.layout.source !== "human" && extraction.layout.source !== "builtin" ? ` · ${Math.round(extraction.layout.confidence * 100)}%` : ""}
        </span>
        {extraction.groups > 1 ? <span className="rounded-full bg-amber-100 px-2 py-1 text-amber-900">{extraction.groups} invoices in this file</span> : null}
      </div>
      <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
        <table className="min-w-full text-xs">
          <thead>
            <tr className="bg-neutral-50">
              <th className="px-2 py-1 text-left text-neutral-400">#</th>
              {Array.from({ length: width }, (_, i) => (
                <th key={i} className="px-1 py-1 text-left align-top">
                  <div className="truncate text-[11px] font-medium text-neutral-700" title={String(header[i] ?? "")}>
                    {String(header[i] ?? "") || `col ${i + 1}`}
                  </div>
                  <select name={`col_${i}`} defaultValue={map[String(i)] ?? "ignore"} className="mt-1 h-9 w-full min-w-28 rounded-lg border border-neutral-300 bg-white px-1 text-xs">
                    {COLUMN_ROLES.map((r) => (
                      <option key={r} value={r}>
                        {ROLE_LABEL[r]}
                      </option>
                    ))}
                  </select>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metaRows.map((r, ri) => (
              <tr key={`m${ri}`} className="text-neutral-400">
                <td className="px-2 py-1">{ri + 1}</td>
                {Array.from({ length: width }, (_, i) => (
                  <td key={i} className="max-w-56 truncate px-1 py-1" title={String(r[i] ?? "")}>
                    {String(r[i] ?? "")}
                  </td>
                ))}
              </tr>
            ))}
            {dataRows.map((r, ri) => {
              const skipped = extraction.skipped.find((s) => s.row_index === headerIdx + 1 + ri);
              return (
                <tr key={ri} className={skipped ? "text-neutral-400 line-through" : ""} title={skipped ? `skipped: ${skipped.reason}` : undefined}>
                  <td className="px-2 py-1 tabular-nums">{headerIdx + 2 + ri}</td>
                  {Array.from({ length: width }, (_, i) => (
                    <td key={i} className={`max-w-56 truncate px-1 py-1 ${map[String(i)] && map[String(i)] !== "ignore" ? "" : "text-neutral-400"}`} title={String(r[i] ?? "")}>
                      {String(r[i] ?? "")}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length < extraction.row_count ? <p className="text-xs text-neutral-500">Showing the first {rows.length} of {extraction.row_count} rows.</p> : null}
      <div className="flex items-center gap-3">
        <button className="h-12 rounded-xl bg-neutral-900 px-5 text-sm font-medium text-white">Save column roles &amp; re-read</button>
        <p className="text-xs text-neutral-600">Re-reading rewrites this invoice’s lines from the sheet; confirmed mappings are re-applied by SKU.</p>
      </div>
    </form>
  );
}
