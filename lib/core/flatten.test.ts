import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { OrderSchema } from "@/lib/toast/schemas";
import { flattenOrders, touchedBusinessDates } from "./flatten";
import { businessDateToIso } from "./dates";

const fixture = z.array(OrderSchema).parse(
  JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/toast/synthetic-orders.json"), "utf8")),
);

const byKey = (rows: ReturnType<typeof flattenOrders>) =>
  Object.fromEntries(rows.map((r) => [`${r.business_date}|${r.toast_menu_item_guid}`, r]));

describe("flattenOrders", () => {
  const rows = byKey(flattenOrders(fixture));

  it("sums sold quantity per item per business date and keeps voids separate", () => {
    // order-1: 2 sold; check-1b voided (3 → voided); check-1c deleted (ignored);
    // order-5 late tab: 1 sold on 2026-09-01 (Toast businessDate, not openedDate)
    expect(rows["2026-09-01|item-margarita"].quantity_sold).toBe("3.00");
    expect(rows["2026-09-01|item-margarita"].quantity_voided).toBe("3.00");
    expect(rows["2026-09-02|item-margarita"].quantity_sold).toBe("4.00");
  });

  it("selection-level void goes to quantity_voided", () => {
    // sel-2 voided (1); order-2 voided at order level (2); sel-8 refunded but NOT subtracted (1 sold)
    expect(rows["2026-09-01|item-burger"].quantity_voided).toBe("3.00");
    expect(rows["2026-09-01|item-burger"].quantity_sold).toBe("1.00");
  });

  it("modifier with its own item.guid becomes its own row; modifiers without one are ignored", () => {
    expect(rows["2026-09-01|item-sub-patron"].quantity_sold).toBe("2.00");
    expect(Object.keys(rows).some((k) => k.includes("No Salt"))).toBe(false);
    expect(Object.keys(rows)).toHaveLength(5); // margarita × 2 dates, burger, sub-patron, wings
  });

  it("keeps decimal quantities for weight items", () => {
    expect(rows["2026-09-01|item-wings-lb"].quantity_sold).toBe("1.35");
  });

  it("skips deleted orders entirely", () => {
    expect(rows["2026-09-01|item-burger"].quantity_sold).not.toBe("51.00");
  });

  it("net_sales sums selection.price of non-voided lines only", () => {
    expect(rows["2026-09-01|item-margarita"].net_sales).toBe("36.00"); // 24 + 12
    expect(rows["2026-09-01|item-burger"].net_sales).toBe("17.00");
  });

  it("uses Toast businessDate for the 11:50pm → 1:10am tab", () => {
    const late = fixture.find((o) => o.guid === "order-5-late-tab")!;
    expect(late.openedDate?.startsWith("2026-09-02")).toBe(true);
    expect(businessDateToIso(late.businessDate)).toBe("2026-09-01");
  });

  it("reports touched business dates", () => {
    expect(touchedBusinessDates(fixture)).toEqual(["2026-09-01", "2026-09-02"]);
  });

  it("is deterministic (idempotent rollup)", () => {
    expect(flattenOrders(fixture)).toEqual(flattenOrders([...fixture].reverse()));
  });
});

describe("businessDateToIso", () => {
  it("accepts int and string forms", () => {
    expect(businessDateToIso(20260903)).toBe("2026-09-03");
    expect(businessDateToIso("20260903")).toBe("2026-09-03");
    expect(businessDateToIso("2026-09-03")).toBe("2026-09-03");
    expect(() => businessDateToIso("nope")).toThrow();
  });
});
