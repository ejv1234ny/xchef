import Link from "next/link";
import { getAppContext } from "@/lib/db/context";
import { createServerSupabase } from "@/lib/db/server";
import type { Tables } from "@/lib/db/types";
import { Chip, fmtDate, fmtMoney, fmtQty, Flash } from "@/components/ui-format";
import { PositionItemSelect } from "@/components/position-item-select";
import { restatementLabel } from "@/lib/core/position";

export const metadata = { title: "Position" };

const DAYS = 14;

export default async function PositionPage({ searchParams }: PageProps<"/position">) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();

  const { data: items, error: ierr } = await supabase
    .from("inventory_items")
    .select("id, name, base_unit, pack_to_base_factor")
    .eq("tenant_id", ctx.tenant.id)
    .is("archived_at", null)
    .order("name");
  const list = items ?? [];
  const requested = typeof sp.item === "string" ? sp.item : null;
  const item = list.find((i) => i.id === requested) ?? null;

  const { data: rows, error: rerr } = item
    ? await supabase
        .from("daily_position")
        .select("*")
        .eq("location_id", ctx.location.id)
        .eq("inventory_item_id", item.id)
        .order("business_date", { ascending: false })
        .limit(DAYS)
    : { data: null, error: null };

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Position</h1>
        <span className="text-sm text-neutral-500">last {DAYS} days</span>
      </div>
      <Flash error={ierr?.message ?? rerr?.message} />

      <PositionItemSelect items={list.map((i) => ({ id: i.id, name: i.name }))} value={item?.id ?? null} />

      {!item ? (
        <p className="rounded-2xl border border-dashed border-neutral-300 bg-white p-6 text-center text-sm text-neutral-600">
          Pick an ingredient to see its daily opening, deliveries, usage and variance.
        </p>
      ) : !rows || rows.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-neutral-300 bg-white p-6 text-center text-sm text-neutral-600">
          No daily rows yet for {item.name}. The nightly reconciliation writes one per business day.
        </p>
      ) : (
        <PositionTable item={item} rows={rows} />
      )}

      <p className="text-xs text-neutral-500">
        Quantities in {item?.base_unit ?? "base units"}. Variance = expected close − counted; positive means short. Restated days were
        rewritten after the fact (a late invoice, rebuilt sales, a backdated count or a recipe change) — the change is recorded, not
        erased. <Link href="/" className="underline">Back to verify</Link>
      </p>
    </div>
  );
}

type ItemT = Pick<Tables<"inventory_items">, "id" | "name" | "base_unit" | "pack_to_base_factor">;

function PositionTable({ item, rows }: { item: ItemT; rows: Tables<"daily_position">[] }) {
  const th = "px-2 py-2 text-right text-xs font-medium text-neutral-500 whitespace-nowrap";
  const td = "px-2 py-2 text-right tabular-nums whitespace-nowrap";
  return (
    <div className="overflow-x-auto rounded-2xl border border-neutral-200 bg-white">
      <table className="w-full text-sm">
        <caption className="sr-only">
          Daily position for {item.name}, newest first
        </caption>
        <thead className="border-b border-neutral-200">
          <tr>
            <th className={`${th} sticky left-0 bg-white text-left`}>date</th>
            <th className={th}>opening</th>
            <th className={th}>received</th>
            <th className={th}>used</th>
            <th className={th}>expected close</th>
            <th className={th}>counted</th>
            <th className={th}>variance $</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-neutral-100">
          {rows.map((r) => {
            const restated = r.restated_at != null;
            const v = r.variance_value;
            return (
              <tr key={r.business_date} className={restated ? "bg-amber-50/60" : ""}>
                <td className={`sticky left-0 px-2 py-2 text-left whitespace-nowrap ${restated ? "bg-amber-50" : "bg-white"}`}>
                  <span className="font-medium">{fmtDate(r.business_date)}</span>
                  {restated ? (
                    <Chip className="ml-1 bg-amber-100 text-amber-900">restated{r.restatement_reason ? ` (${restatementLabel(r.restatement_reason)})` : ""}</Chip>
                  ) : null}
                </td>
                <td className={td}>{fmtQty(r.opening_qty)}</td>
                <td className={td}>{r.received_qty ? fmtQty(r.received_qty) : "—"}</td>
                <td className={td}>{r.theoretical_used_qty ? fmtQty(r.theoretical_used_qty) : "—"}</td>
                <td className={`${td} font-medium`}>{fmtQty(r.expected_close_qty)}</td>
                <td className={td}>
                  {r.counted_qty != null ? (
                    <>
                      {r.verification === "confirmed_estimate" ? <span title="confirmed estimate (✓ tap)">✓ </span> : null}
                      {fmtQty(r.counted_qty)}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className={`${td} ${v != null && v > 0 ? "text-red-700" : v != null && v < 0 ? "text-emerald-700" : ""}`}>
                  {v == null ? "—" : `${v > 0 ? "−" : v < 0 ? "+" : ""}${fmtMoney(Math.abs(v))}`}
                  {r.variance_qty != null ? <span className="block text-xs text-neutral-500">{fmtQty(Math.abs(r.variance_qty))} {item.base_unit} {r.variance_qty > 0 ? "short" : r.variance_qty < 0 ? "over" : ""}</span> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
