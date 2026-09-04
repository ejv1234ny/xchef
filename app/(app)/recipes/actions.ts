"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createServerSupabase } from "@/lib/db/server";
import { getAppContext } from "@/lib/db/context";
import { Constants } from "@/lib/db/types";

/** Postgres numeric accepts a JSON string; keep the owner's exact decimal. */
const numeric = (s: string): number => s as unknown as number;

const skipParam = z
  .string()
  .optional()
  .transform((s) => (s ?? "").split(",").filter((x) => /^[0-9a-f-]{36}$/i.test(x)));

function msg(kind: "ok" | "error", text: string, skip: string[] = []): never {
  const qs = new URLSearchParams({ [kind]: text });
  if (skip.length) qs.set("skip", skip.join(","));
  redirect(`/recipes?${qs.toString()}`);
}

const ConfirmInput = z.object({
  component_id: z.uuid(),
  menu_item_id: z.uuid(),
  quantity: z
    .string()
    .trim()
    .regex(/^\d*\.?\d+$/, "Enter a number like 1.5")
    .refine((s) => Number(s) > 0, "Quantity must be more than 0"),
  unit: z.enum(Constants.public.Enums.uom),
  skip: skipParam,
});

/** After a change, flip menu_items.recipe_status to confirmed when every remaining component is confirmed. */
async function refreshMenuItemStatus(supabase: Awaited<ReturnType<typeof createServerSupabase>>, menuItemId: string) {
  const { data: comps, error } = await supabase.from("recipe_components").select("source").eq("menu_item_id", menuItemId);
  if (error) throw new Error(error.message);
  const rows = comps ?? [];
  const status = rows.length > 0 && rows.every((c) => c.source === "confirmed") ? "confirmed" : rows.length > 0 ? "needs_review" : "draft";
  const { error: uerr } = await supabase.from("menu_items").update({ recipe_status: status }).eq("id", menuItemId);
  if (uerr) throw new Error(uerr.message);
  return status;
}

/** ✓ Accept and Edit both land here: the submitted quantity/unit become the confirmed recipe line. */
export async function confirmComponent(formData: FormData) {
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();
  const parsed = ConfirmInput.safeParse({
    component_id: formData.get("component_id"),
    menu_item_id: formData.get("menu_item_id"),
    quantity: formData.get("quantity") ?? "",
    unit: formData.get("unit"),
    skip: formData.get("skip") ?? "",
  });
  if (!parsed.success) msg("error", parsed.error.issues[0]?.message ?? "Invalid input");
  const d = parsed.data;
  const { data: updated, error } = await supabase
    .from("recipe_components")
    .update({
      quantity: numeric(d.quantity),
      unit: d.unit,
      source: "confirmed",
      confirmed_by: ctx.userId,
      confirmed_at: new Date().toISOString(),
    })
    .eq("id", d.component_id)
    .eq("menu_item_id", d.menu_item_id)
    .select("id, inventory_items(name)")
    .maybeSingle();
  if (error) msg("error", error.message, d.skip);
  if (!updated) msg("error", "That ingredient line no longer exists", d.skip);
  let status: string;
  try {
    status = await refreshMenuItemStatus(supabase, d.menu_item_id);
  } catch (e) {
    msg("error", e instanceof Error ? e.message : String(e), d.skip);
  }
  revalidatePath("/recipes");
  revalidatePath("/usage");
  revalidatePath("/menu");
  const name = updated.inventory_items?.name ?? "ingredient";
  msg("ok", status === "confirmed" ? `${name} saved — recipe confirmed` : `${name} saved`, d.skip);
}

const RemoveInput = z.object({ component_id: z.uuid(), menu_item_id: z.uuid(), skip: skipParam });

/** "Remove this ingredient": the AI guessed an ingredient that is not in the dish. */
export async function removeComponent(formData: FormData) {
  await getAppContext();
  const supabase = await createServerSupabase();
  const parsed = RemoveInput.safeParse({
    component_id: formData.get("component_id"),
    menu_item_id: formData.get("menu_item_id"),
    skip: formData.get("skip") ?? "",
  });
  if (!parsed.success) msg("error", "Invalid input");
  const d = parsed.data;
  const { error } = await supabase.from("recipe_components").delete().eq("id", d.component_id).eq("menu_item_id", d.menu_item_id);
  if (error) msg("error", error.message, d.skip);
  try {
    await refreshMenuItemStatus(supabase, d.menu_item_id);
  } catch (e) {
    msg("error", e instanceof Error ? e.message : String(e), d.skip);
  }
  revalidatePath("/recipes");
  revalidatePath("/usage");
  revalidatePath("/menu");
  msg("ok", "Ingredient removed", d.skip);
}
