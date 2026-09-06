import Decimal from "decimal.js";
import { createServiceSupabase, type ServiceClient } from "@/lib/db/service";
import type { Tables, TablesInsert } from "@/lib/db/types";
import { addDays, businessDayWindow } from "@/lib/core/dates";
import { stockoutMinutes } from "@/lib/core/stock";
import {
  baselineOpening,
  computeDailyPosition,
  dateRange,
  nextOpening,
  reconciliationDate,
  rowChanged,
  sinceDateOf,
  type ComparableRow,
  type DailyPositionRow,
  type PositionCount,
  type RestatementReason,
} from "@/lib/core/position";

/**
 * Daily reconciliation job (KICKOFF-2 Part 1). Materializes daily_position —
 * one row per (location, ingredient, business date): opening, received,
 * theoretical usage, expected close, count, variance — in business-date order
 * so each day's opening is the previous day's close. Re-running restates
 * rows whose values changed (restated_at + restatement_reason) instead of
 * silently rewriting them. Every run is recorded in sync_runs
 * (kind 'daily-position'). Idempotent; one bad item is logged and skipped.
 */

export type Logger = (msg: string, meta?: Record<string, unknown>) => void;

export const DAILY_POSITION_KIND = "daily-position";
const UPSERT_BATCH = 200;
const PAGE = 1000;
const IN_CHUNK = 100;
const RECIPE_RESTATE_DAYS = 30;

export type DailyPositionRunSummary = {
  location_id: string;
  location_name: string;
  kind: typeof DAILY_POSITION_KIND;
  /** first / last business date computed */
  window_start: string | null;
  window_end: string | null;
  dates: string[];
  items: number;
  item_errors: number;
  rows_written: number;
  rows_restated: number;
  duration_ms: number;
  error: string | null;
};

export type DailyPositionOptions = {
  locationId?: string;
  /** explicit business dates; the contiguous range min..max is computed. Default: yesterday + every earlier date needing restatement */
  dates?: string[];
  /** fallback reason when a row changes for no detectable cause (default 'manual') */
  reason?: RestatementReason;
  now?: Date;
  log?: Logger;
  supabase?: ServiceClient;
};

type ItemRow = Pick<Tables<"inventory_items">, "id" | "name" | "cost_per_base_unit">;
type CountRow = Tables<"stock_counts">;
type ExistingRow = Tables<"daily_position">;

const key = (item: string, date: string) => `${item}|${date}`;
const numStr = (n: number | string | null | undefined): string => (n == null ? "0" : String(n));
const num4 = (s: string): number => Number(new Decimal(s).toFixed(4));
const num4n = (s: string | null): number | null => (s == null ? null : num4(s));

function chunk<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) break;
  }
  return out;
}

function addTo(map: Map<string, Decimal>, k: string, v: number | string | null | undefined) {
  map.set(k, (map.get(k) ?? new Decimal(0)).plus(numStr(v)));
}

function toCount(c: CountRow): PositionCount {
  return {
    id: c.id,
    quantity_base_unit: numStr(c.quantity_base_unit),
    position: c.position,
    verification: c.verification,
    counted_at: c.counted_at,
  };
}

function comparable(r: ExistingRow): ComparableRow {
  return {
    opening_qty: numStr(r.opening_qty),
    received_qty: numStr(r.received_qty),
    theoretical_used_qty: numStr(r.theoretical_used_qty),
    expected_close_qty: numStr(r.expected_close_qty),
    counted_qty: r.counted_qty == null ? null : String(r.counted_qty),
    variance_qty: r.variance_qty == null ? null : String(r.variance_qty),
    variance_value: r.variance_value == null ? null : String(r.variance_value),
    cost_per_base_unit: r.cost_per_base_unit == null ? null : String(r.cost_per_base_unit),
    verification: r.verification as ComparableRow["verification"],
    last_verified_at: r.last_verified_at,
    included_invoice_ids: r.included_invoice_ids ?? [],
    included_count_id: r.included_count_id,
  };
}

/** Restatement triggers since the last successful run, keyed by item|date (or date alone). */
type Triggers = {
  lateInvoice: Set<string>; // item|date and date
  salesRebuild: Set<string>; // date
  countBackdated: Set<string>; // item|date
  recipeChange: Set<string>; // item
  recipeDates: Set<string>; // date
  dates: Set<string>;
};

