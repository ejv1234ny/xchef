import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { DEFAULT_PACKS, normalizePackText, parsePackSize, type PackParse } from "./packs";

const n = (s: string | null | undefined) => (s == null ? null : new Decimal(s).toNumber());

function expectPack(p: PackParse, units: number, per: number | null, source: PackParse["source"]) {
  expect(n(p.units_per_pack)).toBeCloseTo(units, 4);
  if (per === null) expect(p.base_units_per_unit).toBeNull();
  else expect(n(p.base_units_per_unit)).toBeCloseTo(per, 3);
  expect(p.source).toBe(source);
  expect(p.assumed_text.length).toBeGreaterThan(0);
}

describe("parsePackSize — the required examples", () => {
  it('"6/#10" (oz) → 6 × #10 default 106 oz with range 102–128', () => {
    const p = parsePackSize("6/#10", "oz");
    expectPack(p, 6, 106, "default");
    expect(p.range).toEqual({ min: "102.0000", max: "128.0000" });
    expect(p.assumed_text).toBe("6 × #10 can ≈ 106 oz (102–128, assumed)");
  });
  it('"3/114OZ" (oz) → 3 × 114 parsed', () => expectPack(parsePackSize("3/114OZ", "oz"), 3, 114, "parsed"));
  it('"12/750ML" (oz) → 12 × 25.3605 parsed', () => {
    const p = parsePackSize("12/750ML", "oz");
    expectPack(p, 12, 25.3605, "parsed");
    expect(p.base_units_per_unit).toBe("25.3605");
  });
  it('"4/1GAL" (oz) → 4 × 128', () => {
    const p = parsePackSize("4/1GAL", "oz");
    expectPack(p, 4, 128, "parsed");
    expect(p.base_units_per_unit).toBe("128.0000");
  });
  it('"40 LB" (lb) → 1 × 40', () => expectPack(parsePackSize("40 LB", "lb"), 1, 40, "parsed"));
  it('"CS" → units 1, size unknown', () => {
    for (const base of ["each", "oz"] as const) {
      const p = parsePackSize("CS", base);
      expectPack(p, 1, null, "unknown");
      expect(p.assumed_text).toBe("case (size unknown)");
    }
  });
  it('"2/5LB" (lb) → 2 × 5', () => expectPack(parsePackSize("2/5LB", "lb"), 2, 5, "parsed"));
  it('"24/12OZ" (oz) → 24 × 12', () => expectPack(parsePackSize("24/12OZ", "oz"), 24, 12, "parsed"));
  it('"1/6 BBL" (oz) → 1 × 661 default', () => {
    const p = parsePackSize("1/6 BBL", "oz");
    expectPack(p, 1, 661, "default");
    expect(p.assumed_text).toContain("sixth-barrel");
  });
  it('"50 LB BAG" (lb) → 1 × 50', () => expectPack(parsePackSize("50 LB BAG", "lb"), 1, 50, "parsed"));
  it('"1/2 BBL" (oz) → 1984', () => expectPack(parsePackSize("1/2 BBL", "oz"), 1, 1984, "default"));
  it('"750ML" alone (oz) → 1 × 25.3605', () => expectPack(parsePackSize("750ML", "oz"), 1, 25.3605, "parsed"));
  it('"6/750ML" (oz) → 6 × 25.3605', () => expectPack(parsePackSize("6/750ML", "oz"), 6, 25.3605, "parsed"));
  it('"12/1L" (oz) → 12 × 33.814', () => expectPack(parsePackSize("12/1L", "oz"), 12, 33.814, "parsed"));
  it('"EA" / "EACH" (each) → 1 × 1', () => {
    expectPack(parsePackSize("EA", "each"), 1, 1, "parsed");
    expectPack(parsePackSize("EACH", "each"), 1, 1, "parsed");
  });
});

