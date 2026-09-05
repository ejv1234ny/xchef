import { describe, expect, it } from "vitest";
import {
  baselineOpening,
  computeDailyPosition,
  currentBusinessDate,
  dateRange,
  daysBetween,
  nextOpening,
  reconciliationDate,
  rowChanged,
  sinceDateOf,
  type DailyPositionInput,
} from "./position";

// The documented case (architecture.md / BLUEPRINT §5.5): tequila blanco, oz.
// Open-tap baseline 297.76 oz, 40 margaritas × 1.5 oz = 60 oz used, close count 230 oz.
const TEQUILA_COST = "1.0250"; // $/oz
const openTap = {
  id: "count-open",
  quantity_base_unit: "297.7600",
  position: "open" as const,
  verification: "confirmed_estimate" as const,
  counted_at: "2026-09-03T14:00:00Z",
};
const closeCount = {
  id: "count-close",
  quantity_base_unit: "230.0000",
  position: "close" as const,
  verification: "counted" as const,
  counted_at: "2026-09-04T03:10:00Z",
};

const documented: DailyPositionInput = {
  business_date: "2026-09-03",
  opening_qty: "150.0000", // whatever the chain said: the open tap overrides it
  received_qty: "0",
  theoretical_used_qty: "60.0000",
  count: closeCount,
  open_count: openTap,
  cost_per_base_unit: TEQUILA_COST,
  included_invoice_ids: [],
};

describe("computeDailyPosition", () => {
  it("(a) open tap sets the opening, close count produces the 7.76 oz variance", () => {
    const row = computeDailyPosition(documented);
    expect(row.opening_qty).toBe("297.7600");
    expect(row.theoretical_used_qty).toBe("60.0000");
    expect(row.expected_close_qty).toBe("237.7600");
    expect(row.counted_qty).toBe("230.0000");
    expect(row.variance_qty).toBe("7.7600"); // positive = short
    expect(row.variance_value).toBe("7.9540"); // 7.76 × 1.025
    expect(row.verification).toBe("counted");
    expect(row.included_count_id).toBe("count-close");
    expect(row.last_verified_at).toBe(closeCount.counted_at);
    // the next day opens at the counted close, not the expected one
    expect(nextOpening(row)).toBe("230.0000");
  });

  it("(b) late-invoice restatement: opening unchanged, expected close and variance move by the received amount", () => {
    const before = computeDailyPosition(documented);
    const after = computeDailyPosition({ ...documented, received_qty: "25.3600", included_invoice_ids: ["inv-late"] });
    expect(after.opening_qty).toBe(before.opening_qty);
    expect(after.received_qty).toBe("25.3600");
    expect(after.expected_close_qty).toBe("263.1200"); // +25.36
    expect(after.variance_qty).toBe("33.1200"); // 7.76 + 25.36
    expect(after.variance_value).toBe("33.9480");
    expect(rowChanged(before, after)).toBe(true);
    expect(rowChanged(before, computeDailyPosition(documented))).toBe(false);
  });

  it("(c) no count → counted null, variance null, verification none; opening flows from the prior day", () => {
    const row = computeDailyPosition({
      business_date: "2026-09-04",
      opening_qty: "230.0000",
      received_qty: "0",
      theoretical_used_qty: "12.0000",
      count: null,
      cost_per_base_unit: TEQUILA_COST,
      prior_last_verified_at: closeCount.counted_at,
    });
    expect(row.expected_close_qty).toBe("218.0000");
    expect(row.counted_qty).toBeNull();
    expect(row.variance_qty).toBeNull();
    expect(row.variance_value).toBeNull();
    expect(row.verification).toBe("none");
    expect(row.included_count_id).toBeNull();
    expect(row.last_verified_at).toBe(closeCount.counted_at); // carried forward
    expect(nextOpening(row)).toBe("218.0000");
  });

  it("(d) numeric strings only — never floats; 4 dp everywhere, exact where floats would drift", () => {
    const row = computeDailyPosition({
      business_date: "2026-09-04",
      opening_qty: "0.1",
      received_qty: "0.2",
      theoretical_used_qty: "0",
      count: { ...closeCount, quantity_base_unit: "0.3" },
      cost_per_base_unit: "3",
    });
    expect(row.expected_close_qty).toBe("0.3000"); // 0.1 + 0.2 === 0.30000000000000004 as floats
    expect(row.variance_qty).toBe("0.0000");
    expect(row.variance_value).toBe("0.0000");
    for (const v of Object.values(row)) expect(typeof v === "number").toBe(false);
  });

  it("an open-only day records verification without a variance", () => {
    const row = computeDailyPosition({ ...documented, count: openTap, open_count: null });
    expect(row.opening_qty).toBe("297.7600");
    expect(row.expected_close_qty).toBe("237.7600");
    expect(row.counted_qty).toBeNull();
    expect(row.variance_qty).toBeNull();
    expect(row.verification).toBe("confirmed_estimate");
    expect(row.included_count_id).toBe("count-open");
  });

  it("a ✓ (confirmed_estimate) close count resets the baseline but never shows a variance", () => {
    const row = computeDailyPosition({
      ...documented,
      open_count: null,
      count: { ...closeCount, verification: "confirmed_estimate", quantity_base_unit: "87.7600" },
    });
    expect(row.opening_qty).toBe("150.0000");
    expect(row.expected_close_qty).toBe("90.0000");
    expect(row.counted_qty).toBe("87.7600");
    expect(row.variance_qty).toBeNull();
    expect(row.variance_value).toBeNull();
    expect(row.verification).toBe("confirmed_estimate");
    expect(nextOpening(row)).toBe("87.7600");
  });

  it("negative variance = more on the shelf than expected (over)", () => {
    const row = computeDailyPosition({ ...documented, count: { ...closeCount, quantity_base_unit: "240.0000" } });
    expect(row.variance_qty).toBe("-2.2400");
    expect(row.variance_value).toBe("-2.2960");
  });
});

