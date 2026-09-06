import type { ServiceClient } from "@/lib/db/service";
import type { Tables } from "@/lib/db/types";
import type { ToastClient } from "@/lib/toast/client";
import { diffStockObservations, parseStockPayload, type StockState } from "@/lib/core/stock";

/**
 * 86-list poll (KICKOFF-3 item 5). Called by the 5-minute toast-sync after the
 * orders window: GET /stock/v1/inventory (read-only, scope stock:read),
 * validate, diff against menu_item_stock_latest, append the changes to
 * menu_item_stock_events. Never throws — the sync run must not fail because
 * the stock endpoint hiccupped; the summary carries the error.
 */
export type Logger = (msg: string, meta?: Record<string, unknown>) => void;

export type StockPollSummary = { location_id: string; observed: number; quarantined: number; events: number; error: string | null };

export async function pollStockStatus(svc: ServiceClient, client: ToastClient, location: Pick<Tables<"locations">, "id" | "name">, log: Logger = () => {}, now = new Date()): Promise<StockPollSummary> {
  const summary: StockPollSummary = { location_id: location.id, observed: 0, quarantined: 0, events: 0, error: null };
  try {
    const raw = await client.stockInventory();
    const { items, quarantined } = parseStockPayload(raw);
    summary.observed = items.length;
    summary.quarantined = quarantined.length;
    for (const q of quarantined) log("stock-poll: quarantined entry", { guid: q.guid, reason: q.reason });

    const { data: latest, error } = await svc.from("menu_item_stock_latest").select("toast_menu_item_guid, status, quantity").eq("location_id", location.id);
    if (error) throw new Error(`read menu_item_stock_latest: ${error.message}`);
    const previous = new Map<string, StockState>();
    for (const l of latest ?? []) {
      if (!l.toast_menu_item_guid || !l.status) continue;
      previous.set(l.toast_menu_item_guid, { status: l.status as StockState["status"], quantity: l.quantity == null ? null : Number(l.quantity).toFixed(2) });
    }

    const events = diffStockObservations(previous, items, now.toISOString());
    if (events.length) {
      const { error: ierr } = await svc.from("menu_item_stock_events").insert(
        events.map((e) => ({ location_id: location.id, toast_menu_item_guid: e.toast_menu_item_guid, status: e.status, quantity: e.quantity == null ? null : Number(e.quantity), observed_at: e.observed_at })),
      );
      if (ierr) throw new Error(`insert menu_item_stock_events: ${ierr.message}`);
    }
    summary.events = events.length;
    log("stock-poll: done", { location: location.name, observed: items.length, events: events.length, quarantined: quarantined.length });
  } catch (e) {
    summary.error = e instanceof Error ? e.message : String(e);
    log("stock-poll: error", { location: location.name, error: summary.error });
  }
  return summary;
}
