"use server";

import Decimal from "decimal.js";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { createServerSupabase } from "@/lib/db/server";
import { getAppContext } from "@/lib/db/context";
import { todayIn } from "@/lib/core/dates";

const positionSchema = z.enum(["open", "close"]);

const baseSchema = z.object({
  inventory_item_id: z.uuid(),
  position: positionSchema,
});

const countSchema = baseSchema.extend({
  // Typed on a phone keypad: "11.5", " 12 ", "1,272". Never a float on the wire.
  packs: z
    .string()
    .trim()
    .transform((s) => s.replace(/,/g, ""))
    .refine((s) => /^-?\d*(\.\d+)?$/.test(s) && s !== "" && s !== "-", "Enter a number"),
});

function back(position: string, kind: "ok" | "error" | "saved", value: string): never {
  redirect(`/?position=${position}&${kind}=${encodeURIComponent(value)}`);
}

/** Current estimate for one item, through RLS. The number the owner saw is re-read, not trusted from the form. */
async function currentEstimate(locationId: string, inventoryItemId: string) {
  const supabase = await createServerSupabase();
  const { data, error } = await supabase
    .from("on_hand_estimate")
    .select("on_hand_qty, pack_to_base_factor, base_unit")
    .eq("location_id", locationId)
    .eq("inventory_item_id", inventoryItemId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data;
}

/** numeric(14,4) column: carry the value as Decimal, hand PostgREST a fixed 4-dp number. */
function toNumeric4(d: Decimal): number {
  return Number(d.toFixed(4));
}

/** ✓ tap: "what the app showed is what's on the shelf". Resets the baseline with zero variance. */
export async function confirmEstimate(formData: FormData) {
  const ctx = await getAppContext();
  const parsed = baseSchema.safeParse({
    inventory_item_id: formData.get("inventory_item_id"),
    position: formData.get("position"),
  });
  if (!parsed.success) back("open", "error", "Bad request");
  const { inventory_item_id, position } = parsed.data;

  const est = await currentEstimate(ctx.location.id, inventory_item_id);
  if (!est) back(position, "error", "Item not found");
  const qty = new Decimal(est.on_hand_qty ?? 0);

  const supabase = await createServerSupabase();
  const { error } = await supabase.from("stock_counts").upsert(
    {
      location_id: ctx.location.id,
      inventory_item_id,
      count_date: todayIn(ctx.location.timezone),
      position,
      quantity_base_unit: toNumeric4(qty),
      verification: "confirmed_estimate",
      estimate_at_count: toNumeric4(qty),
      counted_by: ctx.userId,
      counted_at: new Date().toISOString(),
    },
    { onConflict: "location_id,inventory_item_id,count_date,position" },
  );
  if (error) back(position, "error", error.message);
  revalidatePath("/");
  revalidatePath("/on-hand");
  back(position, "saved", inventory_item_id);
}

/** Typed count in packs (or base units when the item has no pack size). Real evidence: feeds variance. */
export async function saveCount(formData: FormData) {
  const ctx = await getAppContext();
  const parsed = countSchema.safeParse({
    inventory_item_id: formData.get("inventory_item_id"),
    position: formData.get("position"),
    packs: formData.get("packs"),
  });
  const position = positionSchema.safeParse(formData.get("position")).data ?? "open";
  if (!parsed.success) back(position, "error", parsed.error.issues[0]?.message ?? "Enter a number");
  const { inventory_item_id, packs } = parsed.data;

  const est = await currentEstimate(ctx.location.id, inventory_item_id);
  if (!est) back(position, "error", "Item not found");

  // The only arithmetic allowed in the UI layer: packs × pack_to_base_factor, in Decimal.
  const typed = new Decimal(packs);
  const factor = est.pack_to_base_factor != null && est.pack_to_base_factor > 0 ? new Decimal(est.pack_to_base_factor) : null;
  const qtyBase = factor ? typed.mul(factor) : typed;
  if (qtyBase.isNegative()) back(position, "error", "A count can't be negative");

  const supabase = await createServerSupabase();
  const { error } = await supabase.from("stock_counts").upsert(
    {
      location_id: ctx.location.id,
      inventory_item_id,
      count_date: todayIn(ctx.location.timezone),
      position,
      quantity_base_unit: toNumeric4(qtyBase),
      verification: "counted",
      estimate_at_count: toNumeric4(new Decimal(est.on_hand_qty ?? 0)),
      counted_by: ctx.userId,
      counted_at: new Date().toISOString(),
    },
    { onConflict: "location_id,inventory_item_id,count_date,position" },
  );
  if (error) back(position, "error", error.message);
  revalidatePath("/");
  revalidatePath("/on-hand");
  back(position, "saved", inventory_item_id);
}