const emptyTriggers = (): Triggers => ({
  lateInvoice: new Set(),
  salesRebuild: new Set(),
  countBackdated: new Set(),
  recipeChange: new Set(),
  recipeDates: new Set(),
  dates: new Set(),
});

/** coalesce(received_date, invoice_date) — the view's received_date. */
const effectiveDate = (d: { received_date: string | null; invoice_date: string | null }) => d.received_date ?? d.invoice_date;

async function collectTriggers(
  svc: ServiceClient,
  locationId: string,
  itemIds: Set<string>,
  since: string,
  lastComputed: string | null,
  target: string,
): Promise<Triggers> {
  const t = emptyTriggers();

  // Late invoices: documents posted since the last run, by the date their goods count as received.
  const { data: docs, error: derr } = await svc
    .from("invoice_documents")
    .select("id, received_date, invoice_date, document_kind")
    .eq("location_id", locationId)
    .eq("status", "posted")
    .gt("posted_at", since);
  if (derr) throw new Error(`read invoice_documents: ${derr.message}`);
  const dateByDoc = new Map<string, string>();
  for (const d of docs ?? []) {
    if (d.document_kind === "quote") continue;
    const date = effectiveDate(d);
    if (!date || date > target) continue;
    dateByDoc.set(d.id, date);
    t.lateInvoice.add(date);
    t.dates.add(date);
  }
  for (const ids of chunk([...dateByDoc.keys()], IN_CHUNK)) {
    const lines = await fetchAll<{ invoice_id: string; inventory_item_id: string | null }>((from, to) =>
      svc.from("invoice_lines").select("invoice_id, inventory_item_id").in("invoice_id", ids).not("inventory_item_id", "is", null).order("id").range(from, to),
    );
    for (const l of lines) {
      const date = dateByDoc.get(l.invoice_id);
      if (date && l.inventory_item_id) t.lateInvoice.add(key(l.inventory_item_id, date));
    }
  }

  // Sales rebuilt since the last run (the sync re-upserts a 36h overlap, so this always includes the last couple of days).
  const sales = await fetchAll<{ business_date: string }>((from, to) =>
    svc.from("sales_facts").select("business_date").eq("location_id", locationId).gt("synced_at", since).order("business_date").order("id").range(from, to),
  );
  for (const s of sales) {
    if (s.business_date > target) continue;
    t.salesRebuild.add(s.business_date);
    t.dates.add(s.business_date);
  }

  // Counts entered since the last run for a business date the last run had already computed.
  if (lastComputed) {
    const { data: counts, error: cerr } = await svc
      .from("stock_counts")
      .select("inventory_item_id, count_date")
      .eq("location_id", locationId)
      .gt("created_at", since)
      .lte("count_date", lastComputed);
    if (cerr) throw new Error(`read stock_counts: ${cerr.message}`);
    for (const c of counts ?? []) {
      t.countBackdated.add(key(c.inventory_item_id, c.count_date));
      t.dates.add(c.count_date);
    }
  }

  // Recipe components confirmed since the last run → restate the trailing 30 days for those ingredients.
  const { data: recipes, error: rerr } = await svc.from("recipe_components").select("inventory_item_id").gt("confirmed_at", since);
  if (rerr) throw new Error(`read recipe_components: ${rerr.message}`);
  const touched = (recipes ?? []).filter((r) => itemIds.has(r.inventory_item_id));
  if (touched.length) {
    for (const r of touched) t.recipeChange.add(r.inventory_item_id);
    for (const d of dateRange(addDays(target, -RECIPE_RESTATE_DAYS), target)) {
      t.recipeDates.add(d);
      t.dates.add(d);
    }
  }
  return t;
}

function directReason(t: Triggers, item: string, date: string): RestatementReason | null {
  const k = key(item, date);
  if (t.lateInvoice.has(k)) return "late_invoice";
  if (t.countBackdated.has(k)) return "count_backdated";
  if (t.salesRebuild.has(date)) return "sales_rebuild";
  if (t.recipeChange.has(item) && t.recipeDates.has(date)) return "recipe_change";
  if (t.lateInvoice.has(date)) return "late_invoice";
  return null;
}

