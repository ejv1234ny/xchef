import { z } from "zod";
import { COLUMN_ROLES, cellStr, type Cell, type ColumnMap, type ColumnRole, type Row } from "@/lib/core/sheets";
import { MODELS, runTool, type ToolCallResult } from "./anthropic";

/**
 * Haiku maps an unknown spreadsheet header to column roles. Called once per
 * (tenant, header fingerprint); the answer is stored in vendor_sheet_layouts.
 */
export const SheetMapSchema = z.object({
  columns: z.array(
    z.object({
      index: z.number().int().min(0),
      role: z.enum(COLUMN_ROLES as [ColumnRole, ...ColumnRole[]]),
    }),
  ),
  vendor_name_guess: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
  notes: z.string().nullable().optional(),
});
export type SheetMap = z.infer<typeof SheetMapSchema>;

const TOOL_SCHEMA = {
  properties: {
    columns: {
      type: "array",
      description: "One entry per column of the header row, in order. Use 'ignore' for anything that is not one of the other roles.",
      items: {
        type: "object",
        properties: {
          index: { type: "integer", minimum: 0, description: "0-based column index in the header row" },
          role: { type: "string", enum: COLUMN_ROLES },
        },
        required: ["index", "role"],
        additionalProperties: false,
      },
    },
    vendor_name_guess: { type: ["string", "null"], description: "The distributor this export came from, if the header, filename or rows make it obvious (Sysco, US Foods, PFG, Restaurant Depot, …); else null" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    notes: { type: ["string", "null"] },
  },
  required: ["columns", "confidence"],
  additionalProperties: false,
};

const SYSTEM = `You map the columns of a US foodservice distributor spreadsheet export (invoice export, order guide, receipt transcription) to a fixed set of roles so the rows can be turned into invoice lines.
Roles: vendor_sku (the vendor's item/product code), description (product name), pack_size (pack/size text like "6/#10", "12/750ML", "40 LB"), quantity (units shipped/received — prefer shipped over ordered), unit_price (price per invoice unit), extended_price (line amount), invoice_number, invoice_date, vendor_name, ignore.
Assign each role at most once. If both "ordered" and "shipped" quantities exist, shipped is quantity and ordered is ignore. Brand, category, UPC, GTIN, tax flags, weights, and totals columns are ignore. Be honest in confidence.`;

export async function mapSheetColumns(input: { headerCells: Row; sampleRows: Row[]; filename: string; sheetName: string }): Promise<ToolCallResult<SheetMap> & { columnMap: ColumnMap }> {
  const header = input.headerCells.map((c, i) => `${i}: ${JSON.stringify(cellStr(c))}`).join("\n");
  const rows = input.sampleRows
    .slice(0, 5)
    .map((r, ri) => `row ${ri + 1}: ${r.map((c: Cell) => JSON.stringify(cellStr(c))).join(" | ")}`)
    .join("\n");
  const result = await runTool<SheetMap>({
    model: MODELS.haiku,
    system: SYSTEM,
    content: [{ type: "text", text: `File: ${input.filename}\nSheet: ${input.sheetName}\n\nHeader row (index: title):\n${header}\n\nFirst data rows:\n${rows}\n\nMap the columns with the map_columns tool.` }],
    toolName: "map_columns",
    toolDescription: "Assign a role to every column of the header row.",
    inputSchema: TOOL_SCHEMA,
    schema: SheetMapSchema,
    maxTokens: 1024,
  });
  const columnMap: ColumnMap = {};
  const taken = new Set<ColumnRole>();
  for (const c of result.data.columns) {
    if (c.index >= input.headerCells.length) continue;
    if (c.role !== "ignore" && taken.has(c.role)) {
      columnMap[String(c.index)] = "ignore";
      continue;
    }
    columnMap[String(c.index)] = c.role;
    if (c.role !== "ignore") taken.add(c.role);
  }
  input.headerCells.forEach((c, i) => {
    if (!(String(i) in columnMap) && cellStr(c) !== "") columnMap[String(i)] = "ignore";
  });
  return { ...result, columnMap };
}
