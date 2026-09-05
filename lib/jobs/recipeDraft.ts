import { createServiceSupabase, type ServiceClient } from "@/lib/db/service";
import type { Enums, Tables } from "@/lib/db/types";
import { addDays, todayIn } from "@/lib/core/dates";
import { logLlmCall } from "@/lib/llm/anthropic";
import { isLlmConfigured, selectedProviderName } from "@/lib/llm/provider";
import { modelFor } from "@/lib/llm/models";
import { draftRecipe, type RecipeComponentDraft } from "@/lib/llm/recipe-draft";

export type RecipeDraftLogger = (msg: string, meta?: Record<string, unknown>) => void;

export type DraftRecipesOptions = {
  tenantId: string;
  /** tenants.concept, loaded once per run by draftRecipes */
  concept?: string | null;
  locationId: string;
  /** restrict to these menu items (still ordered by sales; items without sales are kept, last) */
  menuItemIds?: string[];
  /** default true: skip menu items that already have recipe_components */
  onlyWithoutComponents?: boolean;
  /** default 30 */
  soldWithinDays?: number;
  limit?: number;
  log?: RecipeDraftLogger;
};

export type DraftRecipesResult = { drafted: number; skipped: number; errors: number; newItems: number };

const PAGE = 1000;
const CONCURRENCY = 2;
const MAX_MODIFIER_NAMES = 80;

/**
 * Postgres numeric columns accept a JSON string; sending "1.5" keeps the exact
 * decimal instead of round-tripping through a float. The generated types say
 * `number`, hence the cast.
 */
const numeric = (s: string): number => s as unknown as number;

type InventoryRow = Pick<Tables<"inventory_items">, "id" | "name" | "category" | "base_unit">;

