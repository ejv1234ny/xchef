"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createServerSupabase } from "@/lib/db/server";
import { createServiceSupabase } from "@/lib/db/service";
import { getAppContext } from "@/lib/db/context";
import { mapInvoiceDocument, postInvoiceIfResolved } from "@/lib/jobs/mapInvoice";
import { runInvoicePipeline } from "@/lib/jobs/intake";
import { saveHumanSheetLayout, type SpreadsheetExtraction } from "@/lib/jobs/parseSpreadsheet";
import { COLUMN_ROLES, type ColumnMap, type ColumnRole } from "@/lib/core/sheets";
import { Constants } from "@/lib/db/types";

const uuid = z.uuid();
const numericText = z
  .string()
  .trim()
  .transform((s) => s.replace(/,/g, ""))
  .refine((s) => /^\d*(\.\d+)?$/.test(s) && s !== "", "Enter a number");

const confirmSchema = z.object({
  document_id: uuid,
  line_id: uuid,
  inventory_item_id: z.string().trim().optional(),
  new_name: z.string().trim().max(120).optional(),
  new_category: z.string().trim().max(60).optional(),
  new_base_unit: z.enum(Constants.public.Enums.uom).optional(),
  units_per_pack: numericText,
  base_units_per_unit: numericText,
  pack_description: z.string().trim().max(120).optional(),
  brand: z.string().trim().max(80).optional(),
});

function back(documentId: string, kind: "ok" | "error", text: string): never {
  redirect(`/invoices/review/${documentId}?${kind}=${encodeURIComponent(text)}`);
}

function field(fd: FormData, name: string): string | undefined {
  const v = fd.get(name);
  return typeof v === "string" ? v : undefined;
}

