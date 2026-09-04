import Decimal from "decimal.js";
import type { ServiceClient } from "@/lib/db/service";
import type { Database, Json, Tables } from "@/lib/db/types";
import { logLlmCall } from "@/lib/llm/anthropic";
import { isLlmConfigured, selectedProviderName } from "@/lib/llm/provider";
import { modelFor } from "@/lib/llm/models";
import { mapSheetColumns } from "@/lib/llm/sheet-map";
import {
  columnMapIsUsable,
  describeColumnMap,
  detectHeaderRow,
  extractLines,
  fingerprintHeader,
  groupByInvoice,
  inferColumnMap,
  matchKnownLayout,
  readSpreadsheet,
  sumExtended,
  cellStr,
  type ColumnMap,
  type InvoiceGroup,
  type Row,
  type SheetLine,
  type SheetMeta,
} from "@/lib/core/sheets";
import { downloadInvoiceBytes } from "@/lib/storage";
import { normalizeMime } from "@/lib/llm/invoice-parse";
import { emailDomain, findOrCreateVendor, getLocation, sha256, type Logger } from "./intake";

/**
 * Spreadsheet parse job — the deterministic sibling of parseInvoice.ts. A
 * csv/tsv/xlsx/xls document goes: read sheets → find the header → resolve a
 * column map (saved layout → known layout → Haiku → header heuristic) → lines
 * → one invoice_documents row per (invoice_number, invoice_date) group (the
 * first group reuses this document; extra groups become sibling documents
 * pointing at the same stored file) → then the normal map → post jobs.
 *
 * raw_extraction records the layout used, row counts, a preview of the source
 * rows for the review screen, and sibling document ids.
 */
export type LayoutSource = "builtin" | "saved" | "ai" | "heuristic" | "human";

export type SpreadsheetParseResult = {
  status: Database["public"]["Enums"]["invoice_status"];
  lines: number;
  documents: string[];
  layout: LayoutSource | "none";
  error: string | null;
};

export type SpreadsheetExtraction = {
  kind: "spreadsheet";
  filename: string;
  sheet: string;
  header_row_index: number;
  header: string[];
  fingerprint: string;
  layout: { id: string | null; source: LayoutSource; column_map: ColumnMap; confidence: number | null; label: string };
  row_count: number;
  line_count: number;
  skipped: Array<{ row_index: number; reason: string }>;
  preview_rows: Row[];
  groups: number;
  group_key: string;
  parent_document_id: string | null;
  sibling_document_ids: string[];
};

const PREVIEW_ROWS = 60;

type ResolvedLayout = { id: string | null; source: LayoutSource; map: ColumnMap; confidence: number | null; label: string; vendorName: string | null; meta?: SheetMeta; footer?: RegExp };

