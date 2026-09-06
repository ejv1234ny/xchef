"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createServerSupabase } from "@/lib/db/server";
import { getAppContext } from "@/lib/db/context";
import { Constants } from "@/lib/db/types";

function msg(kind: "ok" | "error", text: string): never {
  redirect(`/inventory?${kind}=${encodeURIComponent(text)}`);
}

/** Postgres numeric accepts a JSON string; keep the owner's exact decimal. */
const numeric = (s: string): number => s as unknown as number;

const decimalString = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,4})?$/, "Use a number like 25.36")
  .transform((s) => s.replace(/^0+(?=\d)/, ""));

const optionalDecimal = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : v),
  decimalString.nullable(),
);

const ItemInput = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
  category: z.string().trim().max(40).transform((s) => s || null),
  base_unit: z.enum(Constants.public.Enums.uom),
  pack_to_base_factor: optionalDecimal,
  cost_per_base_unit: optionalDecimal,
});

function parseItem(formData: FormData) {
  const parsed = ItemInput.safeParse({
    name: formData.get("name") ?? "",
    category: formData.get("category") ?? "",
    base_unit: formData.get("base_unit") ?? "",
    pack_to_base_factor: formData.get("pack_to_base_factor") ?? "",
    cost_per_base_unit: formData.get("cost_per_base_unit") ?? "",
  });
  if (!parsed.success) msg("error", parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;
  return {
    name: d.name,
    category: d.category,
    base_unit: d.base_unit,
    pack_to_base_factor: d.pack_to_base_factor === null ? null : numeric(d.pack_to_base_factor),
    cost_per_base_unit: d.cost_per_base_unit === null ? null : numeric(d.cost_per_base_unit),
  };
}

function friendlyDbError(code: string | undefined, message: string): string {
  if (code === "23505") return "An item with that name already exists";
  if (code === "23503") return "This item is used by a recipe or an invoice line and cannot be deleted";
  return message;
}

export async function createInventoryItem(formData: FormData) {
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();
  const row = parseItem(formData);
  const { error } = await supabase.from("inventory_items").insert({ ...row, tenant_id: ctx.tenant.id, origin: "manual" });
  if (error) msg("error", friendlyDbError(error.code, error.message));
  revalidatePath("/inventory");
  msg("ok", `Added ${row.name}`);
}

export async function updateInventoryItem(formData: FormData) {
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();
  const id = z.uuid().safeParse(formData.get("id"));
  if (!id.success) msg("error", "Missing item id");
  const row = parseItem(formData);
  const { error } = await supabase.from("inventory_items").update(row).eq("id", id.data).eq("tenant_id", ctx.tenant.id);
  if (error) msg("error", friendlyDbError(error.code, error.message));
  revalidatePath("/inventory");
  revalidatePath("/usage");
  revalidatePath("/menu");
  msg("ok", `Saved ${row.name}`);
}

export async function deleteInventoryItem(formData: FormData) {
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();
  const id = z.uuid().safeParse(formData.get("id"));
  if (!id.success) msg("error", "Missing item id");
  const { error } = await supabase.from("inventory_items").delete().eq("id", id.data).eq("tenant_id", ctx.tenant.id);
  if (error) msg("error", friendlyDbError(error.code, error.message));
  revalidatePath("/inventory");
  msg("ok", "Item deleted");
}

/** Archive: hidden from the verify queue and the nightly reconciliation, never deleted (catalog_health status 'archived'). */
export async function archiveInventoryItem(formData: FormData) {
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();
  const id = z.uuid().safeParse(formData.get("id"));
  if (!id.success) msg("error", "Missing item id");
  const { data, error } = await supabase
    .from("inventory_items")
    .update({ archived_at: new Date().toISOString() })
    .eq("id", id.data)
    .eq("tenant_id", ctx.tenant.id)
    .select("name")
    .maybeSingle();
  if (error) msg("error", friendlyDbError(error.code, error.message));
  revalidatePath("/inventory");
  revalidatePath("/");
  msg("ok", `Archived ${data?.name ?? "item"}`);
}

export async function restoreInventoryItem(formData: FormData) {
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();
  const id = z.uuid().safeParse(formData.get("id"));
  if (!id.success) msg("error", "Missing item id");
  const { data, error } = await supabase
    .from("inventory_items")
    .update({ archived_at: null, merged_into_id: null })
    .eq("id", id.data)
    .eq("tenant_id", ctx.tenant.id)
    .select("name")
    .maybeSingle();
  if (error) msg("error", friendlyDbError(error.code, error.message));
  revalidatePath("/inventory");
  revalidatePath("/");
  msg("ok", `Restored ${data?.name ?? "item"}`);
}

/**
 * Merge a never-invoiced (or duplicate) item into the one that should own its
 * history: recipes, invoice lines, mappings, quotes and counts move to the
 * target; the source is archived with merged_into_id (merge_inventory_item()).
 */
export async function mergeInventoryItem(formData: FormData) {
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();
  const parsed = z.object({ source: z.uuid(), target: z.uuid() }).safeParse({ source: formData.get("id"), target: formData.get("target") });
  if (!parsed.success) msg("error", "Pick the item to merge into");
  if (parsed.data.source === parsed.data.target) msg("error", "Pick a different item to merge into");
  const { data: names } = await supabase.from("inventory_items").select("id, name").in("id", [parsed.data.source, parsed.data.target]).eq("tenant_id", ctx.tenant.id);
  const byId = new Map((names ?? []).map((n) => [n.id, n.name]));
  const { error } = await supabase.rpc("merge_inventory_item", { p_source: parsed.data.source, p_target: parsed.data.target });
  if (error) msg("error", error.message);
  revalidatePath("/inventory");
  revalidatePath("/");
  revalidatePath("/usage");
  revalidatePath("/menu");
  msg("ok", `Merged ${byId.get(parsed.data.source) ?? "item"} into ${byId.get(parsed.data.target) ?? "item"}`);
}
