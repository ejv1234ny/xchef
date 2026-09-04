import { createServiceSupabase, type ServiceClient } from "@/lib/db/service";
import type { Tables } from "@/lib/db/types";
import type { MenusResponse } from "@/lib/toast/schemas";
import { getToastClientForLocation, type Logger, type SyncOptions } from "./toastSync";

export type MenuSyncResult = {
  location_id: string;
  skipped: boolean;
  last_updated: string | null;
  items_upserted: number;
  modifiers_upserted: number;
  relinked_sales_facts: number;
  error: string | null;
};

export type MenuSyncOptions = {
  locationId?: string;
  /** pull even when metadata.lastUpdated is unchanged */
  force?: boolean;
  supabase?: ServiceClient;
  log?: Logger;
  clientFactory?: SyncOptions["clientFactory"];
};

type Incoming = { guid: string; name: string; price: number | null; category: string | null };

/** Walk menus → menuGroups (recursive) → menuItems; plus every modifier option as its own item. */
export function extractMenuItems(menus: MenusResponse): { items: Incoming[]; modifiers: Incoming[] } {
  const items = new Map<string, Incoming>();
  const walkGroup = (g: NonNullable<MenusResponse["menus"][number]["menuGroups"]>[number], menuName: string | null) => {
    for (const mi of g.menuItems ?? []) {
      items.set(mi.guid, {
        guid: mi.guid,
        name: mi.name.trim(),
        price: mi.price ?? null,
        category: mi.salesCategory?.name?.trim() || g.name?.trim() || menuName,
      });
    }
    for (const sub of g.menuGroups ?? []) walkGroup(sub as typeof g, menuName);
  };
  for (const menu of menus.menus) for (const g of menu.menuGroups ?? []) walkGroup(g, menu.name ?? null);

  const modifiers = new Map<string, Incoming>();
  for (const opt of Object.values(menus.modifierOptionReferences ?? {})) {
    if (items.has(opt.guid)) continue;
    modifiers.set(opt.guid, { guid: opt.guid, name: opt.name.trim(), price: opt.price ?? null, category: "modifier" });
  }
  return { items: [...items.values()], modifiers: [...modifiers.values()] };
}

/**
 * menu_items has unique (tenant_id, name) as well as unique (tenant_id, guid).
 * Toast allows duplicate names across menus, so a name already owned by a
 * different guid gets a short guid suffix instead of failing the batch.
 */
export function dedupeNames(incoming: Incoming[], existing: Array<{ toast_menu_item_guid: string | null; name: string }>): Incoming[] {
  const owner = new Map<string, string>();
  for (const e of existing) if (e.toast_menu_item_guid) owner.set(e.name.toLowerCase(), e.toast_menu_item_guid);
  const out: Incoming[] = [];
  for (const it of incoming) {
    let name = it.name || `Item ${it.guid.slice(0, 8)}`;
    const key = name.toLowerCase();
    const o = owner.get(key);
    if (o && o !== it.guid) name = `${name} #${it.guid.slice(0, 4)}`;
    owner.set(name.toLowerCase(), it.guid);
    out.push({ ...it, name });
  }
  return out;
}

export async function runMenuSync(opts: MenuSyncOptions = {}): Promise<MenuSyncResult[]> {
  const svc = opts.supabase ?? createServiceSupabase();
  const log = opts.log ?? (() => {});
  let q = svc.from("locations").select("*");
  if (opts.locationId) q = q.eq("id", opts.locationId);
  const { data: locations, error } = await q;
  if (error) throw error;

  const results: MenuSyncResult[] = [];
  for (const location of locations ?? []) {
    const ctx = await getToastClientForLocation(svc, location, opts.clientFactory);
    if (!ctx) continue;
    const res: MenuSyncResult = {
      location_id: location.id,
      skipped: false,
      last_updated: null,
      items_upserted: 0,
      modifiers_upserted: 0,
      relinked_sales_facts: 0,
      error: null,
    };
    const t0 = Date.now();
    try {
      const meta = await ctx.client.menusMetadata();
      res.last_updated = meta.lastUpdated;
      const { data: lastRun } = await svc
        .from("sync_runs")
        .select("window_end")
        .eq("location_id", location.id)
        .eq("kind", "menu-sync")
        .is("error", null)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (!opts.force && lastRun?.window_end && new Date(lastRun.window_end).getTime() === new Date(meta.lastUpdated).getTime()) {
        res.skipped = true;
        results.push(res);
        continue;
      }
      const menus = await ctx.client.menus();
      const counts = await upsertMenuItems(svc, location, menus);
      res.items_upserted = counts.items;
      res.modifiers_upserted = counts.modifiers;
      const { data: relinked } = await svc.rpc("relink_sales_facts", { p_location_id: location.id });
      res.relinked_sales_facts = relinked ?? 0;
      log("menu-sync: done", { ...res });
    } catch (e) {
      res.error = e instanceof Error ? e.message : String(e);
      log("menu-sync: error", { error: res.error });
    }
    // menu-sync rows reuse sync_runs: window_end = Toast metadata.lastUpdated,
    // orders_upserted = menu items written, orders_fetched = modifier options written.
    await svc.from("sync_runs").insert({
      location_id: location.id,
      kind: "menu-sync",
      window_end: res.last_updated,
      orders_upserted: res.items_upserted,
      orders_fetched: res.modifiers_upserted,
      duration_ms: Date.now() - t0,
      error: res.error,
    });
    results.push(res);
  }
  return results;
}

export async function upsertMenuItems(svc: ServiceClient, location: Tables<"locations">, menus: MenusResponse): Promise<{ items: number; modifiers: number }> {
  const { items, modifiers } = extractMenuItems(menus);
  const { data: existing } = await svc.from("menu_items").select("toast_menu_item_guid, name").eq("tenant_id", location.tenant_id);
  const all = dedupeNames([...items, ...modifiers], existing ?? []);
  const rows = all.map((it) => ({
    tenant_id: location.tenant_id,
    toast_menu_item_guid: it.guid,
    name: it.name,
    price: it.price,
    category: it.category,
  }));
  for (let i = 0; i < rows.length; i += 200) {
    const { error } = await svc.from("menu_items").upsert(rows.slice(i, i + 200), { onConflict: "tenant_id,toast_menu_item_guid" });
    if (error) throw new Error(`upsert menu_items: ${error.message}`);
  }
  return { items: items.length, modifiers: modifiers.length };
}