async function resolveLayout(
  svc: ServiceClient,
  tenantId: string,
  headerCells: Row,
  sampleRows: Row[],
  ctx: { filename: string; sheetName: string; documentId: string; rows: Row[]; headerIdx: number; vendorId: string | null },
  log: Logger,
): Promise<ResolvedLayout> {
  const fingerprint = fingerprintHeader(headerCells);
  const headerNorm = headerCells.map((c) => cellStr(c));

  const { data: saved } = await svc.from("vendor_sheet_layouts").select("*").eq("tenant_id", tenantId).eq("header_fingerprint", fingerprint).maybeSingle();
  if (saved) {
    const map = saved.column_map as ColumnMap;
    const known = matchKnownLayout(headerCells);
    let vendorName: string | null = null;
    if (saved.vendor_id) {
      const { data: v } = await svc.from("vendors").select("name").eq("id", saved.vendor_id).maybeSingle();
      vendorName = v?.name ?? null;
    }
    return {
      id: saved.id,
      source: saved.source === "human" ? "human" : "saved",
      map,
      confidence: saved.confidence,
      label: saved.source === "human" ? "column roles confirmed by you" : known ? known.label : `remembered layout (${saved.source})`,
      vendorName: vendorName ?? known?.vendor ?? null,
      meta: known?.meta?.(ctx.rows, ctx.headerIdx),
      footer: known?.footer,
    };
  }

  const known = matchKnownLayout(headerCells);
  if (known) {
    const { data: row } = await svc
      .from("vendor_sheet_layouts")
      .insert({ tenant_id: tenantId, vendor_id: ctx.vendorId, header_fingerprint: fingerprint, header_cells: headerNorm, column_map: known.map as unknown as Json, source: "builtin", confidence: 1 })
      .select("id")
      .single();
    return { id: row?.id ?? null, source: "builtin", map: known.map, confidence: 1, label: known.label, vendorName: known.vendor, meta: known.meta?.(ctx.rows, ctx.headerIdx), footer: known.footer };
  }

  if (isLlmConfigured()) {
    try {
      const ai = await mapSheetColumns({ headerCells, sampleRows, filename: ctx.filename, sheetName: ctx.sheetName });
      await logLlmCall(svc, { tenant_id: tenantId, kind: "sheet-map", ref_id: ctx.documentId, model: ai.model, provider: ai.provider, usage: ai.usage, raw: ai.raw });
      if (columnMapIsUsable(ai.columnMap)) {
        const { data: row } = await svc
          .from("vendor_sheet_layouts")
          .insert({ tenant_id: tenantId, vendor_id: ctx.vendorId, header_fingerprint: fingerprint, header_cells: headerNorm, column_map: ai.columnMap as unknown as Json, source: "ai", confidence: Number(ai.data.confidence.toFixed(2)) })
          .select("id")
          .single();
        return { id: row?.id ?? null, source: "ai", map: ai.columnMap, confidence: ai.data.confidence, label: "columns mapped by AI — check the headers", vendorName: ai.data.vendor_name_guess ?? null };
      }
      log("sheet-parse: ai map unusable, falling back to heuristic", { documentId: ctx.documentId });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await logLlmCall(svc, { tenant_id: tenantId, kind: "sheet-map", ref_id: ctx.documentId, model: modelFor(selectedProviderName(), "sheet-map"), provider: selectedProviderName(), error: msg });
      log("sheet-parse: ai map failed, falling back to heuristic", { documentId: ctx.documentId, error: msg });
    }
  }

  const inferred = inferColumnMap(headerCells);
  if (!columnMapIsUsable(inferred.map)) throw new Error(`could not map columns of "${ctx.sheetName}": header ${JSON.stringify(headerNorm)}`);
  const { data: row } = await svc
    .from("vendor_sheet_layouts")
    .insert({ tenant_id: tenantId, vendor_id: ctx.vendorId, header_fingerprint: fingerprint, header_cells: headerNorm, column_map: inferred.map as unknown as Json, source: "heuristic", confidence: 0.5 })
    .select("id")
    .single();
  return { id: row?.id ?? null, source: "heuristic", map: inferred.map, confidence: 0.5, label: "columns guessed from header names — check them", vendorName: null };
}

type ParsedSheet = { name: string; rows: Row[]; headerIdx: number; headerCells: Row; layout: ResolvedLayout; lines: SheetLine[]; skipped: Array<{ row_index: number; reason: string }> };

function toLineRows(documentId: string, lines: SheetLine[]): Database["public"]["Tables"]["invoice_lines"]["Insert"][] {
  return lines.map((l, i) => ({
    invoice_id: documentId,
    line_no: i + 1,
    vendor_sku: l.vendor_sku,
    description: l.description,
    pack_size_text: l.pack_size_text,
    quantity: Number(new Decimal(l.quantity).toFixed(4)),
    unit_price: l.unit_price == null ? null : Number(new Decimal(l.unit_price).toFixed(4)),
    extended_price: l.extended_price == null ? null : Number(new Decimal(l.extended_price).toFixed(2)),
    ai_category_guess: l.category_guess,
    ai_confidence: null,
    status: "unmapped",
  }));
}

