/**
 * pnpm pmix --date YYYY-MM-DD [--json]
 * Prints SUM(quantity_sold) per item for one business date, for comparison with
 * Toast Web → Reports → Product Mix. Names come from menu_items when synced,
 * otherwise from the displayName in the raw orders.
 */
import "./_env";
import { arg, hasFlag } from "./_env";
import { createServiceSupabase } from "@/lib/db/service";
import { OrderSchema } from "@/lib/toast/schemas";

export type PmixRow = { guid: string; name: string; sold: string; voided: string; net_sales: string };

export async function pmixForDate(date: string, locationId?: string): Promise<{ rows: PmixRow[]; orders: number; checks: number; checkTotal: string }> {
  const svc = createServiceSupabase();
  let lq = svc.from("locations").select("id, tenant_id").order("created_at").limit(1);
  if (locationId) lq = lq.eq("id", locationId);
  const { data: locs } = await lq;
  const loc = locs?.[0];
  if (!loc) throw new Error("no location");

  const { data: facts, error } = await svc
    .from("sales_facts")
    .select("toast_menu_item_guid, quantity_sold, quantity_voided, net_sales, menu_items(name)")
    .eq("location_id", loc.id)
    .eq("business_date", date);
  if (error) throw error;

  // Names + independent check totals from the raw payloads
  const names = new Map<string, string>();
  let orders = 0;
  let checks = 0;
  let checkTotal = 0;
  for (let from = 0; ; from += 500) {
    const { data } = await svc
      .from("toast_orders_raw")
      .select("payload")
      .eq("location_id", loc.id)
      .eq("business_date", date)
      .range(from, from + 499);
    for (const r of data ?? []) {
      const o = OrderSchema.safeParse(r.payload);
      if (!o.success || o.data.deleted) continue;
      orders++;
      for (const c of o.data.checks ?? []) {
        if (c.deleted) continue;
        checks++;
        if (!o.data.voided && !c.voided) checkTotal += c.amount ?? 0;
        const walk = (sels: typeof c.selections) => {
          for (const s of sels ?? []) {
            if (s.item?.guid && s.displayName) names.set(s.item.guid, s.displayName);
            walk(s.modifiers ?? []);
          }
        };
        walk(c.selections);
      }
    }
    if (!data || data.length < 500) break;
  }

  const rows: PmixRow[] = (facts ?? [])
    .map((f) => ({
      guid: f.toast_menu_item_guid ?? "",
      name: f.menu_items?.name ?? names.get(f.toast_menu_item_guid ?? "") ?? f.toast_menu_item_guid ?? "?",
      sold: String(f.quantity_sold),
      voided: String(f.quantity_voided),
      net_sales: String(f.net_sales ?? "0"),
    }))
    .sort((a, b) => Number(b.sold) - Number(a.sold) || a.name.localeCompare(b.name));
  return { rows, orders, checks, checkTotal: checkTotal.toFixed(2) };
}

async function main() {
  const date = arg("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error("usage: pnpm pmix --date YYYY-MM-DD [--json]");
    process.exit(2);
  }
  const res = await pmixForDate(date, arg("location"));
  if (hasFlag("json")) {
    console.log(JSON.stringify(res, null, 2));
    return;
  }
  console.log(`Product mix for business date ${date} — ${res.orders} orders, ${res.checks} checks, Σ check amount $${res.checkTotal}`);
  console.table(res.rows.map((r) => ({ item: r.name, sold: r.sold, voided: r.voided, net_sales: r.net_sales })));
  const totalSold = res.rows.reduce((a, r) => a + Number(r.sold), 0);
  const totalNet = res.rows.reduce((a, r) => a + Number(r.net_sales), 0);
  console.log(`Σ quantity_sold = ${totalSold.toFixed(2)}   Σ net_sales = $${totalNet.toFixed(2)}`);
}

if (process.argv[1]?.endsWith("pmix.ts")) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