/** lower-case, whitespace-collapsed description: the fallback mapping key when a vendor has no SKU. */
function normDescription(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** The document, through RLS, so a user can only act on their own location's invoices. */
async function loadDocument(documentId: string, locationId: string) {
  const supabase = await createServerSupabase();
  const { data, error } = await supabase.from("invoice_documents").select("id, vendor_id, status").eq("id", documentId).eq("location_id", locationId).maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

async function mapAndPost(documentId: string): Promise<string> {
  const svc = createServiceSupabase();
  const m = await mapInvoiceDocument(svc, documentId);
  const outcome = await postInvoiceIfResolved(svc, documentId);
  const tail = outcome === "posted" ? "Posted — purchases now count toward on-hand." : outcome === "rejected" ? "Rejected." : `${m.unmapped} line${m.unmapped === 1 ? "" : "s"} still to review.`;
  return tail;
}

function refresh(documentId: string) {
  revalidatePath(`/invoices/review/${documentId}`);
  revalidatePath("/invoices");
  revalidatePath("/");
}

/**
 * Confirm a line's mapping. Creates the inventory item when "New item" was
 * used, upserts the vendor mapping keyed on SKU (or normalized description),
 * marks the line confirmed, then lets the pipeline fill quantity_base_unit and
 * cost_per_base_unit from the mapping and post the document if resolved.
 */
export async function confirmLine(formData: FormData) {
  const ctx = await getAppContext();
  const documentId = uuid.safeParse(field(formData, "document_id")).data;
  if (!documentId) redirect("/invoices?error=Bad%20request");
  const parsed = confirmSchema.safeParse({
    document_id: documentId,
    line_id: field(formData, "line_id"),
    inventory_item_id: field(formData, "inventory_item_id"),
    new_name: field(formData, "new_name"),
    new_category: field(formData, "new_category"),
    new_base_unit: field(formData, "new_base_unit") || undefined,
    units_per_pack: field(formData, "units_per_pack") || "1",
    base_units_per_unit: field(formData, "base_units_per_unit"),
    pack_description: field(formData, "pack_description"),
    brand: field(formData, "brand"),
  });
  if (!parsed.success) back(documentId, "error", parsed.error.issues[0]?.message ?? "Check the form");
  const f = parsed.data;

  const doc = await loadDocument(documentId, ctx.location.id);
  if (!doc) back(documentId, "error", "Invoice not found");
  if (!doc.vendor_id) back(documentId, "error", "Pick the vendor first (top of the page), then confirm lines");

  const supabase = await createServerSupabase();
  const { data: line, error: lerr } = await supabase
    .from("invoice_lines")
    .select("id, vendor_sku, description, status")
    .eq("id", f.line_id)
    .eq("invoice_id", documentId)
    .maybeSingle();
  if (lerr) back(documentId, "error", lerr.message);
  if (!line) back(documentId, "error", "Line not found");

  // Which inventory item? A typed new name wins over the select.
  let inventoryItemId = f.inventory_item_id && f.inventory_item_id !== "__new__" ? f.inventory_item_id : "";
  if (f.new_name) {
    if (!f.new_base_unit) back(documentId, "error", "Pick a base unit for the new item");
    const { data: item, error: ierr } = await supabase
      .from("inventory_items")
      .upsert(
        { tenant_id: ctx.tenant.id, name: f.new_name, category: f.new_category || null, base_unit: f.new_base_unit },
        { onConflict: "tenant_id,name" },
      )
      .select("id")
      .single();
    if (ierr) back(documentId, "error", ierr.message);
    inventoryItemId = item.id;
  }
  if (!uuid.safeParse(inventoryItemId).success) back(documentId, "error", "Choose an inventory item or add a new one");

  const mappingValues = {
    tenant_id: ctx.tenant.id,
    vendor_id: doc.vendor_id,
    vendor_sku: line.vendor_sku?.trim() || null,
    description_norm: normDescription(line.description),
    inventory_item_id: inventoryItemId,
    units_per_pack: Number(f.units_per_pack),
    base_units_per_unit: Number(f.base_units_per_unit),
    pack_description: f.pack_description || null,
    brand: f.brand || null,
    confirmed_by: ctx.userId,
    confirmed_at: new Date().toISOString(),
  };
  if (!(mappingValues.base_units_per_unit > 0) || !(mappingValues.units_per_pack > 0)) back(documentId, "error", "Pack numbers must be greater than zero");

  // Find the existing mapping by SKU when present, else by normalized description; update it or insert.
  const existingQuery = supabase.from("vendor_item_mappings").select("id").eq("vendor_id", doc.vendor_id);
  const { data: existing, error: eerr } = await (mappingValues.vendor_sku
    ? existingQuery.eq("vendor_sku", mappingValues.vendor_sku)
    : existingQuery.eq("description_norm", mappingValues.description_norm)
  ).maybeSingle();
  if (eerr) back(documentId, "error", eerr.message);

  let mappingId: string;
  if (existing) {
    const { error } = await supabase.from("vendor_item_mappings").update(mappingValues).eq("id", existing.id);
    if (error) back(documentId, "error", error.message);
    mappingId = existing.id;
  } else {
    const { data: created, error } = await supabase.from("vendor_item_mappings").insert(mappingValues).select("id").single();
    if (error) back(documentId, "error", error.message);
    mappingId = created.id;
  }

  const { error: uerr } = await supabase
    .from("invoice_lines")
    .update({ status: "confirmed", mapping_id: mappingId, inventory_item_id: inventoryItemId })
    .eq("id", line.id);
  if (uerr) back(documentId, "error", uerr.message);

  let tail = "";
  try {
    tail = await mapAndPost(documentId);
  } catch (e) {
    back(documentId, "error", `Mapping saved, but re-running the pipeline failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  refresh(documentId);
  back(documentId, "ok", `Mapped "${line.description}". ${tail}`);
}

/** "Not inventory": delivery fee, deposit, tax line. The line stays on the invoice but never becomes a purchase. */
export async function ignoreLine(formData: FormData) {
  const ctx = await getAppContext();
  const documentId = uuid.safeParse(field(formData, "document_id")).data;
  const lineId = uuid.safeParse(field(formData, "line_id")).data;
  if (!documentId || !lineId) redirect("/invoices?error=Bad%20request");
  const doc = await loadDocument(documentId, ctx.location.id);
  if (!doc) back(documentId, "error", "Invoice not found");

  const supabase = await createServerSupabase();
  const { error } = await supabase.from("invoice_lines").update({ status: "ignored" }).eq("id", lineId).eq("invoice_id", documentId);
  if (error) back(documentId, "error", error.message);

  let tail = "";
  try {
    tail = (await postInvoiceIfResolved(createServiceSupabase(), documentId)) === "posted" ? "Posted." : "";
  } catch (e) {
    back(documentId, "error", e instanceof Error ? e.message : String(e));
  }
  refresh(documentId);
  back(documentId, "ok", `Line ignored. ${tail}`.trim());
}

/** One-tap approval of an AI-suggested mapping: confirms the mapping so that SKU never asks again. */
export async function approveAutoMapping(formData: FormData) {
  const ctx = await getAppContext();
  const documentId = uuid.safeParse(field(formData, "document_id")).data;
  const lineId = uuid.safeParse(field(formData, "line_id")).data;
  if (!documentId || !lineId) redirect("/invoices?error=Bad%20request");
  const doc = await loadDocument(documentId, ctx.location.id);
  if (!doc) back(documentId, "error", "Invoice not found");

  const supabase = await createServerSupabase();
  const { data: line, error: lerr } = await supabase.from("invoice_lines").select("id, mapping_id, description").eq("id", lineId).eq("invoice_id", documentId).maybeSingle();
  if (lerr) back(documentId, "error", lerr.message);
  if (!line?.mapping_id) back(documentId, "error", "That line has no mapping to approve");

  const { error: merr } = await supabase
    .from("vendor_item_mappings")
    .update({ confirmed_by: ctx.userId, confirmed_at: new Date().toISOString() })
    .eq("id", line.mapping_id);
  if (merr) back(documentId, "error", merr.message);
  const { error: uerr } = await supabase.from("invoice_lines").update({ status: "confirmed" }).eq("id", line.id);
  if (uerr) back(documentId, "error", uerr.message);

  let tail = "";
  try {
    tail = (await postInvoiceIfResolved(createServiceSupabase(), documentId)) === "posted" ? "Posted." : "";
  } catch (e) {
    back(documentId, "error", e instanceof Error ? e.message : String(e));
  }
  refresh(documentId);
  back(documentId, "ok", `Confirmed "${line.description}". ${tail}`.trim());
}

/** "Wrong vendor": re-attribute and re-run mapping, since mappings are per vendor. */
export async function setVendor(formData: FormData) {
  const ctx = await getAppContext();
  const documentId = uuid.safeParse(field(formData, "document_id")).data;
  const vendorId = uuid.safeParse(field(formData, "vendor_id")).data;
  if (!documentId || !vendorId) redirect("/invoices?error=Bad%20request");
  const doc = await loadDocument(documentId, ctx.location.id);
  if (!doc) back(documentId, "error", "Invoice not found");

  const supabase = await createServerSupabase();
  const { data: vendor } = await supabase.from("vendors").select("id, name").eq("id", vendorId).eq("tenant_id", ctx.tenant.id).maybeSingle();
  if (!vendor) back(documentId, "error", "Vendor not found");
  const { error } = await supabase.from("invoice_documents").update({ vendor_id: vendor.id }).eq("id", documentId);
  if (error) back(documentId, "error", error.message);

  let tail = "";
  try {
    tail = await mapAndPost(documentId);
  } catch (e) {
    back(documentId, "error", e instanceof Error ? e.message : String(e));
  }
  refresh(documentId);
  back(documentId, "ok", `Vendor set to ${vendor.name}. ${tail}`);
}

/** "Not an invoice": statements, marketing, duplicates. Nothing on it ever counts as a purchase. */
export async function rejectDocument(formData: FormData) {
  const ctx = await getAppContext();
  const documentId = uuid.safeParse(field(formData, "document_id")).data;
  if (!documentId) redirect("/invoices?error=Bad%20request");
  const doc = await loadDocument(documentId, ctx.location.id);
  if (!doc) back(documentId, "error", "Invoice not found");
  const supabase = await createServerSupabase();
  const { error } = await supabase.from("invoice_documents").update({ status: "rejected", posted_at: null }).eq("id", documentId);
  if (error) back(documentId, "error", error.message);
  refresh(documentId);
  redirect("/invoices?ok=" + encodeURIComponent("Marked as not an invoice"));
}

/** Re-run map → post for the document (after fixing mappings elsewhere, or a transient failure). */
export async function rerunMapping(formData: FormData) {
  const ctx = await getAppContext();
  const documentId = uuid.safeParse(field(formData, "document_id")).data;
  if (!documentId) redirect("/invoices?error=Bad%20request");
  const doc = await loadDocument(documentId, ctx.location.id);
  if (!doc) back(documentId, "error", "Invoice not found");
  let tail = "";
  try {
    tail = await mapAndPost(documentId);
  } catch (e) {
    back(documentId, "error", e instanceof Error ? e.message : String(e));
  }
  refresh(documentId);
  back(documentId, "ok", `Mapping re-run. ${tail}`);
}

/**
 * Spreadsheet documents: the header row's column roles were edited. Save the
 * map as a human-confirmed vendor_sheet_layouts row (keyed by the header
 * fingerprint, so every future export with this header uses it), then
 * re-parse the file and re-run map → post.
 */
export async function updateSheetLayout(formData: FormData) {
  const ctx = await getAppContext();
  const documentId = uuid.safeParse(field(formData, "document_id")).data;
  if (!documentId) redirect("/invoices?error=Bad%20request");
  const supabase = await createServerSupabase();
  const { data: doc, error } = await supabase.from("invoice_documents").select("id, vendor_id, raw_extraction").eq("id", documentId).eq("location_id", ctx.location.id).maybeSingle();
  if (error) back(documentId, "error", error.message);
  if (!doc) back(documentId, "error", "Invoice not found");
  const ex = doc.raw_extraction as Partial<SpreadsheetExtraction> | null;
  if (!ex || ex.kind !== "spreadsheet" || !ex.fingerprint || !Array.isArray(ex.header)) back(documentId, "error", "Not a spreadsheet invoice");

  const columnMap: ColumnMap = {};
  const roles = new Set<ColumnRole>();
  for (const [key, value] of formData.entries()) {
    const m = key.match(/^col_(\d+)$/);
    if (!m || typeof value !== "string") continue;
    const role = COLUMN_ROLES.find((r) => r === value);
    if (!role) continue;
    if (role !== "ignore" && roles.has(role)) back(documentId, "error", `"${role}" is assigned to two columns`);
    if (role !== "ignore") roles.add(role);
    columnMap[m[1]] = role;
  }
  if (!roles.has("description") || !(roles.has("quantity") || roles.has("extended_price"))) back(documentId, "error", "Assign Description plus Quantity or Line total");

  const svc = createServiceSupabase();
  try {
    await saveHumanSheetLayout(svc, { tenantId: ctx.tenant.id, vendorId: doc.vendor_id, fingerprint: ex.fingerprint, headerCells: ex.header, columnMap, userId: ctx.userId });
    const r = await runInvoicePipeline(svc, documentId, { reparse: true });
    refresh(documentId);
    back(documentId, "ok", `Column roles saved and remembered. Re-read ${r.lines} line${r.lines === 1 ? "" : "s"}${r.siblings ? ` across ${r.siblings + 1} invoices` : ""}; ${r.unmapped} still to review.`);
  } catch (e) {
    back(documentId, "error", e instanceof Error ? e.message : String(e));
  }
}