export async function parseSpreadsheetDocumentJob(svc: ServiceClient, documentId: string, opts: { log?: Logger } = {}): Promise<SpreadsheetParseResult> {
  const log = opts.log ?? (() => {});
  const { data: doc, error } = await svc.from("invoice_documents").select("*").eq("id", documentId).maybeSingle();
  if (error) throw new Error(`read invoice_documents: ${error.message}`);
  if (!doc) throw new Error(`document ${documentId} not found`);
  const location = await getLocation(svc, doc.location_id);
  const filename = doc.storage_path.split("/").pop() ?? doc.storage_path;
  const mime = normalizeMime("", filename);

  await svc.from("invoice_documents").update({ status: "parsing", parse_error: null }).eq("id", documentId);

  let sheets: ParsedSheet[] = [];
  try {
    const bytes = await downloadInvoiceBytes(svc, doc.storage_path);
    const raw = readSpreadsheet(bytes, mime, filename);
    for (const s of raw) {
      if (!s.rows.some((r) => r.some((c) => cellStr(c) !== ""))) continue;
      const headerIdx = detectHeaderRow(s.rows);
      if (headerIdx < 0) {
        log("sheet-parse: no header row", { documentId, sheet: s.name });
        continue;
      }
      const headerCells = s.rows[headerIdx];
      const layout = await resolveLayout(svc, location.tenant_id, headerCells, s.rows.slice(headerIdx + 1, headerIdx + 6), { filename, sheetName: s.name, documentId, rows: s.rows, headerIdx, vendorId: doc.vendor_id }, log);
      const { lines, skipped } = extractLines(s.rows, headerIdx, layout.map, { footer: layout.footer, meta: layout.meta });
      sheets.push({ name: s.name, rows: s.rows, headerIdx, headerCells, layout, lines, skipped });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await svc.from("invoice_documents").update({ status: "needs_review", parse_error: `spreadsheet parse failed: ${msg}` }).eq("id", documentId);
    log("sheet-parse: error", { documentId, error: msg });
    return { status: "needs_review", lines: 0, documents: [documentId], layout: "none", error: msg };
  }
  sheets = sheets.filter((s) => s.lines.length > 0);
  if (sheets.length === 0) {
    const msg = "no invoice rows found in the spreadsheet";
    await svc.from("invoice_documents").update({ status: "rejected", parse_error: msg }).eq("id", documentId);
    return { status: "rejected", lines: 0, documents: [documentId], layout: "none", error: msg };
  }

  // Groups across all sheets. Sheet-level meta (Restaurant Depot receipts) already stamped invoice_number/date on each line.
  type GroupWithSheet = InvoiceGroup & { sheet: ParsedSheet };
  const groups: GroupWithSheet[] = [];
  for (const s of sheets) for (const g of groupByInvoice(s.lines)) groups.push({ ...g, sheet: s });

  const primaryLayout = sheets[0].layout;
  const senderDomain = emailDomain(doc.email_from);
  let vendorHint: string | null = null;
  if (doc.vendor_id) {
    const { data: v } = await svc.from("vendors").select("name").eq("id", doc.vendor_id).maybeSingle();
    vendorHint = v?.name ?? null;
  }

  // Wipe lines of this document and any siblings from a previous run (re-parse is idempotent).
  const prev = doc.raw_extraction as Partial<SpreadsheetExtraction> | null;
  const oldSiblings = Array.isArray(prev?.sibling_document_ids) ? prev.sibling_document_ids : [];
  const { data: children } = await svc.from("invoice_documents").select("id").eq("location_id", doc.location_id).like("content_hash", `${doc.content_hash}:%`);
  const wipe = [...new Set([documentId, ...oldSiblings, ...(children ?? []).map((c) => c.id)])];
  const { error: delErr } = await svc.from("invoice_lines").delete().in("invoice_id", wipe);
  if (delErr) throw new Error(`delete invoice_lines: ${delErr.message}`);

  const documents: string[] = [];
  let totalLines = 0;
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const layout = g.sheet.layout;
    const vendorName = g.vendor_name || layout.vendorName || vendorHint || "Unknown vendor";
    const vendor = await findOrCreateVendor(svc, location.tenant_id, vendorName, senderDomain);
    if (layout.id) await svc.from("vendor_sheet_layouts").update({ vendor_id: vendor.id }).eq("id", layout.id).is("vendor_id", null);

    let targetId = documentId;
    if (gi > 0) {
      const hash = sha256(`${doc.content_hash}:${g.key}`);
      const { data: existing } = await svc.from("invoice_documents").select("id").eq("location_id", doc.location_id).eq("content_hash", `${doc.content_hash}:${hash.slice(0, 16)}`).maybeSingle();
      if (existing) targetId = existing.id;
      else {
        const { data: created, error: ierr } = await svc
          .from("invoice_documents")
          .insert({
            location_id: doc.location_id,
            vendor_id: vendor.id,
            source: doc.source,
            status: "parsing",
            storage_path: doc.storage_path,
            email_from: doc.email_from,
            email_subject: doc.email_subject,
            email_message_id: doc.email_message_id,
            content_hash: `${doc.content_hash}:${hash.slice(0, 16)}`,
          })
          .select("id")
          .single();
        if (ierr) throw new Error(`insert sibling invoice_documents: ${ierr.message}`);
        targetId = created.id;
      }
    }
    documents.push(targetId);

    const rows = toLineRows(targetId, g.lines);
    if (rows.length) {
      const { error: insErr } = await svc.from("invoice_lines").insert(rows);
      if (insErr) throw new Error(`insert invoice_lines: ${insErr.message}`);
    }
    totalLines += rows.length;

    const meta = layout.meta;
    const subtotal = meta?.subtotal ?? sumExtended(g.lines);
    const extraction: SpreadsheetExtraction = {
      kind: "spreadsheet",
      filename,
      sheet: g.sheet.name,
      header_row_index: g.sheet.headerIdx,
      header: g.sheet.headerCells.map((c) => cellStr(c)),
      fingerprint: fingerprintHeader(g.sheet.headerCells),
      layout: { id: layout.id, source: layout.source, column_map: layout.map, confidence: layout.confidence, label: layout.label },
      row_count: g.sheet.rows.length,
      line_count: rows.length,
      skipped: g.sheet.skipped,
      preview_rows: g.sheet.rows.slice(0, PREVIEW_ROWS),
      groups: groups.length,
      group_key: g.key,
      parent_document_id: gi === 0 ? null : documentId,
      sibling_document_ids: [],
    };
    const { error: uerr } = await svc
      .from("invoice_documents")
      .update({
        vendor_id: vendor.id,
        status: "needs_review",
        invoice_number: g.invoice_number ?? meta?.invoice_number ?? null,
        invoice_date: g.invoice_date ?? meta?.invoice_date ?? null,
        received_date: g.invoice_date ?? meta?.invoice_date ?? null,
        subtotal: Number(subtotal),
        tax: meta?.tax != null ? Number(meta.tax) : null,
        total: meta?.total != null ? Number(meta.total) : null,
        parse_confidence: layout.source === "ai" || layout.source === "heuristic" ? Number((layout.confidence ?? 0.5).toFixed(2)) : 1,
        parse_error: null,
        raw_extraction: extraction as unknown as Json,
      })
      .eq("id", targetId);
    if (uerr) throw new Error(`update invoice_documents: ${uerr.message}`);
    log("sheet-parse: group", { documentId: targetId, vendor: vendor.name, invoice: g.invoice_number, date: g.invoice_date, lines: rows.length, layout: layout.source, map: describeColumnMap(g.sheet.headerCells, layout.map) });
  }

  // Record siblings on the primary so re-parse and the UI can find them.
  const siblings = documents.slice(1);
  if (siblings.length) {
    const { data: primary } = await svc.from("invoice_documents").select("raw_extraction").eq("id", documentId).single();
    const ex = (primary?.raw_extraction ?? {}) as Record<string, unknown>;
    await svc.from("invoice_documents").update({ raw_extraction: { ...ex, sibling_document_ids: siblings } as unknown as Json }).eq("id", documentId);
  }
  // Any previous sibling not reproduced this time is rejected rather than deleted (audit trail).
  for (const stale of wipe.filter((id) => id !== documentId && !documents.includes(id))) {
    await svc.from("invoice_documents").update({ status: "rejected", parse_error: "superseded by re-parse" }).eq("id", stale);
  }

  return { status: "needs_review", lines: totalLines, documents, layout: primaryLayout.source, error: null };
}

/** Upsert a human-confirmed column map for a header fingerprint (review screen). */
export async function saveHumanSheetLayout(
  svc: ServiceClient,
  input: { tenantId: string; vendorId: string | null; fingerprint: string; headerCells: string[]; columnMap: ColumnMap; userId: string },
): Promise<Tables<"vendor_sheet_layouts">> {
  const { data, error } = await svc
    .from("vendor_sheet_layouts")
    .upsert(
      {
        tenant_id: input.tenantId,
        vendor_id: input.vendorId,
        header_fingerprint: input.fingerprint,
        header_cells: input.headerCells,
        column_map: input.columnMap as unknown as Json,
        source: "human",
        confidence: 1,
        confirmed_by: input.userId,
        confirmed_at: new Date().toISOString(),
      },
      { onConflict: "tenant_id,header_fingerprint" },
    )
    .select("*")
    .single();
  if (error) throw new Error(`save sheet layout: ${error.message}`);
  return data;
}
