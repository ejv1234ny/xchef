import Link from "next/link";
import { getAppContext } from "@/lib/db/context";
import { createServerSupabase } from "@/lib/db/server";
import { hourIn, todayIn } from "@/lib/core/dates";
import { daysBetween, reconciliationDate, restatementLabel } from "@/lib/core/position";
import type { Tables } from "@/lib/db/types";
import { expectationText, fmtDate, fmtDays, fmtMoney, fmtPacks, fmtQty, fmtSince, packWord, Chip, Flash } from "@/components/ui-format";
import { confirmEstimate, saveCount } from "./verify/actions";

export const metadata = { title: "Verify" };

type Position = "open" | "close";

const inputCls = "h-14 w-full rounded-xl border border-neutral-300 bg-white px-4 text-lg tabular-nums";

export default async function VerifyPage({ searchParams }: PageProps<"/">) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();

  const position: Position =
    sp.position === "open" || sp.position === "close" ? sp.position : hourIn(ctx.location.timezone) < 14 ? "open" : "close";
  const savedId = typeof sp.saved === "string" ? sp.saved : null;
  const yesterday = reconciliationDate(ctx.location.timezone);
  const today = todayIn(ctx.location.timezone);

  const [{ data: queue, error: qerr }, saved, { data: daily }, { data: stockouts }] = await Promise.all([
    supabase
      .from("verification_queue")
      .select("*")
      .eq("location_id", ctx.location.id)
      .order("priority_score", { ascending: false })
      .limit(10),
    savedId ? loadSaved(ctx.location.id, savedId) : Promise.resolve(null),
    // the reconciled close of the last business day for every item, one query (the queue is at most 10 of them)
    supabase
      .from("daily_position")
      .select("inventory_item_id, business_date, expected_close_qty, last_verified_at, restated_at, restatement_reason")
      .eq("location_id", ctx.location.id)
      .eq("business_date", yesterday),
    // ingredients whose top menu item is 86'd right now (Toast Stock, polled every 5 minutes)
    supabase.from("ingredient_stockouts").select("inventory_item_id, menu_item_name, since").eq("location_id", ctx.location.id),
  ]);

  const rows = queue ?? [];
  const dailyById = new Map((daily ?? []).map((d) => [d.inventory_item_id, d]));
  const stockoutById = new Map((stockouts ?? []).map((s) => [s.inventory_item_id ?? "", s]));

  return (
    <div className="flex flex-col gap-4 py-4">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Verify</h1>
        <span className="text-sm text-neutral-500">top {rows.length} by $ at risk</span>
      </div>

      <PositionToggle position={position} />
      <Flash ok={sp.ok} error={qerr ? qerr.message : sp.error} />

      {saved ? <SavedCard saved={saved} /> : null}

      {rows.length === 0 ? (
        <div className="rounded-2xl border border-dashed border-neutral-300 bg-white p-6 text-center">
          <p className="text-base font-medium">Nothing to verify yet</p>
          <p className="mt-1 text-sm text-neutral-600">Sync sales and post an invoice, then items show up here ordered by dollars at risk.</p>
          <div className="mt-4 flex justify-center gap-3">
            <Link href="/settings" className="flex h-12 items-center rounded-xl border border-neutral-300 bg-white px-5 font-medium">
              Sync sales
            </Link>
            <Link href="/invoices" className="flex h-12 items-center rounded-xl bg-neutral-900 px-5 font-medium text-white">
              Post an invoice
            </Link>
          </div>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => (
            <li key={r.inventory_item_id ?? r.inventory_item_name ?? ""}>
              <QueueRow row={r} position={position} daily={dailyById.get(r.inventory_item_id ?? "") ?? null} today={today} stockout={stockoutById.get(r.inventory_item_id ?? "") ?? null} timezone={ctx.location.timezone} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PositionToggle({ position }: { position: Position }) {
  const base = "flex h-12 flex-1 items-center justify-center rounded-lg text-sm font-medium";
  const on = "bg-neutral-900 text-white";
  const off = "text-neutral-600";
  return (
    <div className="flex rounded-xl border border-neutral-200 bg-white p-1" role="group" aria-label="Count position">
      <Link href="/?position=open" aria-current={position === "open" ? "true" : undefined} className={`${base} ${position === "open" ? on : off}`}>
        Before service · open
      </Link>
      <Link href="/?position=close" aria-current={position === "close" ? "true" : undefined} className={`${base} ${position === "close" ? on : off}`}>
        After service · close
      </Link>
    </div>
  );
}

type QueueRowT = Tables<"verification_queue">;
type DailyT = Pick<Tables<"daily_position">, "inventory_item_id" | "business_date" | "expected_close_qty" | "last_verified_at" | "restated_at" | "restatement_reason">;
type StockoutT = Pick<Tables<"ingredient_stockouts">, "inventory_item_id" | "menu_item_name" | "since">;

function QueueRow({ row, position, daily, today, stockout, timezone }: { row: QueueRowT; position: Position; daily: DailyT | null; today: string; stockout: StockoutT | null; timezone: string }) {
  const never = row.has_baseline === false;
  const word = packWord(row.inventory_item_name, row.pack_to_base_factor, 2);
  const countsInPacks = word !== null;
  const days = fmtDays(row.days_of_supply);
  return (
    <form
      className={`flex flex-col gap-3 rounded-2xl border p-4 ${never ? "border-amber-300 bg-amber-50" : "border-neutral-200 bg-white"}`}
    >
      <input type="hidden" name="inventory_item_id" value={row.inventory_item_id ?? ""} />
      <input type="hidden" name="position" value={position} />

      <div>
        <div className="flex items-start justify-between gap-2">
          <h2 className="text-lg font-semibold leading-tight">{row.inventory_item_name}</h2>
          {row.value_per_pack != null && row.value_per_pack > 0 ? (
            <span className="shrink-0 text-sm text-neutral-500">{fmtMoney(row.value_per_pack)} per pack</span>
          ) : null}
        </div>
        <p className="mt-1 text-base">
          {never ? (
            <>
              Never verified — <span className="font-medium">set a baseline</span>. Net change so far: {expectationText(row)}
            </>
          ) : (
            <>
              You should have <span className="font-medium">{expectationText(row)}</span>
            </>
          )}
        </p>
        <p className="mt-0.5 text-sm text-neutral-600">
          {row.reason}
          {days ? ` · ${days}` : ""}
          {row.on_hand_packs != null && countsInPacks ? ` · ${fmtQty(row.on_hand_qty)} ${row.base_unit}` : ""}
        </p>
        {daily ? <DailyLine row={row} daily={daily} today={today} /> : null}
        {stockout ? (
          <p className="mt-1 text-xs">
            <Chip className="bg-red-100 text-red-900">86&apos;d since {fmtSince(stockout.since, timezone)}</Chip>
            <span className="ml-1 text-neutral-500">{stockout.menu_item_name} is out of stock in Toast — low usage today is explained</span>
          </p>
        ) : null}
      </div>

      <div className="flex gap-2">
        <button
          formAction={confirmEstimate}
          className="flex h-14 w-24 shrink-0 items-center justify-center rounded-xl bg-emerald-600 text-2xl font-bold text-white"
          aria-label={`Confirm ${row.inventory_item_name}: looks right`}
        >
          ✓
        </button>
        <input
          name="packs"
          type="text"
          inputMode="decimal"
          autoComplete="off"
          placeholder={countsInPacks ? word ?? "packs" : row.base_unit ?? "units"}
          aria-label={countsInPacks ? `Count in ${word}` : `Count in ${row.base_unit ?? "units"}`}
          className={inputCls}
        />
        <button formAction={saveCount} className="h-14 shrink-0 rounded-xl border border-neutral-900 bg-white px-4 text-base font-medium">
          Save count
        </button>
      </div>
      {!countsInPacks ? <p className="text-xs text-neutral-500">No pack size on this item — count in {row.base_unit}.</p> : null}
    </form>
  );
}

/** "as of close Sep 4: expected 11.4 bottles · last checked 3 days ago · restated (late invoice) · history" from daily_position. */
function DailyLine({ row, daily, today }: { row: QueueRowT; daily: DailyT; today: string }) {
  const factor = row.pack_to_base_factor != null && row.pack_to_base_factor > 0 ? row.pack_to_base_factor : null;
  // display-only: packs = expected close ÷ pack size (the stored number is base units)
  const packs = factor ? daily.expected_close_qty / factor : null;
  const word = packWord(row.inventory_item_name, row.pack_to_base_factor, packs ?? 2);
  const expected = packs != null && word ? `${fmtPacks(packs)} ${word}` : `${fmtQty(daily.expected_close_qty)} ${row.base_unit ?? ""}`.trim();
  const checkedDays = daily.last_verified_at ? Math.max(0, daysBetween(daily.last_verified_at.slice(0, 10), today)) : null;
  const checked = checkedDays == null ? "never checked" : checkedDays === 0 ? "checked today" : `last checked ${checkedDays} day${checkedDays === 1 ? "" : "s"} ago`;
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-1 gap-y-0.5 text-xs text-neutral-500">
      <span>
        as of close {fmtDate(daily.business_date)}: expected <span className="font-medium text-neutral-700">{expected}</span> · {checked}
      </span>
      {daily.restated_at ? <Chip className="bg-amber-100 text-amber-900">restated ({restatementLabel(daily.restatement_reason)})</Chip> : null}
      <Link href={`/position?item=${row.inventory_item_id ?? ""}`} className="underline">
        history
      </Link>
    </p>
  );
}

async function loadSaved(locationId: string, inventoryItemId: string) {
  const supabase = await createServerSupabase();
  const [{ data: est }, { data: variance }] = await Promise.all([
    supabase
      .from("on_hand_estimate")
      .select("*")
      .eq("location_id", locationId)
      .eq("inventory_item_id", inventoryItemId)
      .maybeSingle(),
    supabase
      .from("count_variance")
      .select("*")
      .eq("location_id", locationId)
      .eq("inventory_item_id", inventoryItemId)
      .order("count_date", { ascending: false })
      .order("position", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (!est) return null;
  return { est, variance: variance?.verification === "counted" ? variance : null };
}

function SavedCard({ saved }: { saved: NonNullable<Awaited<ReturnType<typeof loadSaved>>> }) {
  const { est, variance } = saved;
  const word = packWord(est.inventory_item_name, est.pack_to_base_factor, est.on_hand_packs ?? 2);
  const v = variance?.variance_qty ?? null;
  // variance_qty > 0 = unexplained depletion (short); < 0 = more on the shelf than expected (over)
  const direction = v == null ? null : v > 0 ? "short" : v < 0 ? "over" : "on target";
  return (
    <div className="rounded-2xl border border-emerald-300 bg-emerald-50 p-4">
      <p className="text-sm text-emerald-800">Saved · {est.inventory_item_name}</p>
      <p className="mt-1 text-lg font-semibold">
        Now {est.on_hand_packs != null && word ? `~${fmtPacks(est.on_hand_packs)} ${word} / ` : "~"}
        {fmtQty(est.on_hand_qty)} {est.base_unit}
      </p>
      {variance ? (
        <p className="mt-1 text-base">
          Variance: <span className="font-medium">{fmtMoney(Math.abs(variance.variance_value ?? 0))}</span>
          {variance.variance_packs != null ? ` · ${fmtPacks(Math.abs(variance.variance_packs))} packs` : ` · ${fmtQty(Math.abs(v ?? 0))} ${est.base_unit}`}
          {direction ? ` ${direction}` : ""}
          <span className="block text-xs text-neutral-600">vs. expected since {variance.prev_count_date} ({variance.prev_position})</span>
        </p>
      ) : (
        <p className="mt-1 text-sm text-neutral-700">Baseline reset. Purchases and sales count from here.</p>
      )}
    </div>
  );
}