export async function runDailyPosition(opts: DailyPositionOptions = {}): Promise<{ runs: DailyPositionRunSummary[] }> {
  const svc = opts.supabase ?? createServiceSupabase();
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();

  let q = svc.from("locations").select("*").order("created_at");
  if (opts.locationId) q = q.eq("id", opts.locationId);
  const { data: locations, error } = await q;
  if (error) throw new Error(`read locations: ${error.message}`);

  const runs: DailyPositionRunSummary[] = [];
  for (const location of locations ?? []) {
    const { data: items, error: ierr } = await svc.from("inventory_items").select("id, name, cost_per_base_unit").eq("tenant_id", location.tenant_id).is("archived_at", null).order("name");
    if (ierr) throw new Error(`read inventory_items: ${ierr.message}`);
    if (!items || items.length === 0) {
      const { data: creds } = await svc.from("toast_credentials").select("location_id").eq("location_id", location.id).maybeSingle();
      if (!creds) {
        log("daily-position: no inventory and no Toast credential, skipping", { location: location.name });
        continue;
      }
    }
    const run = await runForLocation(svc, location, items ?? [], opts, now, log);
    runs.push(run);
    const { error: serr } = await svc.from("sync_runs").insert({
      location_id: location.id,
      kind: DAILY_POSITION_KIND,
      window_start: run.window_start ? `${run.window_start}T00:00:00Z` : null,
      window_end: run.window_end ? `${run.window_end}T00:00:00Z` : null,
      orders_upserted: run.rows_written,
      orders_fetched: run.rows_restated,
      orders_quarantined: run.item_errors,
      dates_rebuilt: run.dates,
      duration_ms: run.duration_ms,
      error: run.error,
    });
    if (serr) log("daily-position: could not record sync_run", { error: serr.message });
  }
  return { runs };
}

