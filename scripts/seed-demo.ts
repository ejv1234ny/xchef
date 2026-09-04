/**
 * pnpm seed:demo — the Mad Moose demo dataset (same numbers as scripts/seed-demo.sql).
 * Idempotent: every row is keyed by name / sku / content_hash / (invoice, line_no)
 * and upserted. Creates the tenant + location if none exist (like scripts/creds.ts).
 *
 * The only computed numbers are invoice_lines.quantity_base_unit and
 * cost_per_base_unit — what the map job writes — done in Decimal.
 */
import "./_env";
import Decimal from "decimal.js";
import { createServiceSupabase, type ServiceClient } from "@/lib/db/service";
import { addDays, todayIn } from "@/lib/core/dates";
import type { Database } from "@/lib/db/types";

type Uom = Database["public"]["Enums"]["uom"];
type RecipeSource = Database["public"]["Enums"]["recipe_source"];

const num = (d: Decimal | number | string, dp = 4): number => Number(new Decimal(d).toFixed(dp));

async function ensureTenantAndLocation(svc: ServiceClient) {
  let { data: locations } = await svc.from("locations").select("*").order("created_at").limit(1);
  if (!locations?.length) {
    const { data: t, error } = await svc.from("tenants").insert({ name: "Mad Moose" }).select("id").single();
    if (error) throw error;
    const { error: lerr } = await svc.from("locations").insert({
      tenant_id: t.id,
      name: "Mad Moose Bar & Grill",
      timezone: "America/New_York",
      inbound_email_slug: "madmoose",
    });
    if (lerr) throw lerr;
    ({ data: locations } = await svc.from("locations").select("*").order("created_at").limit(1));
  }
  const location = locations![0];
  return { tenantId: location.tenant_id, locationId: location.id, timezone: location.timezone };
}