describe("baseline and windows (mirror on_hand_estimate)", () => {
  it("since_date is the count day for open counts and the next day for close counts", () => {
    expect(sinceDateOf({ count_date: "2026-09-03", position: "open" })).toBe("2026-09-03");
    expect(sinceDateOf({ count_date: "2026-09-03", position: "close" })).toBe("2026-09-04");
  });

  it("baselineOpening = latest earlier count (or zero) + purchases − usage before the chain", () => {
    expect(baselineOpening({ count_qty: null, purchased_before: "304.3200", used_before: "12.0000" })).toBe("292.3200");
    expect(baselineOpening({ count_qty: "230.0000", purchased_before: "0", used_before: "0" })).toBe("230.0000");
  });

  it("rowChanged ignores timestamp formatting and invoice-id order", () => {
    const a = computeDailyPosition({ ...documented, included_invoice_ids: ["b", "a"] });
    const b = {
      ...computeDailyPosition({ ...documented, included_invoice_ids: ["a", "b"] }),
      last_verified_at: "2026-09-04T03:10:00+00:00",
    };
    expect(rowChanged(a, b)).toBe(false);
    expect(rowChanged(a, { ...b, cost_per_base_unit: "1.0300" })).toBe(true);
  });
});

describe("business dates", () => {
  it("4 a.m. local cutoff: a run at 5 a.m. ET on Sep 5 reconciles Sep 4", () => {
    const fiveAmEt = new Date("2026-09-05T09:00:00Z");
    expect(currentBusinessDate("America/New_York", fiveAmEt)).toBe("2026-09-05");
    expect(reconciliationDate("America/New_York", fiveAmEt)).toBe("2026-09-04");
  });

  it("a 1 a.m. tab still belongs to the previous business day", () => {
    const oneAmEt = new Date("2026-09-05T05:00:00Z");
    expect(currentBusinessDate("America/New_York", oneAmEt)).toBe("2026-09-04");
    expect(reconciliationDate("America/New_York", oneAmEt)).toBe("2026-09-03");
  });

  it("date helpers", () => {
    expect(daysBetween("2026-09-01", "2026-09-04")).toBe(3);
    expect(dateRange("2026-08-30", "2026-09-02")).toEqual(["2026-08-30", "2026-08-31", "2026-09-01", "2026-09-02"]);
  });
});
