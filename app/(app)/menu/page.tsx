import Link from "next/link";
import { getAppContext } from "@/lib/db/context";
import { createServerSupabase } from "@/lib/db/server";
import type { Tables } from "@/lib/db/types";
import { isAnthropicConfigured } from "@/lib/llm/anthropic";
import { Flash, StatusChip, fmtMoney, fmtPct } from "@/components/inventory-units";
import { draftNextBatch } from "./actions";

export const metadata = { title: "Menu & plate cost" };

const PAGE = 1000;

async function loadMenuCost(tenantId: string): Promise<Tables<"menu_item_cost">[]> {
  const supabase = await createServerSupabase();
  const out: Tables<"menu_item_cost">[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from("menu_item_cost")
      .select("*")
      .eq("tenant_id", tenantId)
      .order("cost_pct", { ascending: false, nullsFirst: false })
      .order("menu_item_name")
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

function Row({ r }: { r: Tables<"menu_item_cost"> }) {
  const hasRecipe = (r.component_count ?? 0) > 0;
  const unconfirmed = hasRecipe && r.recipe_status !== "confirmed";
  const unknownCost = hasRecipe && r.all_costs_known === false;
  const pct = r.cost_pct;
  const pctCls = pct === null ? "text-neutral-400" : pct >= 0.4 ? "text-red-700" : pct >= 0.3 ? "text-amber-700" : "text-emerald-700";
  return (
    <li className="flex min-h-14 items-center justify-between gap-3 px-4 py-2">
      <div className="min-w-0">
        <div className="truncate font-medium">{r.menu_item_name}</div>
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-neutral-500">
          {r.category ? <span>{r.category}</span> : null}
          <StatusChip status={r.recipe_status} />
          {unconfirmed ? <span className="text-amber-800">unconfirmed recipe</span> : null}
          {unknownCost ? <span className="text-red-700">unknown cost</span> : null}
        </div>
      </div>
      <div className="shrink-0 text-right tabular-nums">
        <div className="text-sm">
          {r.menu_price !== null ? fmtMoney(r.menu_price) : <span className="text-neutral-400">no price</span>}
          {hasRecipe ? <span className="text-neutral-500"> · cost {fmtMoney(r.plate_cost ?? 0)}</span> : null}
        </div>
        <div className={`text-lg font-semibold ${pctCls}`}>{pct !== null && hasRecipe ? fmtPct(pct) : "—"}</div>
      </div>
    </li>
  );
}

export default async function MenuPage({ searchParams }: PageProps<"/menu">) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  const rows = await loadMenuCost(ctx.tenant.id);
  const items = rows.filter((r) => r.category !== "modifier");
  const modifiers = rows.filter((r) => r.category === "modifier");
  const withoutComponents = items.filter((r) => (r.component_count ?? 0) === 0).length;
  const aiReady = isAnthropicConfigured();

  return (
    <div className="flex flex-col gap-6 py-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Menu & plate cost</h1>
        <span className="text-sm text-neutral-500">{items.length} items</span>
      </div>
      <Flash ok={sp.ok} error={sp.error} />

      <section className="flex flex-col gap-3 rounded-2xl border border-neutral-200 bg-white p-4">
        <p className="text-sm text-neutral-700">
          <span className="font-semibold tabular-nums">{withoutComponents}</span> menu items have no recipe yet. Drafting takes the best sellers first, ten at a time.
        </p>
        <form action={draftNextBatch}>
          <button
            className="h-14 w-full rounded-2xl bg-neutral-900 text-lg font-semibold text-white disabled:opacity-40"
            disabled={!aiReady || withoutComponents === 0}
          >
            Draft recipes for the next 10 items
          </button>
        </form>
        {!aiReady ? <p className="text-xs text-red-700">ANTHROPIC_API_KEY is not configured on the server.</p> : null}
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <Link href="/recipes" className="underline">
            Confirm in Recipe Q&A
          </Link>
          <Link href="/settings" className="underline">
            Sync menu now
          </Link>
        </div>
      </section>

      {items.length === 0 ? (
        <p className="rounded-xl border border-dashed border-neutral-300 bg-white p-4 text-sm text-neutral-600">
          No menu items yet. Store Toast credentials and sync the menu from{" "}
          <Link href="/settings" className="underline">
            Settings
          </Link>
          .
        </p>
      ) : (
        <section className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between">
            <h2 className="text-lg font-medium">Worst margins first</h2>
            <span className="text-xs text-neutral-500">cost as % of price</span>
          </div>
          <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
            {items.map((r) => (
              <Row key={r.menu_item_id} r={r} />
            ))}
          </ul>
        </section>
      )}

      {modifiers.length ? (
        <details className="rounded-xl border border-neutral-200 bg-white">
          <summary className="flex min-h-14 cursor-pointer list-none items-center px-4 text-base font-medium">
            Modifier options ({modifiers.length})
          </summary>
          <ul className="divide-y divide-neutral-200 border-t border-neutral-200">
            {modifiers.map((r) => (
              <Row key={r.menu_item_id} r={r} />
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}
