import Link from "next/link";
import { getAppContext } from "@/lib/db/context";
import { createServerSupabase } from "@/lib/db/server";
import type { Tables } from "@/lib/db/types";
import { InventoryItemForm } from "@/components/inventory-item-form";
import { Flash, categoryLabel, fmtQty, fmtUnitCost } from "@/components/inventory-units";
import { createInventoryItem, deleteInventoryItem, updateInventoryItem } from "./actions";

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

export default async function InventoryPage({ searchParams }: PageProps<"/inventory">) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  const items = await loadItems(ctx.tenant.id);

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
    </div>
  );
}