async function runForLocation(
  svc: ServiceClient,
  location: Tables<"locations">,
  items: ItemRow[],
  opts: DailyPositionOptions,
  now: Date,
  log: Logger,
): Promise<DailyPositionRunSummary> {
  const t0 = Date.now();
  const summary: DailyPositionRunSummary = {
    location_id: location.id,
    location_name: location.name,
    kind: DAILY_POSITION_KIND,
    window_start: null,
    window_end: null,
    dates: [],
    items: items.length,
    item_errors: 0,
    rows_written: 0,
    rows_restated: 0,
    duration_ms: 0,
    error: null,
  };
  try {
    const itemIds = new Set(items.map((i) => i.id));
    const target = reconciliationDate(location.timezone, now);

    // Last successful run: its created_at is "since"; its window_end is the last business date it computed.
    const { data: lastRuns, error: lerr } = await svc
      .from("sync_runs")
      .select("created_at, window_end")
      .eq("location_id", location.id)
      .eq("kind", DAILY_POSITION_KIND)
      .is("error", null)
      .order("created_at", { ascending: false })
      .limit(1);
    if (lerr) throw new Error(`read sync_runs: ${lerr.message}`);
    const lastRun = lastRuns?.[0] ?? null;
    const lastComputed = lastRun?.window_end ? lastRun.window_end.slice(0, 10) : null;

    let triggers = emptyTriggers();
    let start: string;
    let end: string;
    if (opts.dates && opts.dates.length) {
      const sorted = [...new Set(opts.dates)].sort();
      start = sorted[0];
      end = sorted[sorted.length - 1];
    } else {
      end = target;
      if (lastRun) triggers = await collectTriggers(svc, location.id, itemIds, lastRun.created_at, lastComputed, target);
      const needed = [...triggers.dates].filter((d) => d <= target).sort();
      start = needed[0] && needed[0] < target ? needed[0] : target;
      // Never leave a hole: if the last run computed through D, continue from D + 1.
      if (lastComputed && addDays(lastComputed, 1) < start) start = addDays(lastComputed, 1);
    }
    if (start > end) {
      summary.duration_ms = Date.now() - t0;
      return summary;
    }
    const dates = dateRange(start, end);
    summary.dates = dates;
    summary.window_start = start;
    summary.window_end = end;
    log("daily-position: computing", { location: location.name, start, end, days: dates.length, items: items.length, triggers: triggers.dates.size });

    const priorDate = addDays(start, -1);

    // ---- inputs for the whole range, one query each -------------------------------------------
    const existing = await fetchAll<ExistingRow>((from, to) =>
      svc.from("daily_position").select("*").eq("location_id", location.id).gte("business_date", priorDate).lte("business_date", end).order("business_date").order("inventory_item_id").range(from, to),
    );
    const existingByKey = new Map(existing.map((r) => [key(r.inventory_item_id, r.business_date), r]));

    const purchases = await fetchAll<Tables<"purchases_by_item">>((from, to) =>
      svc.from("purchases_by_item").select("*").eq("location_id", location.id).gte("received_date", start).lte("received_date", end).order("received_date").order("inventory_item_id").range(from, to),
    );
    const receivedByKey = new Map<string, Decimal>();
    for (const p of purchases) if (p.inventory_item_id && p.received_date) addTo(receivedByKey, key(p.inventory_item_id, p.received_date), p.quantity_base_unit);

    const usage = await fetchAll<Tables<"usage_by_period">>((from, to) =>
      svc.from("usage_by_period").select("*").eq("location_id", location.id).gte("business_date", start).lte("business_date", end).order("business_date").order("inventory_item_id").range(from, to),
    );
    const usedByKey = new Map<string, Decimal>();
    for (const u of usage) if (u.inventory_item_id && u.business_date) addTo(usedByKey, key(u.inventory_item_id, u.business_date), u.quantity_used);

    const counts = await fetchAll<CountRow>((from, to) =>
      svc.from("stock_counts").select("*").eq("location_id", location.id).gte("count_date", start).lte("count_date", end).order("count_date").order("id").range(from, to),
    );
    const countsByKey = new Map<string, { open?: CountRow; close?: CountRow }>();
    for (const c of counts) {
      const k = key(c.inventory_item_id, c.count_date);
      const slot = countsByKey.get(k) ?? {};
      slot[c.position] = c;
      countsByKey.set(k, slot);
    }

    // Posted (non-quote) documents whose goods date falls in the range → invoice ids per item/day.
    const { data: docs, error: derr } = await svc
      .from("invoice_documents")
      .select("id, received_date, invoice_date, document_kind")
      .eq("location_id", location.id)
      .eq("status", "posted");
    if (derr) throw new Error(`read invoice_documents: ${derr.message}`);
    const dateByDoc = new Map<string, string>();
    for (const d of docs ?? []) {
      if (d.document_kind === "quote") continue;
      const date = effectiveDate(d);
      if (date && date >= start && date <= end) dateByDoc.set(d.id, date);
    }
    const invoiceIdsByKey = new Map<string, Set<string>>();
    for (const ids of chunk([...dateByDoc.keys()], IN_CHUNK)) {
      const lines = await fetchAll<{ invoice_id: string; inventory_item_id: string | null; status: string }>((from, to) =>
        svc.from("invoice_lines").select("invoice_id, inventory_item_id, status").in("invoice_id", ids).in("status", ["auto_mapped", "confirmed"]).not("inventory_item_id", "is", null).order("id").range(from, to),
      );
      for (const l of lines) {
        const date = dateByDoc.get(l.invoice_id);
        if (!date || !l.inventory_item_id) continue;
        const k = key(l.inventory_item_id, date);
        const set = invoiceIdsByKey.get(k) ?? new Set<string>();
        set.add(l.invoice_id);
        invoiceIdsByKey.set(k, set);
      }
    }

    // ---- 86-list: minutes each ingredient's menu items were OUT_OF_STOCK per business day ------------------
    const guidsByItem = new Map<string, Set<string>>();
    {
      const links = await fetchAll<{ inventory_item_id: string; menu_items: { toast_menu_item_guid: string | null } | null }>((from, to) =>
        svc.from("recipe_components").select("inventory_item_id, menu_items!inner(toast_menu_item_guid)").eq("menu_items.tenant_id", location.tenant_id).order("id").range(from, to),
      );
      for (const l of links) {
        const guid = l.menu_items?.toast_menu_item_guid;
        if (!guid) continue;
        const set = guidsByItem.get(l.inventory_item_id) ?? new Set<string>();
        set.add(guid);
        guidsByItem.set(l.inventory_item_id, set);
      }
    }
    const windowEnd = businessDayWindow(end, location.timezone).end;
    const stockEvents = await fetchAll<{ toast_menu_item_guid: string; status: string; observed_at: string }>((from, to) =>
      svc.from("menu_item_stock_events").select("toast_menu_item_guid, status, observed_at").eq("location_id", location.id).lt("observed_at", windowEnd.toISOString()).order("observed_at").order("id").range(from, to),
    );
    const eventsByGuid = new Map<string, Array<{ observed_at: string; status: string }>>();
    for (const e of stockEvents) {
      const list = eventsByGuid.get(e.toast_menu_item_guid) ?? [];
      list.push({ observed_at: e.observed_at, status: e.status });
      eventsByGuid.set(e.toast_menu_item_guid, list);
    }
    const windows = new Map(dates.map((d) => [d, businessDayWindow(d, location.timezone)]));
    const stockoutFor = (itemId: string, date: string): number => {
      const guids = guidsByItem.get(itemId);
      if (!guids || guids.size === 0 || eventsByGuid.size === 0) return 0;
      const w = windows.get(date)!;
      let max = 0;
      for (const g of guids) {
        const ev = eventsByGuid.get(g);
        if (!ev) continue;
        max = Math.max(max, stockoutMinutes(ev, w.start, w.end));
      }
      return max;
    };

    // ---- openings for the first day: prior row, else the on_hand_estimate window before `start` ------
    const openingByItem = new Map<string, { qty: string; lastVerifiedAt: string | null }>();
    const needBaseline: string[] = [];
    for (const item of items) {
      const prior = existingByKey.get(key(item.id, priorDate));
      if (prior) openingByItem.set(item.id, { qty: nextOpening(comparable(prior)), lastVerifiedAt: prior.last_verified_at });
      else needBaseline.push(item.id);
    }
    if (needBaseline.length) {
      const baselineCounts = await fetchAll<CountRow>((from, to) =>
        svc.from("stock_counts").select("*").eq("location_id", location.id).lt("count_date", start).order("count_date", { ascending: false }).order("position", { ascending: false }).order("id").range(from, to),
      );
      const latestCount = new Map<string, CountRow>();
      for (const c of baselineCounts) if (!latestCount.has(c.inventory_item_id)) latestCount.set(c.inventory_item_id, c);

      const purchasedBefore = new Map<string, Decimal>();
      const usedBefore = new Map<string, Decimal>();
      for (const ids of chunk(needBaseline, IN_CHUNK)) {
        const p = await fetchAll<Tables<"purchases_by_item">>((from, to) =>
          svc.from("purchases_by_item").select("*").eq("location_id", location.id).in("inventory_item_id", ids).lt("received_date", start).order("received_date").order("inventory_item_id").range(from, to),
        );
        for (const r of p) {
          if (!r.inventory_item_id || !r.received_date) continue;
          const c = latestCount.get(r.inventory_item_id);
          if (c && r.received_date < sinceDateOf(c)) continue;
          addTo(purchasedBefore, r.inventory_item_id, r.quantity_base_unit);
        }
        const u = await fetchAll<Tables<"usage_by_period">>((from, to) =>
          svc.from("usage_by_period").select("*").eq("location_id", location.id).in("inventory_item_id", ids).lt("business_date", start).order("business_date").order("inventory_item_id").range(from, to),
        );
        for (const r of u) {
          if (!r.inventory_item_id || !r.business_date) continue;
          const c = latestCount.get(r.inventory_item_id);
          if (c && r.business_date < sinceDateOf(c)) continue;
          addTo(usedBefore, r.inventory_item_id, r.quantity_used);
        }
      }
      for (const id of needBaseline) {
        const c = latestCount.get(id);
        openingByItem.set(id, {
          qty: baselineOpening({
            count_qty: c ? numStr(c.quantity_base_unit) : null,
            purchased_before: (purchasedBefore.get(id) ?? new Decimal(0)).toFixed(4),
            used_before: (usedBefore.get(id) ?? new Decimal(0)).toFixed(4),
          }),
          lastVerifiedAt: c?.counted_at ?? null,
        });
      }
    }

    // ---- compute, item by item, in date order ---------------------------------------------------
    const nowIso = now.toISOString();
    const fallbackReason: RestatementReason = opts.reason ?? "manual";
    const toWrite: TablesInsert<"daily_position">[] = [];

    for (const item of items) {
      try {
        const start0 = openingByItem.get(item.id);
        if (!start0) throw new Error("no opening");
        let opening = start0.qty;
        let lastVerified = start0.lastVerifiedAt;
        let carry: RestatementReason | null = null;
        for (const date of dates) {
          const k = key(item.id, date);
          const slot = countsByKey.get(k);
          const prev = existingByKey.get(k);
          const row: DailyPositionRow = computeDailyPosition({
            business_date: date,
            opening_qty: opening,
            received_qty: (receivedByKey.get(k) ?? new Decimal(0)).toFixed(4),
            theoretical_used_qty: (usedByKey.get(k) ?? new Decimal(0)).toFixed(4),
            count: slot?.close ? toCount(slot.close) : slot?.open ? toCount(slot.open) : null,
            open_count: slot?.close && slot.open ? toCount(slot.open) : null,
            // the cost used for valuation that day: frozen once a row exists, else the cost on file now
            cost_per_base_unit: prev?.cost_per_base_unit != null ? String(prev.cost_per_base_unit) : item.cost_per_base_unit == null ? null : String(item.cost_per_base_unit),
            included_invoice_ids: [...(invoiceIdsByKey.get(k) ?? [])],
            prior_last_verified_at: lastVerified,
          });
          opening = nextOpening(row);
          lastVerified = row.last_verified_at;

          const stockout = stockoutFor(item.id, date);
          let restated_at: string | null = null;
          let restatement_reason: RestatementReason | null = null;
          if (prev) {
            const changed = rowChanged(comparable(prev), row);
            if (!changed && (prev.stockout_minutes ?? 0) === stockout) continue; // identical: leave computed_at/restated_at alone
            if (changed) {
              restatement_reason = directReason(triggers, item.id, date) ?? carry ?? fallbackReason;
              restated_at = nowIso;
              carry = restatement_reason;
              summary.rows_restated += 1;
            }
            // only the 86'd minutes changed: rewrite the row without calling it a restatement
          } else {
            carry = carry ?? directReason(triggers, item.id, date);
          }
          toWrite.push({
            location_id: location.id,
            inventory_item_id: item.id,
            business_date: date,
            opening_qty: num4(row.opening_qty),
            received_qty: num4(row.received_qty),
            theoretical_used_qty: num4(row.theoretical_used_qty),
            expected_close_qty: num4(row.expected_close_qty),
            counted_qty: num4n(row.counted_qty),
            variance_qty: num4n(row.variance_qty),
            variance_value: num4n(row.variance_value),
            cost_per_base_unit: num4n(row.cost_per_base_unit),
            verification: row.verification,
            last_verified_at: row.last_verified_at,
            included_invoice_ids: row.included_invoice_ids,
            included_count_id: row.included_count_id,
            stockout_minutes: stockout,
            computed_at: nowIso,
            restated_at: restated_at ?? prev?.restated_at ?? null,
            restatement_reason: restatement_reason ?? prev?.restatement_reason ?? null,
          });
        }
      } catch (e) {
        summary.item_errors += 1;
        log("daily-position: item failed", { item: item.name, error: e instanceof Error ? e.message : String(e) });
      }
    }

    for (const batch of chunk(toWrite, UPSERT_BATCH)) {
      const { error: uerr } = await svc
        .from("daily_position")
        .upsert(batch, { onConflict: "location_id,inventory_item_id,business_date" });
      if (uerr) throw new Error(`upsert daily_position: ${uerr.message}`);
      summary.rows_written += batch.length;
    }
    log("daily-position: done", { location: location.name, rows: summary.rows_written, restated: summary.rows_restated, errors: summary.item_errors });
  } catch (e) {
    summary.error = e instanceof Error ? e.message : String(e);
    log("daily-position: error", { location: location.name, error: summary.error });
  }
  summary.duration_ms = Date.now() - t0;
  return summary;
}