async function pageAll<T>(
  query: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await query(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

/** Sum of quantity_sold per menu item for the location within the window, as a Map (counts, not money). */
async function unitsSoldByMenuItem(svc: ServiceClient, locationId: string, fromDate: string): Promise<Map<string, number>> {
  const rows = await pageAll<{ menu_item_id: string | null; quantity_sold: number }>((from, to) =>
    svc
      .from("sales_facts")
      .select("menu_item_id, quantity_sold")
      .eq("location_id", locationId)
      .gte("business_date", fromDate)
      .not("menu_item_id", "is", null)
      .order("id")
      .range(from, to),
  );
  const totals = new Map<string, number>();
  for (const r of rows) {
    if (!r.menu_item_id) continue;
    totals.set(r.menu_item_id, (totals.get(r.menu_item_id) ?? 0) + Number(r.quantity_sold));
  }
  return totals;
}

async function menuItemIdsWithComponents(svc: ServiceClient, ids: string[]): Promise<Set<string>> {
  const has = new Set<string>();
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await svc
      .from("recipe_components")
      .select("menu_item_id")
      .in("menu_item_id", ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
    for (const r of data ?? []) has.add(r.menu_item_id);
  }
  return has;
}

/** Ordered list of menu items to draft, most-sold first. */
export async function selectMenuItemsToDraft(
  svc: ServiceClient,
  opts: DraftRecipesOptions,
): Promise<Array<Tables<"menu_items"> & { units_sold: number }>> {
  const days = opts.soldWithinDays ?? 30;
  const onlyWithout = opts.onlyWithoutComponents ?? true;
  const { data: loc, error: lerr } = await svc.from("locations").select("timezone").eq("id", opts.locationId).single();
  if (lerr) throw new Error(lerr.message);
  const fromDate = addDays(todayIn(loc.timezone), -days);
  const sold = await unitsSoldByMenuItem(svc, opts.locationId, fromDate);

  let ids: string[];
  if (opts.menuItemIds?.length) {
    const wanted = new Set(opts.menuItemIds);
    ids = [...wanted].sort((a, b) => (sold.get(b) ?? 0) - (sold.get(a) ?? 0));
  } else {
    ids = [...sold.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
  }
  if (onlyWithout) {
    const has = await menuItemIdsWithComponents(svc, ids);
    ids = ids.filter((id) => !has.has(id));
  }
  if (opts.limit !== undefined) ids = ids.slice(0, Math.max(0, opts.limit));
  if (ids.length === 0) return [];

  const items: Tables<"menu_items">[] = [];
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await svc.from("menu_items").select("*").eq("tenant_id", opts.tenantId).in("id", ids.slice(i, i + 200));
    if (error) throw new Error(error.message);
    items.push(...(data ?? []));
  }
  const byId = new Map(items.map((m) => [m.id, m]));
  return ids.flatMap((id) => {
    const m = byId.get(id);
    return m ? [{ ...m, units_sold: sold.get(id) ?? 0 }] : [];
  });
}

/**
 * Resolve a drafted component to an inventory_items.id, creating the item
 * when needed. Reuses an existing item on a case-insensitive name match
 * (inventory_items is unique on (tenant_id, name)). Mutates `inventory`.
 */
async function resolveInventoryItem(
  svc: ServiceClient,
  tenantId: string,
  inventory: InventoryRow[],
  draft: RecipeComponentDraft,
): Promise<{ id: string; created: boolean } | null> {
  if (draft.existing_inventory_item_id) {
    const hit = inventory.find((i) => i.id === draft.existing_inventory_item_id);
    if (hit) return { id: hit.id, created: false };
  }
  const ni = draft.new_item;
  if (!ni) return null;
  const key = ni.name.trim().toLowerCase();
  const byName = inventory.find((i) => i.name.trim().toLowerCase() === key);
  if (byName) return { id: byName.id, created: false };

  const { data, error } = await svc
    .from("inventory_items")
    .insert({
      tenant_id: tenantId,
      name: ni.name.trim(),
      category: ni.category,
      base_unit: ni.base_unit,
      pack_to_base_factor: ni.pack_to_base_factor == null ? null : numeric(String(ni.pack_to_base_factor)),
    })
    .select("id, name, category, base_unit")
    .single();
  if (error) {
    // Lost a race with a concurrent draft inserting the same name: re-read it.
    const { data: again } = await svc
      .from("inventory_items")
      .select("id, name, category, base_unit")
      .eq("tenant_id", tenantId)
      .ilike("name", ni.name.trim())
      .limit(1)
      .maybeSingle();
    if (!again) throw new Error(`insert inventory_items "${ni.name}": ${error.message}`);
    inventory.push(again);
    return { id: again.id, created: false };
  }
  inventory.push(data);
  return { id: data.id, created: true };
}

async function draftOne(
  svc: ServiceClient,
  opts: DraftRecipesOptions,
  item: Tables<"menu_items">,
  modifierNames: string[],
  inventory: InventoryRow[],
  log: RecipeDraftLogger,
): Promise<{ written: number; newItems: number }> {
  let result: Awaited<ReturnType<typeof draftRecipe>>;
  try {
    result = await draftRecipe({
      concept: opts.concept ?? null,
      menuItem: { id: item.id, name: item.name, category: item.category, price: item.price },
      modifierNames,
      inventory,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await logLlmCall(svc, { tenant_id: opts.tenantId, kind: "recipe-draft", ref_id: item.id, model: modelFor(selectedProviderName(), "recipe-draft"), provider: selectedProviderName(), error: message });
    throw e;
  }
  await logLlmCall(svc, {
    tenant_id: opts.tenantId,
    kind: "recipe-draft",
    ref_id: item.id,
    model: result.model,
    provider: result.provider,
    usage: result.usage,
    raw: result.raw,
  });

  // Never overwrite something the owner already confirmed.
  const { data: existing, error: eerr } = await svc
    .from("recipe_components")
    .select("inventory_item_id, source")
    .eq("menu_item_id", item.id);
  if (eerr) throw new Error(eerr.message);
  const confirmed = new Set((existing ?? []).filter((c) => c.source === "confirmed").map((c) => c.inventory_item_id));

  const rows: Array<{
    menu_item_id: string;
    inventory_item_id: string;
    quantity: number;
    unit: Enums<"uom">;
    source: Enums<"recipe_source">;
    confidence: number;
  }> = [];
  const seen = new Set<string>();
  let newItems = 0;
  for (const c of result.data.components) {
    const resolved = await resolveInventoryItem(svc, opts.tenantId, inventory, c);
    if (!resolved) {
      log("recipe-draft: component without inventory reference, skipped", { menu_item: item.name, note: c.note ?? null });
      continue;
    }
    if (resolved.created) newItems += 1;
    if (seen.has(resolved.id) || confirmed.has(resolved.id)) continue;
    seen.add(resolved.id);
    rows.push({
      menu_item_id: item.id,
      inventory_item_id: resolved.id,
      quantity: numeric(String(c.quantity)),
      unit: c.unit,
      source: "ai_draft",
      confidence: numeric(Math.min(1, Math.max(0, c.confidence)).toFixed(2)),
    });
  }
  if (rows.length) {
    const { error } = await svc.from("recipe_components").upsert(rows, { onConflict: "menu_item_id,inventory_item_id" });
    if (error) throw new Error(`upsert recipe_components: ${error.message}`);
    const { error: uerr } = await svc.from("menu_items").update({ recipe_status: "needs_review" }).eq("id", item.id);
    if (uerr) throw new Error(`update menu_items: ${uerr.message}`);
  }
  log("recipe-draft: drafted", {
    menu_item: item.name,
    components: rows.length,
    new_items: newItems,
    overall_confidence: result.data.overall_confidence,
    cost_usd: result.usage.cost_usd,
  });
  return { written: rows.length, newItems };
}

/**
 * Draft recipes with Claude for the most-sold menu items that have none yet.
 * One LLM call per item (logged to llm_calls), two in flight at a time. A
 * failure on one item is counted and logged, never thrown.
 */
export async function draftRecipes(svc: ServiceClient, opts: DraftRecipesOptions): Promise<DraftRecipesResult> {
  const log = opts.log ?? (() => {});
  const result: DraftRecipesResult = { drafted: 0, skipped: 0, errors: 0, newItems: 0 };
  if (!isLlmConfigured()) throw new Error("LLM API key (OPENAI_API_KEY or ANTHROPIC_API_KEY) not configured");

  // tenants.concept drives the recipe prompt (Part 0 of KICKOFF-2); null falls back to the Mad Moose sentence.
  if (opts.concept === undefined) {
    const { data: tenant } = await svc.from("tenants").select("concept").eq("id", opts.tenantId).maybeSingle();
    opts = { ...opts, concept: tenant?.concept ?? null };
  }

  const items = await selectMenuItemsToDraft(svc, opts);
  if (items.length === 0) {
    log("recipe-draft: nothing to draft");
    return result;
  }

  const [modifiers, inventory] = await Promise.all([
    pageAll<{ name: string }>((from, to) =>
      svc.from("menu_items").select("name").eq("tenant_id", opts.tenantId).eq("category", "modifier").order("name").range(from, to),
    ),
    pageAll<InventoryRow>((from, to) =>
      svc.from("inventory_items").select("id, name, category, base_unit").eq("tenant_id", opts.tenantId).order("name").range(from, to),
    ),
  ]);
  // No per-item modifier link survives the menu sync; the tenant's modifier
  // option names (capped) are the only hint we can give the model.
  const modifierNames = modifiers.map((m) => m.name).slice(0, MAX_MODIFIER_NAMES);
  log("recipe-draft: start", { items: items.length, inventory: inventory.length, modifiers: modifierNames.length });

  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++]!;
      try {
        const r = await draftOne(svc, opts, item, modifierNames, inventory, log);
        if (r.written > 0) result.drafted += 1;
        else result.skipped += 1;
        result.newItems += r.newItems;
      } catch (e) {
        result.errors += 1;
        log("recipe-draft: error", { menu_item: item.name, error: e instanceof Error ? e.message : String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, items.length) }, worker));
  log("recipe-draft: done", { ...result });
  return result;
}

/**
 * Entry point for server actions and routes (mirrors runMenuSync): builds the
 * service-role client here so app code never touches it directly. Callers
 * pass a tenant/location they already resolved through RLS.
 */
export async function runRecipeDraft(opts: DraftRecipesOptions & { supabase?: ServiceClient }): Promise<DraftRecipesResult> {
  const { supabase, ...rest } = opts;
  return draftRecipes(supabase ?? createServiceSupabase(), rest);
}
