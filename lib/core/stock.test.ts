import { describe, expect, it } from "vitest";
import { diffStockObservations, fmtMinutes, parseStockPayload, stockoutMinutes, type StockState } from "./stock";
import { businessDayWindow } from "./dates";

/** Shape of the real GET /stock/v1/inventory payload for Mad Moose (guids real, nothing else identifying). */
const PAYLOAD = [
  { guid: "7257eac0-7cd0-4130-b2f6-5d4ac84b7bd2", itemGuidValidity: "VALID", status: "QUANTITY", quantity: 1.0, multiLocationId: "1600000000346023334", versionId: "7257eac0-7cd0-4130-b2f6-5d4ac84b7bd2" },
  { guid: "c788112e-71f6-42c0-b9dd-5f2607c9c31b", itemGuidValidity: "VALID", status: "OUT_OF_STOCK", quantity: null, multiLocationId: "1600000000480932469", versionId: "c788112e-71f6-42c0-b9dd-5f2607c9c31b" },
  { guid: "a05bd162-6c20-4f93-9bf0-b28f130b900f", itemGuidValidity: "VALID", status: "OUT_OF_STOCK", quantity: null, multiLocationId: "1600000000346022879", versionId: "a05bd162-6c20-4f93-9bf0-b28f130b900f" },
  { guid: "deadbeef-0000-0000-0000-000000000000", itemGuidValidity: "INVALID", status: "OUT_OF_STOCK", quantity: null },
  { guid: 12345, status: "OUT_OF_STOCK" },
];

describe("parseStockPayload", () => {
  it("validates with zod, drops invalid guids, quarantines bad entries", () => {
    const { items, quarantined } = parseStockPayload(PAYLOAD);
    expect(items).toEqual([
      { guid: "7257eac0-7cd0-4130-b2f6-5d4ac84b7bd2", status: "QUANTITY", quantity: "1.00" },
      { guid: "c788112e-71f6-42c0-b9dd-5f2607c9c31b", status: "OUT_OF_STOCK", quantity: null },
      { guid: "a05bd162-6c20-4f93-9bf0-b28f130b900f", status: "OUT_OF_STOCK", quantity: null },
    ]);
    expect(quarantined).toHaveLength(1);
    expect(parseStockPayload({ not: "an array" }).quarantined[0].reason).toContain("not an array");
  });
});

describe("diffStockObservations — events, not snapshots", () => {
  const T = "2026-09-05T20:40:00.000Z";
  const { items } = parseStockPayload(PAYLOAD);

  it("first poll: every listed item is an event", () => {
    const ev = diffStockObservations(new Map(), items, T);
    expect(ev).toHaveLength(3);
    expect(ev.every((e) => e.observed_at === T)).toBe(true);
  });

  it("unchanged poll: no events", () => {
    const prev = new Map<string, StockState>(items.map((i) => [i.guid, { status: i.status, quantity: i.quantity }]));
    expect(diffStockObservations(prev, items, T)).toEqual([]);
  });

  it("an item that drops off Toast's list is back IN_STOCK; a QUANTITY count change is an event; an IN_STOCK item staying absent is nothing", () => {
    const prev = new Map<string, StockState>([
      ["c788112e-71f6-42c0-b9dd-5f2607c9c31b", { status: "OUT_OF_STOCK", quantity: null }],
      ["7257eac0-7cd0-4130-b2f6-5d4ac84b7bd2", { status: "QUANTITY", quantity: "3.00" }],
      ["a05bd162-6c20-4f93-9bf0-b28f130b900f", { status: "IN_STOCK", quantity: null }],
      ["ffffffff-0000-0000-0000-000000000000", { status: "IN_STOCK", quantity: null }],
    ]);
    const current = [{ guid: "7257eac0-7cd0-4130-b2f6-5d4ac84b7bd2", status: "QUANTITY" as const, quantity: "1.00" }, { guid: "a05bd162-6c20-4f93-9bf0-b28f130b900f", status: "OUT_OF_STOCK" as const, quantity: null }];
    const ev = diffStockObservations(prev, current, T);
    expect(ev).toEqual([
      { toast_menu_item_guid: "7257eac0-7cd0-4130-b2f6-5d4ac84b7bd2", status: "QUANTITY", quantity: "1.00", observed_at: T },
      { toast_menu_item_guid: "a05bd162-6c20-4f93-9bf0-b28f130b900f", status: "OUT_OF_STOCK", quantity: null, observed_at: T },
      { toast_menu_item_guid: "c788112e-71f6-42c0-b9dd-5f2607c9c31b", status: "IN_STOCK", quantity: null, observed_at: T },
    ]);
  });
});

describe("stockoutMinutes — how much of a business day an item was 86'd", () => {
  // business day Fri 2026-09-04 at Mad Moose: 4 a.m. ET Sep 4 → 4 a.m. ET Sep 5 (EDT = UTC−4)
  const { start, end } = businessDayWindow("2026-09-04", "America/New_York");
  it("the window is 4 a.m. local to 4 a.m. local next day", () => {
    expect(start.toISOString()).toBe("2026-09-04T08:00:00.000Z");
    expect(end.toISOString()).toBe("2026-09-05T08:00:00.000Z");
  });
  it("86'd at 8:40 pm, back at 11:00 pm → 140 minutes", () => {
    const ev = [
      { observed_at: "2026-09-05T00:40:00.000Z", status: "OUT_OF_STOCK" },
      { observed_at: "2026-09-05T03:00:00.000Z", status: "IN_STOCK" },
    ];
    expect(stockoutMinutes(ev, start, end)).toBe(140);
  });
  it("86'd before the window opens and never restocked → the whole day (1440)", () => {
    expect(stockoutMinutes([{ observed_at: "2026-09-03T22:00:00.000Z", status: "OUT_OF_STOCK" }], start, end)).toBe(1440);
    expect(stockoutMinutes([], start, end, "OUT_OF_STOCK")).toBe(1440);
  });
  it("restocked before the window and 86'd after it → 0; QUANTITY (limited) is not 86'd", () => {
    expect(stockoutMinutes([{ observed_at: "2026-09-03T22:00:00.000Z", status: "OUT_OF_STOCK" }, { observed_at: "2026-09-04T07:00:00.000Z", status: "IN_STOCK" }, { observed_at: "2026-09-05T09:00:00.000Z", status: "OUT_OF_STOCK" }], start, end)).toBe(0);
    expect(stockoutMinutes([{ observed_at: "2026-09-04T12:00:00.000Z", status: "QUANTITY" }], start, end)).toBe(0);
  });
  it("formats minutes for the position table", () => {
    expect(fmtMinutes(140)).toBe("2h 20m");
    expect(fmtMinutes(60)).toBe("1h");
    expect(fmtMinutes(45)).toBe("45m");
    expect(fmtMinutes(0)).toBe("");
  });
});
