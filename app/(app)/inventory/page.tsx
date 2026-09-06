import Link from "next/link";
import { getAppContext } from "@/lib/db/context";
import { createServerSupabase } from "@/lib/db/server";
import type { Tables } from "@/lib/db/types";
import { InventoryItemForm } from "@/components/inventory-item-form";
import { Flash, categoryLabel, fmtQty, fmtUnitCost } from "@/components/inventory-units";
import { archiveInventoryItem, createInventoryItem, deleteInventoryItem, mergeInventoryItem, restoreInventoryItem, updateInventoryItem } from "./actions";

export const metadata = { title: "Inventory" };

const PAGE = 1000;

async function loadItems(tenantId: string): Promise<Tables<"inventory_items">[]> {
  const supabase = await createServerSupabase();
  const out: Tables<"inventory_items">[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("inventory_items")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("category", { nullsFirst: false })
      .order("name")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

type Health = Tables<"catalog_health">;

async function loadHealth(tenantId: string): Promise<Health[]> {
  const supabase = await createServerSupabase();
  const out: Health[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from("catalog_health").select("*").eq("tenant_id", tenantId).order("name").range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

export default async function InventoryPage({ searchParams }: PageProps<"/inventory">) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  const [all, health] = await Promise.all([loadItems(ctx.tenant.id), loadHealth(ctx.tenant.id)]);
  const items = all.filter((i) => i.archived_at == null);
  const archived = all.filter((i) => i.archived_at != null);

  const groups = new Map<string, Tables<"inventory_items">[]>();
  for (const it of items) {
    const key = it.category ?? "";
    const g = groups.get(key) ?? [];
    g.push(it);
    groups.set(key, g);
  }

  return (
    <div className="flex flex-col gap-6 py-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Inventory</h1>
        <span className="text-sm text-neutral-500">{items.length} items</span>
      </div>
      <Flash ok={sp.ok} error={sp.error} />

      <details className="rounded-xl border border-neutral-200 bg-white" open={items.length === 0}>
        <summary className="flex min-h-14 cursor-pointer list-none items-center px-4 text-base font-medium">+ Add item</summary>
        <div className="border-t border-neutral-200 p-4">
          <InventoryItemForm saveAction={createInventoryItem} submitLabel="Add item" />
        </div>
      </details>

      {items.length === 0 ? (
        <p className="text-sm text-neutral-500">
          Nothing here yet. Items appear when you post an invoice or{" "}
          <Link href="/menu" className="underline">
            draft recipes
          </Link>
          .
        </p>
      ) : null}

      {[...groups.entries()].map(([cat, rows]) => (
        <section key={cat || "uncategorized"} className="flex flex-col gap-2">
          <h2 className="text-lg font-medium">
            {categoryLabel(cat)} <span className="text-sm font-normal text-neutral-500">({rows.length})</span>
          </h2>
          <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
            {rows.map((it) => (
              <li key={it.id}>
                <details>
                  <summary className="flex min-h-14 cursor-pointer list-none items-center justify-between gap-3 px-4 py-2">
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{it.name}</span>
                      <span className="text-sm text-neutral-500">
                        {it.base_unit}
                        {it.pack_to_base_factor !== null ? ` · ${fmtQty(it.pack_to_base_factor)} ${it.base_unit}/pack` : " · pack size unknown"}
                        {it.origin === "recipe_draft" && !it.first_invoiced_at ? " · never on an invoice" : ""}
                      </span>
                    </span>
                    <span className="shrink-0 text-right text-sm tabular-nums">
                      {it.cost_per_base_unit !== null ? (
                        <>
                          {fmtUnitCost(it.cost_per_base_unit)}
                          <span className="text-neutral-500">/{it.base_unit}</span>
                        </>
                      ) : (
                        <span className="text-neutral-400">no cost</span>
                      )}
                    </span>
                  </summary>
                  <div className="border-t border-neutral-100 bg-neutral-50 p-4">
                    <InventoryItemForm item={it} saveAction={updateInventoryItem} deleteAction={deleteInventoryItem} submitLabel="Save" />
                  </div>
                </details>
              </li>
            ))}
          </ul>
        </section>
      ))}

      <CatalogHealthSection health={health} items={items} />
      <ArchivedSection archived={archived} />
    </div>
  );
}

const ORIGIN_LABEL: Record<string, string> = { invoice: "from an invoice", recipe_draft: "from a recipe draft", manual: "added by hand" };

/**
 * "N ingredients have never appeared on an invoice" — the catalog is derived
 * from invoices (BLUEPRINT §1); draft-born items that no invoice ever mentions
 * are merged into the item that owns their history, or archived, in one tap.
 */
function CatalogHealthSection({ health, items }: { health: Health[]; items: Tables<"inventory_items">[] }) {
  const never = health.filter((h) => h.archived_at == null && !h.has_invoice_line);
  if (never.length === 0) return null;
  const orphans = never.filter((h) => h.status === "orphan").length;
  const dormant = health.filter((h) => h.status === "dormant").length;
  const targets = items.filter((i) => i.origin === "invoice" || i.first_invoiced_at != null);
  const fallbackTargets = items;
  const selectCls = "h-12 min-w-0 flex-1 rounded-xl border border-neutral-300 bg-white px-3 text-base";
  return (
    <section className="flex flex-col gap-2 rounded-2xl border border-amber-200 bg-amber-50 p-4">
      <h2 className="text-lg font-medium">
        {never.length} ingredient{never.length === 1 ? "" : "s"} {never.length === 1 ? "has" : "have"} never appeared on an invoice
      </h2>
      <p className="text-sm text-neutral-700">
        They were drafted from the menu. Merge each into the invoice-backed item it really is, or archive it (hidden from verify and the nightly
        reconciliation, never deleted). {orphans > 0 ? `${orphans} older than 30 days.` : ""} {dormant > 0 ? `${dormant} invoice-born item${dormant === 1 ? "" : "s"} with no purchase in 90 days.` : ""}
      </p>
      <details>
        <summary className="flex min-h-12 cursor-pointer list-none items-center text-base font-medium underline">Show the list</summary>
        <ul className="mt-2 divide-y divide-amber-200 rounded-xl border border-amber-200 bg-white">
          {never.map((h) => {
            const options = (targets.length ? targets : fallbackTargets).filter((t) => t.id !== h.inventory_item_id);
            return (
              <li key={h.inventory_item_id ?? h.name ?? ""} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0 truncate font-medium">{h.name}</span>
                  <span className="shrink-0 text-xs text-neutral-500">
                    {h.status === "orphan" ? "orphan" : "pending"} · {h.days_since_created ?? 0}d · {ORIGIN_LABEL[h.origin ?? ""] ?? h.origin}
                    {h.recipe_count ? ` · ${h.recipe_count} recipe${h.recipe_count === 1 ? "" : "s"}` : ""}
                  </span>
                </div>
                <form className="flex flex-wrap gap-2">
                  <input type="hidden" name="id" value={h.inventory_item_id ?? ""} />
                  <select name="target" className={selectCls} aria-label={`Merge ${h.name} into`} defaultValue="">
                    <option value="">Merge into…</option>
                    {options.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                  <button formAction={mergeInventoryItem} className="h-12 rounded-xl bg-neutral-900 px-4 text-base font-medium text-white">
                    Merge
                  </button>
                  <button formAction={archiveInventoryItem} className="h-12 rounded-xl border border-neutral-300 bg-white px-4 text-base font-medium">
                    Archive
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      </details>
    </section>
  );
}

function ArchivedSection({ archived }: { archived: Tables<"inventory_items">[] }) {
  if (archived.length === 0) return null;
  return (
    <details className="rounded-xl border border-neutral-200 bg-white">
      <summary className="flex min-h-14 cursor-pointer list-none items-center px-4 text-base font-medium text-neutral-600">
        Archived ({archived.length})
      </summary>
      <ul className="divide-y divide-neutral-200 border-t border-neutral-200">
        {archived.map((it) => (
          <li key={it.id} className="flex min-h-14 items-center justify-between gap-3 px-4 py-2">
            <span className="min-w-0 truncate text-sm">
              {it.name}
              {it.merged_into_id ? <span className="text-neutral-500"> · merged</span> : null}
            </span>
            <form>
              <input type="hidden" name="id" value={it.id} />
              <button formAction={restoreInventoryItem} className="h-11 rounded-xl border border-neutral-300 bg-white px-3 text-sm font-medium">
                Restore
              </button>
            </form>
          </li>
        ))}
      </ul>
    </details>
  );
}