async function main() {
  const svc = createServiceSupabase();
  const { tenantId, locationId, timezone } = await ensureTenantAndLocation(svc);
  const today = todayIn(timezone);
  const ago = (n: number) => addDays(today, -n);

  // ---------------------------------------------------------- inventory items
  const itemSpecs: Array<{ name: string; category: string; base_unit: Uom; pack: string; cost: string }> = [
    { name: "Tequila - Blanco", category: "liquor", base_unit: "oz", pack: "25.36", cost: "1.7259" },
    { name: "Ketchup", category: "dry", base_unit: "oz", pack: "636", cost: "0.0983" }, // 6 × 106 oz
    { name: "Tomatoes", category: "produce", base_unit: "lb", pack: "25", cost: "2.24" },
    { name: "Limes", category: "produce", base_unit: "each", pack: "40", cost: "0.35" },
    { name: "Simple Syrup", category: "bar", base_unit: "oz", pack: "32", cost: "0.09" },
  ];
  const items = new Map<string, string>();
  for (const s of itemSpecs) {
    const { data, error } = await svc
      .from("inventory_items")
      .upsert(
        { tenant_id: tenantId, name: s.name, category: s.category, base_unit: s.base_unit, pack_to_base_factor: num(s.pack), cost_per_base_unit: num(s.cost) },
        { onConflict: "tenant_id,name" },
      )
      .select("id")
      .single();
    if (error) throw error;
    items.set(s.name, data.id);
  }
  const item = (name: string) => items.get(name)!;

  // ---------------------------------------------------------------- menu items
  const menuSpecs = [
    { guid: "demo-marg", name: "Classic Margarita", category: "cocktails", price: "12.00", recipe_status: "needs_review" as const },
    { guid: "demo-burger", name: "Moose Burger", category: "entrees", price: "17.00", recipe_status: "needs_review" as const },
    { guid: "demo-sub-patron", name: "Sub Patron", category: "modifiers", price: "3.00", recipe_status: "draft" as const },
  ];
  const menu = new Map<string, string>();
  for (const m of menuSpecs) {
    const { data, error } = await svc
      .from("menu_items")
      .upsert(
        { tenant_id: tenantId, toast_menu_item_guid: m.guid, name: m.name, category: m.category, price: num(m.price, 2), recipe_status: m.recipe_status },
        { onConflict: "tenant_id,toast_menu_item_guid" },
      )
      .select("id")
      .single();
    if (error) throw error;
    menu.set(m.guid, data.id);
  }

  // ------------------------------------------------------------------ recipes
  const recipes: Array<{ menu: string; item: string; quantity: string; unit: Uom; source: RecipeSource; confidence: string }> = [
    { menu: "demo-marg", item: "Tequila - Blanco", quantity: "1.5", unit: "oz", source: "confirmed", confidence: "1.00" },
    { menu: "demo-marg", item: "Simple Syrup", quantity: "0.5", unit: "oz", source: "ai_draft", confidence: "0.70" },
    { menu: "demo-marg", item: "Limes", quantity: "1", unit: "each", source: "confirmed", confidence: "1.00" },
    { menu: "demo-burger", item: "Tomatoes", quantity: "0.1", unit: "lb", source: "confirmed", confidence: "1.00" },
    { menu: "demo-burger", item: "Ketchup", quantity: "1", unit: "oz", source: "ai_draft", confidence: "0.60" },
  ];
  const { error: rerr } = await svc.from("recipe_components").upsert(
    recipes.map((r) => ({
      menu_item_id: menu.get(r.menu)!,
      inventory_item_id: item(r.item),
      quantity: num(r.quantity),
      unit: r.unit,
      source: r.source,
      confidence: num(r.confidence, 2),
      confirmed_at: r.source === "confirmed" ? new Date().toISOString() : null,
    })),
    { onConflict: "menu_item_id,inventory_item_id" },
  );
  if (rerr) throw rerr;

  // ------------------------------------------ sales, last 14 business dates
  const sales: Database["public"]["Tables"]["sales_facts"]["Insert"][] = [];
  for (let i = 1; i <= 14; i++) {
    const day = ago(i);
    const marg = i === 3 ? 72 : 20 + ((i * 7) % 41); // 72 on the busiest day, 20–60 otherwise
    const burger = 30 + ((i * 5) % 21); // 30–50
    const sub = 5 + (i % 6); // 5–10
    sales.push(
      { location_id: locationId, menu_item_id: menu.get("demo-marg")!, toast_menu_item_guid: "demo-marg", business_date: day, quantity_sold: marg, quantity_voided: 0, net_sales: num(new Decimal(marg).mul("12.00"), 2) },
      { location_id: locationId, menu_item_id: menu.get("demo-burger")!, toast_menu_item_guid: "demo-burger", business_date: day, quantity_sold: burger, quantity_voided: 0, net_sales: num(new Decimal(burger).mul("17.00"), 2) },
      { location_id: locationId, menu_item_id: menu.get("demo-sub-patron")!, toast_menu_item_guid: "demo-sub-patron", business_date: day, quantity_sold: sub, quantity_voided: 0, net_sales: num(new Decimal(sub).mul("3.00"), 2) },
    );
  }
  const { error: serr } = await svc.from("sales_facts").upsert(sales, { onConflict: "location_id,toast_menu_item_guid,business_date", ignoreDuplicates: true });
  if (serr) throw serr;

  // ------------------------------------------------------------------ vendors
  const vendors = new Map<string, string>();
  for (const v of [
    { name: "Sysco", email_domains: ["sysco.com"] },
    { name: "Restaurant Depot", email_domains: ["restaurantdepot.com"] },
  ]) {
    const { data, error } = await svc.from("vendors").upsert({ tenant_id: tenantId, ...v }, { onConflict: "tenant_id,name" }).select("id").single();
    if (error) throw error;
    vendors.set(v.name, data.id);
  }

  // ----------------------------------------------------------------- mappings
  const mappingSpecs = [
    { vendor: "Sysco", sku: "1234567", desc: "ketchup 6/#10", item: "Ketchup", upp: "6", bupu: "106", pack: "6/#10", brand: "Heinz" },
    { vendor: "Restaurant Depot", sku: "RD-8891", desc: "ketchup 3/114oz", item: "Ketchup", upp: "3", bupu: "114", pack: "3/114OZ", brand: "Hunt's" },
    { vendor: "Sysco", sku: "2345678", desc: "tomatoes 25 lb", item: "Tomatoes", upp: "1", bupu: "25", pack: "25 LB", brand: null },
    { vendor: "Sysco", sku: "3456789", desc: "tequila blanco 12/750ml", item: "Tequila - Blanco", upp: "12", bupu: "25.36", pack: "12/750ML", brand: null },
  ];
  const mappings = new Map<string, { id: string; perPack: Decimal }>();
  for (const m of mappingSpecs) {
    const { data, error } = await svc
      .from("vendor_item_mappings")
      .upsert(
        {
          tenant_id: tenantId,
          vendor_id: vendors.get(m.vendor)!,
          vendor_sku: m.sku,
          description_norm: m.desc,
          inventory_item_id: item(m.item),
          units_per_pack: num(m.upp),
          base_units_per_unit: num(m.bupu),
          pack_description: m.pack,
          brand: m.brand,
          confirmed_at: new Date().toISOString(),
        },
        { onConflict: "vendor_id,vendor_sku" },
      )
      .select("id")
      .single();
    if (error) throw error;
    mappings.set(m.sku, { id: data.id, perPack: new Decimal(m.upp).mul(m.bupu) });
  }

  // ----------------------------------------------------------------- invoices
  type LineSpec = { sku: string; description: string; pack: string; item: string; qty: string; unit: string; ext: string };
  const invoiceSpecs: Array<{ n: number; vendor: string; daysAgo: number; lines: LineSpec[] }> = [
    {
      n: 1,
      vendor: "Sysco",
      daysAgo: 40,
      lines: [
        { sku: "1234567", description: "KETCHUP 6/#10", pack: "6/#10", item: "Ketchup", qty: "2", unit: "62.50", ext: "125.00" },
        { sku: "2345678", description: "TOMATOES 25 LB", pack: "25 LB", item: "Tomatoes", qty: "4", unit: "28.00", ext: "112.00" },
        { sku: "3456789", description: "TEQUILA BLANCO 12/750ML", pack: "12/750ML", item: "Tequila - Blanco", qty: "1", unit: "360.00", ext: "360.00" },
      ],
    },
    {
      n: 2,
      vendor: "Restaurant Depot",
      daysAgo: 20,
      lines: [{ sku: "RD-8891", description: "KETCHUP 3/114OZ", pack: "3/114OZ", item: "Ketchup", qty: "3", unit: "67.19", ext: "201.57" }],
    },
    {
      n: 3,
      vendor: "Sysco",
      daysAgo: 5,
      lines: [
        { sku: "2345678", description: "TOMATOES 25 LB", pack: "25 LB", item: "Tomatoes", qty: "2", unit: "56.00", ext: "112.00" },
        { sku: "1234567", description: "KETCHUP 6/#10", pack: "6/#10", item: "Ketchup", qty: "1", unit: "62.50", ext: "62.50" },
        { sku: "3456789", description: "TEQUILA BLANCO 12/750ML", pack: "12/750ML", item: "Tequila - Blanco", qty: "1", unit: "360.00", ext: "360.00" },
      ],
    },
  ];
  for (const inv of invoiceSpecs) {
    const subtotal = inv.lines.reduce((acc, l) => acc.plus(l.ext), new Decimal(0));
    const date = ago(inv.daysAgo);
    const { data: doc, error } = await svc
      .from("invoice_documents")
      .upsert(
        {
          location_id: locationId,
          vendor_id: vendors.get(inv.vendor)!,
          source: "manual",
          status: "posted",
          storage_path: `demo/${inv.n}.json`,
          content_hash: `demo-${inv.n}`,
          invoice_number: `DEMO-${inv.n}`,
          invoice_date: date,
          received_date: date,
          subtotal: num(subtotal, 2),
          tax: 0,
          total: num(subtotal, 2),
          parse_confidence: 1,
          posted_at: new Date().toISOString(),
        },
        { onConflict: "location_id,content_hash" },
      )
      .select("id")
      .single();
    if (error) throw error;

    const { error: lerr } = await svc.from("invoice_lines").upsert(
      inv.lines.map((l, i) => {
        const m = mappings.get(l.sku)!;
        // quantity × units_per_pack × base_units_per_unit; extended_price / that.
        const qtyBase = new Decimal(l.qty).mul(m.perPack);
        return {
          invoice_id: doc.id,
          line_no: i + 1,
          vendor_sku: l.sku,
          description: l.description,
          pack_size_text: l.pack,
          quantity: num(l.qty),
          unit_price: num(l.unit),
          extended_price: num(l.ext, 2),
          status: "confirmed" as const,
          mapping_id: m.id,
          inventory_item_id: item(l.item),
          quantity_base_unit: num(qtyBase),
          cost_per_base_unit: num(new Decimal(l.ext).div(qtyBase), 6),
        };
      }),
      { onConflict: "invoice_id,line_no" },
    );
    if (lerr) throw lerr;
  }

  // ------------------------------------------------------------- stock counts
  const counts: Database["public"]["Tables"]["stock_counts"]["Insert"][] = [
    // Tequila: ✓ baseline 24 days ago, then a real count 10 days ago (so count_variance has a row).
    { location_id: locationId, inventory_item_id: item("Tequila - Blanco"), count_date: ago(24), position: "close", counted_at: `${ago(24)}T23:00:00Z`, quantity_base_unit: 600, verification: "confirmed_estimate", estimate_at_count: 600 },
    { location_id: locationId, inventory_item_id: item("Tequila - Blanco"), count_date: ago(10), position: "close", counted_at: `${ago(10)}T23:00:00Z`, quantity_base_unit: num("297.76"), verification: "counted", estimate_at_count: 300 },
    // Ketchup: ✓ tap 10 days ago.
    { location_id: locationId, inventory_item_id: item("Ketchup"), count_date: ago(10), position: "close", counted_at: `${ago(10)}T23:00:00Z`, quantity_base_unit: 1200, verification: "confirmed_estimate", estimate_at_count: 1200 },
  ];
  const { error: cerr } = await svc.from("stock_counts").upsert(counts, { onConflict: "location_id,inventory_item_id,count_date,position", ignoreDuplicates: true });
  if (cerr) throw cerr;

  // ----------------------------------------------------------------- verify
  const checks = await Promise.all([
    svc.from("on_hand_estimate").select("inventory_item_id", { count: "exact", head: true }).eq("location_id", locationId),
    svc.from("count_variance").select("inventory_item_id", { count: "exact", head: true }).eq("location_id", locationId),
    svc.from("verification_queue").select("inventory_item_id", { count: "exact", head: true }).eq("location_id", locationId),
    svc.from("vendor_price_comparison").select("inventory_item_id", { count: "exact", head: true }).eq("tenant_id", tenantId),
    svc.from("vendor_switch_savings").select("inventory_item_id", { count: "exact", head: true }).eq("location_id", locationId),
    svc.from("unit_cogs_master").select("inventory_item_id", { count: "exact", head: true }).eq("tenant_id", tenantId),
    svc.from("menu_item_cost").select("menu_item_id", { count: "exact", head: true }).eq("tenant_id", tenantId),
  ]);
  const names = ["on_hand_estimate", "count_variance", "verification_queue", "vendor_price_comparison", "vendor_switch_savings", "unit_cogs_master", "menu_item_cost"];
  checks.forEach((c, i) => console.log(`${names[i].padEnd(26)} ${c.error ? `ERROR ${c.error.message}` : `${c.count ?? 0} rows`}`));
  console.log(`Demo seeded for tenant ${tenantId}, location ${locationId}.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
