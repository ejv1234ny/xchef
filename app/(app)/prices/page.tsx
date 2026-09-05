import Link from "next/link";
import { getAppContext } from "@/lib/db/context";
import { createServerSupabase } from "@/lib/db/server";
import type { Tables } from "@/lib/db/types";
import { Flash, fmtDate, fmtMoney, fmtPctChange, fmtQty, fmtUnitCost } from "@/components/ui-format";
import { askForPricing } from "./actions";

export const metadata = { title: "Prices" };

type Comparison = Tables<"vendor_price_comparison">;
type Forward = Tables<"forward_price_model">;

const btn2Cls = "inline-flex h-11 items-center rounded-xl border border-neutral-300 bg-white px-4 text-sm font-medium disabled:opacity-40";

/** "on quoted price valid through Sep 30" / "on last invoice" — the savings row says which number it used. */
function basisText(basis: string | null | undefined, validThrough: string | null | undefined): string {
  if (basis === "quote") return validThrough ? `on quoted price valid through ${fmtDate(validThrough)}` : "on quoted price";
  return "on last invoice";
}

export default async function PricesPage({ searchParams }: PageProps<"/prices">) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();

  const [{ data: savings, error: serr }, { data: comparison }, { data: master, error: merr }, { data: queue }, { data: forward }, { data: vendors }, { data: mappings }, { data: requests }] = await Promise.all([
    supabase.from("vendor_switch_savings").select("*").eq("location_id", ctx.location.id).order("savings_annualized", { ascending: false }),
    supabase.from("vendor_price_comparison").select("*").eq("tenant_id", ctx.tenant.id),
    supabase.from("unit_cogs_master").select("*").eq("tenant_id", ctx.tenant.id).order("name"),
    supabase.from("verification_queue").select("inventory_item_id, price_change_30d").eq("location_id", ctx.location.id),
    supabase.from("forward_price_model").select("*").eq("tenant_id", ctx.tenant.id),
    supabase.from("vendors").select("id, name, kind, contact_email").eq("tenant_id", ctx.tenant.id).order("name"),
    supabase.from("vendor_item_mappings").select("vendor_id").eq("tenant_id", ctx.tenant.id),
    supabase.from("quote_requests").select("vendor_id, sent_at, status, token").eq("tenant_id", ctx.tenant.id).order("sent_at", { ascending: false }).limit(200),
  ]);

  // Join in TS on inventory_item_id + vendor_name: the assumed base units per pack for each option.
  const optionKey = (itemId: string | null, vendor: string | null) => `${itemId ?? ""}|${vendor ?? ""}`;
  const optionsByKey = new Map<string, Comparison>();
  for (const c of comparison ?? []) optionsByKey.set(optionKey(c.inventory_item_id, c.vendor_name), c);
  const changeById = new Map((queue ?? []).map((q) => [q.inventory_item_id ?? "", q.price_change_30d]));

  // Valid quotes per ingredient (forward_price_model.basis = 'quote' means the quote is in force today).
  const quotesByItem = new Map<string, Forward[]>();
  for (const f of forward ?? []) {
    if (f.basis !== "quote" || f.best_quoted_cost == null || !f.inventory_item_id) continue;
    const list = quotesByItem.get(f.inventory_item_id) ?? [];
    list.push(f);
    quotesByItem.set(f.inventory_item_id, list);
  }
  const mappingCount = new Map<string, number>();
  for (const m of mappings ?? []) mappingCount.set(m.vendor_id, (mappingCount.get(m.vendor_id) ?? 0) + 1);
  const lastRequest = new Map<string, { sent_at: string; status: string; token: string }>();
  for (const r of requests ?? []) if (!lastRequest.has(r.vendor_id)) lastRequest.set(r.vendor_id, r);

  const overpaying = (savings ?? []).filter((s) => (s.savings_annualized ?? 0) > 0);
  const priced = (master ?? []).filter((m) => m.latest_cost_per_base_unit != null || quotesByItem.has(m.inventory_item_id ?? ""));
  const unpriced = (master ?? []).filter((m) => m.latest_cost_per_base_unit == null && !quotesByItem.has(m.inventory_item_id ?? ""));
  const askable = (vendors ?? []).filter((v) => (mappingCount.get(v.id) ?? 0) > 0);

  return (
    <div className="flex flex-col gap-8 py-4">
      <h1 className="text-2xl font-semibold">Prices</h1>
      <Flash ok={sp.ok} error={sp.error} />
      {serr ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{serr.message}</p> : null}
      {merr ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{merr.message}</p> : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">You&apos;re overpaying for…</h2>
        {overpaying.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-5 text-sm text-neutral-600">
            Nothing to compare yet. This list appears once the same ingredient has a price from <strong>2 or more vendors</strong> (posted invoices or a
            quote, any pack size) and it is used in a recipe that has sold in the last 30 days.{" "}
            <Link href="/invoices" className="underline">
              Post an invoice
            </Link>{" "}
            or ask a vendor for pricing below.
          </div>
        ) : (
          <ul className="flex flex-col gap-3">
            {overpaying.map((s) => {
              const cur = optionsByKey.get(optionKey(s.inventory_item_id, s.current_vendor));
              const best = optionsByKey.get(optionKey(s.inventory_item_id, s.cheapest_vendor));
              const unit = s.base_unit ?? "";
              return (
                <li key={`${s.inventory_item_id}-${s.current_vendor}-${s.current_pack}`} className="rounded-2xl border border-neutral-200 bg-white p-4">
                  <div className="flex items-start justify-between gap-3">
                    <h3 className="text-base font-semibold">{s.inventory_item_name}</h3>
                    <span className="shrink-0 rounded-full bg-emerald-100 px-2.5 py-1 text-sm font-semibold text-emerald-900">
                      ~{fmtMoney(s.savings_annualized)}/yr
                    </span>
                  </div>
                  <p className="mt-1 text-sm">
                    Switch to <span className="font-medium">{s.cheapest_vendor}</span> {s.cheapest_pack}: ~{fmtMoney(s.savings_annualized)}/yr{" "}
                    <span className={s.cheapest_basis === "quote" ? "font-medium text-sky-800" : "text-neutral-500"}>{basisText(s.cheapest_basis, s.cheapest_quote_valid_through)}</span>.
                  </p>
                  <p className="mt-1 text-sm">
                    <span className="font-medium">{s.current_vendor}</span> {s.current_pack} at {fmtUnitCost(s.current_cost)}/{unit}{" "}
                    <span className="text-neutral-500">({basisText(s.current_basis, cur?.quote_valid_through)})</span> <span className="text-neutral-500">vs</span>{" "}
                    <span className="font-medium">{s.cheapest_vendor}</span> {s.cheapest_pack} {fmtUnitCost(s.cheapest_cost)}/{unit}
                    {s.premium_pct != null ? <span className="text-neutral-500"> · {fmtPctChange(s.premium_pct)} premium</span> : null}
                  </p>
                  <dl className="mt-2 grid grid-cols-2 gap-2 text-xs text-neutral-600">
                    <AssumedPack label={s.current_vendor} option={cur} unit={unit} />
                    <AssumedPack label={s.cheapest_vendor} option={best} unit={unit} />
                  </dl>
                  <p className="mt-2 text-xs text-neutral-500">
                    Based on {fmtQty(s.used_30d)} {unit} used in the last 30 days.{" "}
                    <Link href="/invoices" className="underline">
                      wrong size?
                    </Link>
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Unit cost master list</h2>
        {priced.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-5 text-sm text-neutral-600">
            No unit costs yet. Every posted invoice line sets the latest cost per {`oz / lb / each`} for its ingredient.{" "}
            <Link href="/invoices" className="underline">
              Post an invoice
            </Link>{" "}
            to start the list.
          </div>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
            {priced.map((m) => {
              const change = fmtPctChange(changeById.get(m.inventory_item_id ?? "") ?? null);
              const up = change.startsWith("+");
              const quotes = quotesByItem.get(m.inventory_item_id ?? "") ?? [];
              return (
                <li key={m.inventory_item_id ?? m.name ?? ""} className="flex min-h-14 flex-col gap-1 px-4 py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="truncate font-medium">{m.name}</div>
                      <div className="text-xs text-neutral-500">
                        {m.category ?? "uncategorized"}
                        {m.latest_price_date ? ` · invoiced ${fmtDate(m.latest_price_date)}` : ""}
                        {m.latest_cost_per_pack != null && m.pack_to_base_factor != null ? ` · ${fmtMoney(m.latest_cost_per_pack)}/pack` : ""}
                      </div>
                    </div>
                    <div className="shrink-0 text-right tabular-nums">
                      <div className="font-medium">
                        {fmtUnitCost(m.latest_cost_per_base_unit)}
                        <span className="text-neutral-500">/{m.base_unit}</span>
                      </div>
                      {change ? <div className={`text-xs ${up ? "text-red-700" : "text-emerald-700"}`}>{change} 30d</div> : null}
                    </div>
                  </div>
                  {quotes.length > 0 ? (
                    <ul className="flex flex-col gap-0.5 text-xs text-sky-800">
                      {quotes.map((q) => (
                        <li key={`${q.inventory_item_id}-${q.vendor_id}`} className="flex items-center justify-between gap-3 tabular-nums">
                          <span>
                            Quoted · {q.vendor_name}
                            {q.quoted_pack ? ` · ${q.quoted_pack}` : ""}
                            {q.quote_valid_through ? ` · through ${fmtDate(q.quote_valid_through)}` : " · no end date"}
                          </span>
                          <span className="font-medium">
                            {fmtUnitCost(q.best_quoted_cost)}
                            <span className="text-sky-600">/{m.base_unit}</span>
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
        {unpriced.length > 0 ? (
          <p className="text-xs text-neutral-500">
            {unpriced.length} item{unpriced.length === 1 ? "" : "s"} without a posted price yet: {unpriced.map((m) => m.name).join(", ")}.
          </p>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Ask for pricing</h2>
        <p className="text-sm text-neutral-600">
          One email per vendor listing what you buy from them, asking for current price per pack, specials and validity dates. Replies file themselves as
          quotes and show up above as the price you would pay next. Requests also go out automatically every Monday and when an ingredient&apos;s price
          jumps 10% in 30 days.
        </p>
        {askable.length === 0 ? (
          <p className="rounded-2xl border border-dashed border-neutral-300 bg-white p-5 text-sm text-neutral-600">No vendor has a mapped item yet — post an invoice first.</p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
            {askable.map((v) => {
              const last = lastRequest.get(v.id);
              const n = mappingCount.get(v.id) ?? 0;
              return (
                <li key={v.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div className="min-w-0">
                    <div className="font-medium">{v.name}</div>
                    <div className="text-xs text-neutral-500">
                      {n} item{n === 1 ? "" : "s"}
                      {v.contact_email ? ` · ${v.contact_email}` : ""}
                      {last ? ` · asked ${fmtDate(last.sent_at)} (${last.status === "replied" ? "replied" : last.status === "sent" ? "waiting" : last.status})` : " · never asked"}
                    </div>
                  </div>
                  {v.contact_email ? (
                    <form action={askForPricing}>
                      <input type="hidden" name="vendor_id" value={v.id} />
                      <button className={btn2Cls}>Ask for pricing</button>
                    </form>
                  ) : (
                    <div className="flex flex-col items-end gap-1">
                      <button className={btn2Cls} disabled title="Add a contact email first">
                        Ask for pricing
                      </button>
                      <Link href="/settings#vendors" className="text-xs underline">
                        add an email in Settings
                      </Link>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}

function AssumedPack({ label, option, unit }: { label: string | null; option: Comparison | undefined; unit: string }) {
  return (
    <div className="rounded-lg bg-neutral-50 p-2">
      <dt className="font-medium text-neutral-700">{label}</dt>
      <dd>
        {option ? (
          <>
            {option.pack_description ?? "pack"} = <span className="font-medium">{fmtQty(option.base_units_per_pack)} {unit}</span>{" "}
            <span className="text-neutral-400">(assumed)</span>
            {option.brand ? ` · ${option.brand}` : ""}
            {option.price_per_pack != null ? ` · ${fmtMoney(option.price_per_pack)}/pack` : ""}
            {option.basis === "quote" && option.best_quoted_cost != null ? (
              <>
                {" "}
                · <span className="text-sky-800">quoted {fmtUnitCost(option.best_quoted_cost)}/{unit}</span>
                {option.quote_valid_through ? <span className="text-sky-800"> through {fmtDate(option.quote_valid_through)}</span> : null}
              </>
            ) : null}
          </>
        ) : (
          <span className="text-neutral-400">pack size not on file</span>
        )}
      </dd>
    </div>
  );
}
