import Link from "next/link";
import Decimal from "decimal.js";
import { getAppContext } from "@/lib/db/context";
import { createServerSupabase } from "@/lib/db/server";
import type { Enums, Tables } from "@/lib/db/types";
import { addDays, todayIn } from "@/lib/core/dates";
import { StatusChip, fmtCount, fmtMoney, fmtQty } from "@/components/inventory-units";

export const metadata = { title: "Usage" };

const PAGE = 1000;
const ISO = /^\d{4}-\d{2}-\d{2}$/;

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

type UsedRow = { id: string; name: string; base_unit: Enums<"uom">; quantity: Decimal; cost: Decimal };
type MenuLine = { inventory_item_id: string; inventory_item_name: string; base_unit: Enums<"uom">; quantity_used: Decimal };
type MenuGroup = { menu_item_id: string; name: string; units_all_time: Decimal; units_in_range: Decimal; lines: MenuLine[] };

const dec = (v: number | string | null | undefined) => new Decimal(v ?? 0);

export default async function UsagePage({ searchParams }: PageProps<"/usage">) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();
  const today = todayIn(ctx.location.timezone);
  const to = typeof sp.to === "string" && ISO.test(sp.to) ? sp.to : today;
  const from = typeof sp.from === "string" && ISO.test(sp.from) && sp.from <= to ? sp.from : addDays(to, -6);
  const locationId = ctx.location.id;

  const [periodRows, menuRows, salesRows] = await Promise.all([
    pageAll<Tables<"usage_by_period">>((a, b) =>
      supabase
        .from("usage_by_period")
        .select("*")
        .eq("location_id", locationId)
        .gte("business_date", from)
        .lte("business_date", to)
        .order("inventory_item_id")
        .order("business_date")
        .range(a, b),
    ),
    pageAll<Tables<"usage_by_menu_item">>((a, b) =>
      supabase.from("usage_by_menu_item").select("*").eq("location_id", locationId).order("menu_item_id").order("inventory_item_id").range(a, b),
    ),
    pageAll<{ menu_item_id: string | null; quantity_sold: number }>((a, b) =>
      supabase
        .from("sales_facts")
        .select("menu_item_id, quantity_sold")
        .eq("location_id", locationId)
        .gte("business_date", from)
        .lte("business_date", to)
        .not("menu_item_id", "is", null)
        .order("id")
        .range(a, b),
    ),
  ]);

  // Section A: sum the view's per-day rows per ingredient (addition only).
  const used = new Map<string, UsedRow>();
  for (const r of periodRows) {
    if (!r.inventory_item_id) continue;
    const cur = used.get(r.inventory_item_id) ?? {
      id: r.inventory_item_id,
      name: r.inventory_item_name ?? "",
      base_unit: r.base_unit ?? "each",
      quantity: new Decimal(0),
      cost: new Decimal(0),
    };
    cur.quantity = cur.quantity.plus(dec(r.quantity_used));
    cur.cost = cur.cost.plus(dec(r.usage_cost));
    used.set(r.inventory_item_id, cur);
  }
  const usedList = [...used.values()].sort((a, b) => b.cost.cmp(a.cost) || b.quantity.cmp(a.quantity) || a.name.localeCompare(b.name));
  const totalCost = usedList.reduce((s, r) => s.plus(r.cost), new Decimal(0));

  // Section B: the view's all-time "→" lines, plus units sold in range from sales_facts (a count).
  const soldInRange = new Map<string, Decimal>();
  for (const r of salesRows) if (r.menu_item_id) soldInRange.set(r.menu_item_id, (soldInRange.get(r.menu_item_id) ?? new Decimal(0)).plus(dec(r.quantity_sold)));

  const groups = new Map<string, MenuGroup>();
  for (const r of menuRows) {
    if (!r.menu_item_id || !r.inventory_item_id) continue;
    const g = groups.get(r.menu_item_id) ?? {
      menu_item_id: r.menu_item_id,
      name: r.menu_item_name ?? "",
      units_all_time: dec(r.units_sold),
      units_in_range: soldInRange.get(r.menu_item_id) ?? new Decimal(0),
      lines: [],
    };
    g.lines.push({
      inventory_item_id: r.inventory_item_id,
      inventory_item_name: r.inventory_item_name ?? "",
      base_unit: r.base_unit ?? "each",
      quantity_used: dec(r.quantity_used),
    });
    groups.set(r.menu_item_id, g);
  }
  const groupList = [...groups.values()].sort((a, b) => b.units_in_range.cmp(a.units_in_range) || b.units_all_time.cmp(a.units_all_time) || a.name.localeCompare(b.name));
  for (const g of groupList) g.lines.sort((a, b) => b.quantity_used.cmp(a.quantity_used));

  const statusById = new Map<string, Enums<"recipe_status">>();
  const menuIds = groupList.map((g) => g.menu_item_id);
  for (let i = 0; i < menuIds.length; i += 200) {
    const { data } = await supabase.from("menu_items").select("id, recipe_status").in("id", menuIds.slice(i, i + 200));
    for (const m of data ?? []) statusById.set(m.id, m.recipe_status);
  }

  const preset = (days: number) => `/usage?from=${addDays(today, -(days - 1))}&to=${today}`;
  const inputCls = "h-12 w-full rounded-xl border border-neutral-300 bg-white px-3 text-base";
  const isPreset = (days: number) => to === today && from === addDays(today, -(days - 1));
  const chip = (active: boolean) =>
    `flex h-11 items-center rounded-full px-4 text-sm font-medium ${active ? "bg-neutral-900 text-white" : "border border-neutral-300 bg-white"}`;

  return (
    <div className="flex flex-col gap-6 py-4">
      <h1 className="text-2xl font-semibold">Usage</h1>

      <form method="get" action="/usage" className="flex flex-col gap-3">
        <div className="flex gap-2">
          <Link href={preset(7)} className={chip(isPreset(7))}>
            7 days
          </Link>
          <Link href={preset(30)} className={chip(isPreset(30))}>
            30 days
          </Link>
        </div>
        <div className="grid grid-cols-[1fr_1fr_auto] items-end gap-2">
          <label className="text-xs text-neutral-600">
            From
            <input type="date" name="from" defaultValue={from} max={to} className={inputCls} />
          </label>
          <label className="text-xs text-neutral-600">
            To
            <input type="date" name="to" defaultValue={to} max={today} className={inputCls} />
          </label>
          <button className="h-12 rounded-xl border border-neutral-300 bg-white px-4 text-base font-medium">Go</button>
        </div>
      </form>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">What you used</h2>
          <span className="text-sm text-neutral-500">
            {from} → {to}
            {totalCost.gt(0) ? ` · ${fmtMoney(totalCost.toString())}` : ""}
          </span>
        </div>
        {usedList.length ? (
          <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
            {usedList.map((r) => (
              <li key={r.id} className="flex min-h-14 items-center justify-between gap-3 px-4 py-2">
                <span className="min-w-0">
                  <span className="font-medium tabular-nums">
                    {fmtQty(r.quantity.toString())} {r.base_unit}
                  </span>{" "}
                  <span className="text-neutral-700">{r.name}</span>
                </span>
                {r.cost.gt(0) ? <span className="shrink-0 tabular-nums text-neutral-700">{fmtMoney(r.cost.toString())}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-neutral-300 bg-white p-4 text-sm text-neutral-600">
            Nothing used in this range. Usage needs synced sales and a recipe for what sold —{" "}
            <Link href="/recipes" className="underline">
              confirm recipes
            </Link>{" "}
            or{" "}
            <Link href="/settings" className="underline">
              sync sales
            </Link>
            .
          </p>
        )}
        {usedList.some((r) => r.cost.eq(0)) ? (
          <p className="text-xs text-neutral-500">
            Items without a $ have no cost on file yet. Post an invoice or set one in{" "}
            <Link href="/inventory" className="underline">
              Inventory
            </Link>
            .
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between">
          <h2 className="text-lg font-medium">By menu item</h2>
          <span className="text-sm text-neutral-500">→ lines cover all synced days</span>
        </div>
        {groupList.length ? (
          <ul className="flex flex-col gap-2">
            {groupList.map((g) => {
              const status = statusById.get(g.menu_item_id);
              return (
                <li key={g.menu_item_id} className="rounded-xl border border-neutral-200 bg-white px-4 py-3">
                  <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <span className="font-medium">
                      <span className="tabular-nums">{fmtCount(g.units_in_range.toString())}</span> {g.name}
                      <span className="text-sm font-normal text-neutral-500"> in range</span>
                    </span>
                    {status && status !== "confirmed" ? <StatusChip status={status} /> : null}
                  </div>
                  <ul className="mt-1 flex flex-col gap-0.5 text-sm text-neutral-700">
                    {g.lines.map((l) => (
                      <li key={l.inventory_item_id} className="tabular-nums">
                        {fmtCount(g.units_all_time.toString())} sold all-time → {fmtQty(l.quantity_used.toString())} {l.base_unit} {l.inventory_item_name}
                      </li>
                    ))}
                  </ul>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="rounded-xl border border-dashed border-neutral-300 bg-white p-4 text-sm text-neutral-600">
            No menu item has both sales and a recipe yet.{" "}
            <Link href="/menu" className="underline">
              Draft recipes
            </Link>
            .
          </p>
        )}
      </section>
    </div>
  );
}
