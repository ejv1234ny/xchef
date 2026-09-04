import Link from "next/link";
import { getAppContext } from "@/lib/db/context";
import { createServerSupabase } from "@/lib/db/server";
import type { Tables } from "@/lib/db/types";
import { fmtDays, fmtMoney, fmtPacks, fmtQty, packWord, Chip } from "@/components/ui-format";

export const metadata = { title: "On-hand" };

const REORDER_DAYS = 3;

type Row = Tables<"on_hand_estimate"> & { category: string; days_of_supply: number | null };

export default async function OnHandPage() {
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();

  const [{ data: est, error }, { data: items }, { data: queue }] = await Promise.all([
    supabase.from("on_hand_estimate").select("*").eq("location_id", ctx.location.id),
    supabase.from("inventory_items").select("id, category").eq("tenant_id", ctx.tenant.id),
    supabase.from("verification_queue").select("inventory_item_id, days_of_supply").eq("location_id", ctx.location.id),
  ]);

  const categoryById = new Map((items ?? []).map((i) => [i.id, i.category ?? "Uncategorized"]));
  const daysById = new Map((queue ?? []).map((q) => [q.inventory_item_id ?? "", q.days_of_supply]));

  const rows: Row[] = (est ?? []).map((e) => ({
    ...e,
    category: categoryById.get(e.inventory_item_id ?? "") ?? "Uncategorized",
    days_of_supply: daysById.get(e.inventory_item_id ?? "") ?? null,
  }));

  // Group by category; sections ordered by total on-hand value (from the view) desc.
  const groups = new Map<string, { rows: Row[]; total: number }>();
  for (const r of rows) {
    const g = groups.get(r.category) ?? { rows: [], total: 0 };
    g.rows.push(r);
    g.total += r.on_hand_value ?? 0;
    groups.set(r.category, g);
  }
  const sections = [...groups.entries()].sort((a, b) => b[1].total - a[1].total);
  for (const [, g] of sections) g.rows.sort((a, b) => (b.on_hand_value ?? 0) - (a.on_hand_value ?? 0));

  return (
    <div className="flex flex-col gap-6 py-4">
      <h1 className="text-2xl font-semibold">On-hand</h1>
      {error ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error.message}</p> : null}

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-6 text-center text-sm text-neutral-600">
          No inventory items yet. Post an invoice on <Link href="/invoices" className="underline">Invoices</Link> and items appear here with what you should have.
        </div>
      ) : null}

      {sections.map(([category, g]) => (
        <section key={category} className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-medium capitalize">{category}</h2>
            <span className="text-sm text-neutral-500">{fmtMoney(g.total)}</span>
          </div>
          <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
            {g.rows.map((r) => (
              <OnHandRow key={r.inventory_item_id ?? r.inventory_item_name ?? ""} row={r} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function OnHandRow({ row }: { row: Row }) {
  const word = packWord(row.inventory_item_name, row.pack_to_base_factor, row.on_hand_packs ?? 2);
  const reorder = row.days_of_supply != null && row.days_of_supply < REORDER_DAYS;
  const days = fmtDays(row.days_of_supply);
  return (
    <li className="flex min-h-14 flex-col gap-1 px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{row.inventory_item_name}</span>
            {reorder ? <Chip className="bg-red-100 text-red-900">reorder</Chip> : null}
          </div>
          <div className="text-sm text-neutral-600">
            {row.on_hand_packs != null && word ? (
              <>
                ~{fmtPacks(row.on_hand_packs)} {word} <span className="text-neutral-400">· {fmtQty(row.on_hand_qty)} {row.base_unit}</span>
              </>
            ) : (
              <>
                ~{fmtQty(row.on_hand_qty)} {row.base_unit}
              </>
            )}
            {days ? ` · ${days}` : ""}
          </div>
        </div>
        <span className="shrink-0 font-medium tabular-nums">{fmtMoney(row.on_hand_value)}</span>
      </div>
      {row.has_baseline === false ? (
        <p className="text-xs text-amber-800">
          net change since first invoice —{" "}
          <Link href="/?position=open" className="underline">
            verify to set a baseline
          </Link>
        </p>
      ) : null}
    </li>
  );
}
