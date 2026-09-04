import Link from "next/link";
import { getAppContext } from "@/lib/db/context";
import { createServerSupabase } from "@/lib/db/server";
import type { Enums } from "@/lib/db/types";
import { addDays, todayIn } from "@/lib/core/dates";
import { orderRecipeQueue, type RecipeQueueRow } from "@/lib/core/recipeQueue";
import { RecipeCard } from "@/components/recipe-card";
import { Flash, fmtCount, rawNumeric } from "@/components/inventory-units";
import { confirmComponent, removeComponent } from "./actions";

export const metadata = { title: "Recipe Q&A" };

const PAGE = 1000;

type Component = {
  id: string;
  quantity: number;
  unit: Enums<"uom">;
  confidence: number | null;
  source: Enums<"recipe_source">;
  inventory_items: { name: string; base_unit: Enums<"uom"> } | null;
};
type MenuItemWithComponents = {
  id: string;
  name: string;
  recipe_status: Enums<"recipe_status">;
  recipe_components: Component[];
};

/** Units sold per menu item over the last 30 days (a count; summed in TS). */
async function unitsSold30d(locationId: string, fromDate: string): Promise<Map<string, number>> {
  const supabase = await createServerSupabase();
  const totals = new Map<string, number>();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("sales_facts")
      .select("menu_item_id, quantity_sold")
      .eq("location_id", locationId)
      .gte("business_date", fromDate)
      .not("menu_item_id", "is", null)
      .order("id")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    for (const r of data ?? []) if (r.menu_item_id) totals.set(r.menu_item_id, (totals.get(r.menu_item_id) ?? 0) + Number(r.quantity_sold));
    if (!data || data.length < PAGE) break;
  }
  return totals;
}

/** Every menu item that has at least one recipe component, with its components and ingredient names. */
async function menuItemsWithComponents(tenantId: string): Promise<MenuItemWithComponents[]> {
  const supabase = await createServerSupabase();
  const out: MenuItemWithComponents[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("menu_items")
      .select("id, name, recipe_status, recipe_components!inner(id, quantity, unit, confidence, source, inventory_items(name, base_unit))")
      .eq("tenant_id", tenantId)
      .order("name")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...((data ?? []) as MenuItemWithComponents[]));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

function parseSkip(v: string | string[] | undefined): string[] {
  const s = typeof v === "string" ? v : "";
  return s.split(",").filter((x) => /^[0-9a-f-]{36}$/i.test(x));
}

export default async function RecipesPage({ searchParams }: PageProps<"/recipes">) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  const today = todayIn(ctx.location.timezone);
  const fromDate = addDays(today, -30);
  const [sold, items] = await Promise.all([unitsSold30d(ctx.location.id, fromDate), menuItemsWithComponents(ctx.tenant.id)]);

  const byId = new Map(items.map((m) => [m.id, m]));
  const rows: RecipeQueueRow[] = items.map((m) => ({
    menu_item_id: m.id,
    name: m.name,
    units_sold_30d: sold.get(m.id) ?? 0,
    components: m.recipe_components.map((c) => ({ id: c.id, confidence: c.confidence, source: c.source })),
  }));
  const ordered = orderRecipeQueue(rows);

  let toConfirm = 0;
  let confirmed = 0;
  for (const m of items) {
    for (const c of m.recipe_components) {
      if (c.source === "confirmed") confirmed += 1;
      else toConfirm += 1;
    }
  }

  const skipped = parseSkip(sp.skip);
  const skippedSet = new Set(skipped);
  const nextId = ordered.find((id) => !skippedSet.has(id)) ?? (skipped.length ? ordered[0] : undefined);
  const current = nextId ? byId.get(nextId) : undefined;

  // Ask about the least-confident open ingredient on this item first.
  const open = current
    ? [...current.recipe_components]
        .filter((c) => c.source !== "confirmed")
        .sort((a, b) => Number(a.confidence ?? 0) - Number(b.confidence ?? 0) || (a.inventory_items?.name ?? "").localeCompare(b.inventory_items?.name ?? ""))
    : [];
  const component = open[0];
  // If we wrapped around past the skip list, start the skip list fresh.
  const carriedSkip = nextId && skippedSet.has(nextId) ? [] : skipped;
  const skipHref = current ? `/recipes?skip=${encodeURIComponent([...carriedSkip, current.id].join(","))}` : "/recipes";

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Recipe Q&A</h1>
        <p className="text-sm text-neutral-500 tabular-nums">
          {toConfirm} to confirm · {confirmed} confirmed
        </p>
      </div>
      <Flash ok={sp.ok} error={sp.error} />

      {current && component ? (
        <>
          <RecipeCard
            componentId={component.id}
            menuItemId={current.id}
            menuItemName={current.name}
            ingredientName={component.inventory_items?.name ?? "ingredient"}
            unitsSold30d={fmtCount(sold.get(current.id) ?? 0)}
            quantity={rawNumeric(component.quantity)}
            unit={component.unit}
            baseUnit={component.inventory_items?.base_unit ?? component.unit}
            confidence={component.confidence}
            skip={carriedSkip.join(",")}
            skipHref={skipHref}
            remainingOnItem={open.length}
            confirmAction={confirmComponent}
            removeAction={removeComponent}
          />
          {current.recipe_components.length > 1 ? (
            <section className="rounded-xl border border-neutral-200 bg-white px-4 py-3 text-sm">
              <p className="mb-1 font-medium">Everything in a {current.name}</p>
              <ul className="divide-y divide-neutral-100">
                {current.recipe_components.map((c) => (
                  <li key={c.id} className="flex justify-between py-1.5">
                    <span className="truncate">{c.inventory_items?.name ?? "ingredient"}</span>
                    <span className="shrink-0 tabular-nums text-neutral-600">
                      {rawNumeric(c.quantity)} {c.unit}
                      {c.source === "confirmed" ? " ✓" : ""}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <p className="text-center text-xs text-neutral-500">
            {ordered.length} menu items still have something to confirm.{" "}
            {skipped.length ? (
              <Link href="/recipes" className="underline">
                Reset skipped
              </Link>
            ) : null}
          </p>
        </>
      ) : items.length === 0 ? (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-dashed border-neutral-300 bg-white p-8 text-center">
          <p className="text-lg font-medium">No recipes drafted yet</p>
          <p className="text-sm text-neutral-600">Draft recipes from your menu and the questions show up here, most-sold items first.</p>
          <Link href="/menu" className="flex h-14 w-full items-center justify-center rounded-2xl bg-neutral-900 text-lg font-semibold text-white">
            Go to menu
          </Link>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-4 rounded-2xl border border-emerald-200 bg-emerald-50 p-8 text-center">
          <p className="text-lg font-medium text-emerald-900">All caught up</p>
          <p className="text-sm text-emerald-900/80">Every drafted recipe is confirmed. Draft more from the menu when new items sell.</p>
          <div className="flex w-full gap-3">
            <Link href="/menu" className="flex h-14 flex-1 items-center justify-center rounded-2xl bg-neutral-900 text-lg font-semibold text-white">
              Menu
            </Link>
            <Link href="/usage" className="flex h-14 flex-1 items-center justify-center rounded-2xl border border-neutral-300 bg-white text-lg font-semibold">
              Usage
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}