describe("parsePackSize — precedence and robustness", () => {
  it("a parsed size always beats a default (#10 with explicit ounces)", () => {
    const parsed = parsePackSize("6/108OZ", "oz");
    const def = parsePackSize("6/#10", "oz");
    expect(parsed.source).toBe("parsed");
    expect(def.source).toBe("default");
    expect(parsed.base_units_per_unit).toBe("108.0000");
    expect(parsed.range).toBeUndefined();
  });
  it("is case-insensitive and whitespace-tolerant", () => {
    expectPack(parsePackSize("6 / 750 ml", "oz"), 6, 25.3605, "parsed");
    expectPack(parsePackSize("  6 x 750ML ", "oz"), 6, 25.3605, "parsed");
    expectPack(parsePackSize("40 lbs", "lb"), 1, 40, "parsed");
    expectPack(parsePackSize("6 / #10", "oz"), 6, 106, "default");
  });
  it("unit incompatible with the base unit → unknown with an explanation", () => {
    const p = parsePackSize("40 LB", "oz");
    expectPack(p, 1, null, "unknown");
    expect(p.assumed_text).toMatch(/weight/);
    expect(p.assumed_text).toMatch(/oz/);
  });
  it("oz against a mass base is a weight ounce", () => {
    expectPack(parsePackSize("24/12OZ", "lb"), 24, 0.75, "parsed");
    expectPack(parsePackSize("6/#10", "lb"), 6, 6.625, "default");
  });
  it("fractions of a unit: 1/2 GAL, 1/4 LB", () => {
    expectPack(parsePackSize("1/2 GAL", "oz"), 1, 64, "parsed");
    expectPack(parsePackSize("1/4 LB", "lb"), 1, 0.25, "parsed");
  });
  it("pound sign and Z shorthand (Restaurant Depot)", () => {
    expectPack(parsePackSize("5# BAG", "lb"), 1, 5, "parsed");
    expectPack(parsePackSize("4/2.5#", "lb"), 4, 2.5, "parsed");
    expectPack(parsePackSize("16Z", "oz"), 1, 16, "parsed");
  });
  it("Restaurant Depot detail strings", () => {
    expectPack(parsePackSize("13.21 LB @ $6.49/LB", "lb"), 1, 13.21, "parsed");
    const cs = parsePackSize("C · 1cs/7u", "each");
    expectPack(cs, 7, 1, "parsed");
    expectPack(parsePackSize("case $15.00 / 12", "each"), 12, 1, "parsed");
    expectPack(parsePackSize("(TA) case $32.58/100", "each"), 100, 1, "parsed");
    expectPack(parsePackSize("2X U @ $13.61", "each"), 2, 1, "parsed");
    expectPack(parsePackSize("U", "oz"), 1, null, "unknown");
  });
  it("count against a physical base is unknown, not 1", () => {
    const p = parsePackSize("24 CT", "oz");
    expectPack(p, 24, null, "unknown");
  });
  it("count base units: a bottle is one bottle", () => {
    const p = parsePackSize("12/750ML", "bottle");
    expectPack(p, 12, 1, "parsed");
    expect(p.assumed_text).toContain("counted as 1 bottle");
  });
  it("empty / garbage", () => {
    expectPack(parsePackSize(null, "oz"), 1, null, "unknown");
    expectPack(parsePackSize("V void", "oz"), 1, null, "unknown");
  });
  it("normalizePackText", () => {
    expect(normalizePackText("6 / 750 ml")).toBe("6/750 ML");
    expect(normalizePackText("13.21 LB @ $6.49/LB")).toBe("13.21 LB");
    expect(normalizePackText("U(TA) case $210.56/175")).toBe("U CASE $210.56/175");
  });
});

describe("DEFAULT_PACKS", () => {
  it("every default carries assumed_text; #10 carries a range", () => {
    for (const d of Object.values(DEFAULT_PACKS)) {
      expect(d.assumed_text.length).toBeGreaterThan(0);
      expect(Number(d.size)).toBeGreaterThan(0);
    }
    expect(DEFAULT_PACKS["#10"].range).toEqual({ min: "102", max: "128" });
    expect(Object.keys(DEFAULT_PACKS)).toEqual(
      expect.arrayContaining(["#10", "#5", "#300", "1/6 bbl", "1/4 bbl", "1/2 bbl", "750ml", "1l", "1.75l", "12oz can", "16oz can"]),
    );
  });
});
