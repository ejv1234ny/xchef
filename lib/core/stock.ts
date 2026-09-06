import { z } from "zod";
import Decimal from "decimal.js";

/**
 * Toast Stock API (GET /stock/v1/inventory, scope stock:read) → 86-list events.
 * Pure: the poll job (lib/jobs/stockPoll.ts) validates the payload here, diffs
 * it against the last observed state per menu item, and appends only the
 * changes to menu_item_stock_events. The reconciliation (lib/jobs/dailyPosition.ts)
 * turns the events back into "minutes 86'd during this business day".
 *
 * Toast lists only items whose status is OUT_OF_STOCK or QUANTITY (a limited
 * count); an item that disappears from the list is back IN_STOCK.
 */
export const STOCK_STATUSES = ["IN_STOCK", "OUT_OF_STOCK", "QUANTITY"] as const;
export type StockStatus = (typeof STOCK_STATUSES)[number];

export const StockItemSchema = z.looseObject({
  guid: z.string(),
  status: z.enum(STOCK_STATUSES),
  quantity: z.number().nullish(),
  itemGuidValidity: z.string().nullish(),
});
export type StockItem = z.infer<typeof StockItemSchema>;

export type StockState = { status: StockStatus; quantity: string | null };
export type StockObservation = { guid: string; status: StockStatus; quantity: string | null };
export type StockEvent = { toast_menu_item_guid: string; status: StockStatus; quantity: string | null; observed_at: string };

const qty = (n: number | null | undefined): string | null => (n == null ? null : new Decimal(n).toFixed(2));

/** Validate a raw payload; invalid entries are returned separately (quarantined, never thrown). */
export function parseStockPayload(raw: unknown): { items: StockObservation[]; quarantined: Array<{ guid: string | null; reason: string }> } {
  const items: StockObservation[] = [];
  const quarantined: Array<{ guid: string | null; reason: string }> = [];
  if (!Array.isArray(raw)) return { items, quarantined: [{ guid: null, reason: "payload is not an array" }] };
  for (const entry of raw) {
    const p = StockItemSchema.safeParse(entry);
    if (!p.success) {
      const guid = typeof entry === "object" && entry && "guid" in entry && typeof (entry as { guid: unknown }).guid === "string" ? (entry as { guid: string }).guid : null;
      quarantined.push({ guid, reason: p.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      continue;
    }
    if (p.data.itemGuidValidity && p.data.itemGuidValidity !== "VALID") continue; // Toast flags stale guids
    items.push({ guid: p.data.guid, status: p.data.status, quantity: p.data.status === "QUANTITY" ? qty(p.data.quantity) : null });
  }
  return { items, quarantined };
}

/**
 * Events to append: every listed item whose status (or QUANTITY count) differs
 * from what we last observed, plus an IN_STOCK event for every item we last
 * saw as OUT_OF_STOCK / QUANTITY that Toast no longer lists.
 */
export function diffStockObservations(previous: Map<string, StockState>, current: StockObservation[], observedAt: string): StockEvent[] {
  const events: StockEvent[] = [];
  const seen = new Set<string>();
  for (const c of current) {
    seen.add(c.guid);
    const prev = previous.get(c.guid);
    const same = prev && prev.status === c.status && (prev.status !== "QUANTITY" || (prev.quantity ?? null) === (c.quantity ?? null));
    if (same) continue;
    events.push({ toast_menu_item_guid: c.guid, status: c.status, quantity: c.quantity, observed_at: observedAt });
  }
  for (const [guid, prev] of previous) {
    if (seen.has(guid) || prev.status === "IN_STOCK") continue;
    events.push({ toast_menu_item_guid: guid, status: "IN_STOCK", quantity: null, observed_at: observedAt });
  }
  return events.sort((a, b) => a.toast_menu_item_guid.localeCompare(b.toast_menu_item_guid));
}

/**
 * Minutes inside [windowStart, windowEnd) during which the item was OUT_OF_STOCK,
 * from its event history (any order). The state at windowStart is the latest
 * event before it (or `priorStatus`, default IN_STOCK). Whole minutes, rounded.
 */
export function stockoutMinutes(events: Array<{ observed_at: string; status: string }>, windowStart: Date, windowEnd: Date, priorStatus: string | null = null): number {
  const start = windowStart.getTime();
  const end = windowEnd.getTime();
  if (end <= start) return 0;
  const sorted = [...events].map((e) => ({ t: Date.parse(e.observed_at), status: e.status })).filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
  let status = priorStatus ?? "IN_STOCK";
  let cursor = start;
  let out = 0;
  for (const e of sorted) {
    if (e.t <= start) {
      status = e.status;
      continue;
    }
    if (e.t >= end) break;
    if (status === "OUT_OF_STOCK") out += e.t - cursor;
    cursor = e.t;
    status = e.status;
  }
  if (status === "OUT_OF_STOCK") out += end - cursor;
  return Math.round(out / 60_000);
}

/** "3h 20m" / "45m" for the position table; empty for zero. */
export function fmtMinutes(min: number | null | undefined): string {
  if (!min || min <= 0) return "";
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? (m ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
}
