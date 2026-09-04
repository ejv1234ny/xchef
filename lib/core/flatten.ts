import Decimal from "decimal.js";
import type { ToastOrder, ToastSelection } from "@/lib/toast/schemas";
import { businessDateToIso } from "./dates";

/**
 * Pure rollup of Toast orders into sales_facts rows (CLAUDE.md rule 3):
 *  - skip deleted orders / deleted checks
 *  - voided (order, check or selection) → quantity_voided, never quantity_sold
 *  - modifiers that carry their own item.guid become their own rows
 *  - refunds are NOT subtracted (the product was consumed)
 *  - decimal quantities (weight items, unitOfMeasure ≠ NONE) are kept as-is
 *  - business_date is Toast's businessDate, never the calendar date of openedDate
 * Quantities/money are Decimal internally and returned as strings.
 */
export type SalesFactRow = {
  toast_menu_item_guid: string;
  business_date: string;
  quantity_sold: string;
  quantity_voided: string;
  net_sales: string;
  /** most recent displayName seen for the guid; display only, not stored */
  item_name: string | null;
};

type Acc = { sold: Decimal; voided: Decimal; net: Decimal; name: string | null };

export function flattenOrders(orders: ToastOrder[]): SalesFactRow[] {
  const acc = new Map<string, Acc>();

  const bump = (guid: string, date: string, qty: Decimal, price: Decimal, isVoid: boolean, name: string | null) => {
    const key = `${date}|${guid}`;
    const a = acc.get(key) ?? { sold: new Decimal(0), voided: new Decimal(0), net: new Decimal(0), name: null };
    if (isVoid) a.voided = a.voided.plus(qty);
    else {
      a.sold = a.sold.plus(qty);
      a.net = a.net.plus(price);
    }
    if (name) a.name = name;
    acc.set(key, a);
  };

  const walk = (sel: ToastSelection, date: string, parentVoid: boolean) => {
    const isVoid = parentVoid || Boolean(sel.voided);
    const guid = sel.item?.guid;
    if (guid) {
      const qty = new Decimal(sel.quantity ?? 0);
      const price = new Decimal(sel.price ?? 0);
      bump(guid, date, qty, price, isVoid, sel.displayName ?? null);
    }
    for (const m of sel.modifiers ?? []) walk(m, date, isVoid);
  };

  for (const order of orders) {
    if (order.deleted) continue;
    const date = businessDateToIso(order.businessDate);
    for (const check of order.checks ?? []) {
      if (check.deleted) continue;
      const checkVoid = Boolean(order.voided) || Boolean(check.voided);
      for (const sel of check.selections ?? []) walk(sel, date, checkVoid);
    }
  }

  const rows: SalesFactRow[] = [];
  for (const [key, a] of acc) {
    const [business_date, toast_menu_item_guid] = key.split("|");
    rows.push({
      toast_menu_item_guid,
      business_date,
      quantity_sold: a.sold.toFixed(2),
      quantity_voided: a.voided.toFixed(2),
      net_sales: a.net.toFixed(2),
      item_name: a.name,
    });
  }
  rows.sort((x, y) => x.business_date.localeCompare(y.business_date) || x.toast_menu_item_guid.localeCompare(y.toast_menu_item_guid));
  return rows;
}

/** Distinct business dates present in a set of orders. */
export function touchedBusinessDates(orders: ToastOrder[]): string[] {
  return [...new Set(orders.map((o) => businessDateToIso(o.businessDate)))].sort();
}
