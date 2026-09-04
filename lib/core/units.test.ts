import { describe, expect, it } from "vitest";
import { convertFactor, parseTextUnit, textUnitToBase } from "./units";

const near = (v: ReturnType<typeof convertFactor>, expected: number, digits = 4) => {
  expect(v).not.toBeNull();
  expect(v!.toNumber()).toBeCloseTo(expected, digits);
};

describe("convertFactor (mirrors SQL convert_factor)", () => {
  it("identity", () => near(convertFactor("oz", "oz"), 1));
  it("volume: oz ↔ ml ↔ l", () => {
    near(convertFactor("oz", "ml"), 29.5735);
    near(convertFactor("ml", "oz"), 1 / 29.5735, 6);
    near(convertFactor("l", "oz"), 33.814, 3);
    near(convertFactor("l", "ml"), 1000);
  });
  it("mass: lb ↔ g ↔ kg", () => {
    near(convertFactor("lb", "g"), 453.592);
    near(convertFactor("kg", "lb"), 2.20462, 4);
    near(convertFactor("g", "kg"), 0.001, 6);
  });
  it("returns null for incompatible pairs (SQL returns 1; we refuse to guess)", () => {
    expect(convertFactor("oz", "lb")).toBeNull();
    expect(convertFactor("case", "oz")).toBeNull();
    expect(convertFactor("each", "bottle")).toBeNull();
  });
});

describe("parseTextUnit", () => {
  it("normalizes invoice spellings", () => {
    expect(parseTextUnit("LBS")).toBe("lb");
    expect(parseTextUnit("#")).toBe("lb");
    expect(parseTextUnit("Z")).toBe("oz");
    expect(parseTextUnit("FL OZ")).toBe("floz");
    expect(parseTextUnit("GAL")).toBe("gal");
    expect(parseTextUnit("Ltr")).toBe("l");
    expect(parseTextUnit("ct")).toBe("each");
    expect(parseTextUnit("BBL")).toBeNull();
  });
});

describe("textUnitToBase", () => {
  it("volume text units into oz", () => {
    near(textUnitToBase("gal", "oz"), 128);
    near(textUnitToBase("qt", "oz"), 32);
    near(textUnitToBase("pt", "oz"), 16);
    near(textUnitToBase("floz", "oz"), 1);
    near(textUnitToBase("ml", "oz"), 0.0338, 4);
    near(textUnitToBase("l", "oz"), 33.814, 3);
  });
  it("oz is a weight ounce when the base unit is a mass", () => {
    near(textUnitToBase("oz", "lb"), 0.0625, 5);
    near(textUnitToBase("oz", "g"), 28.3495);
    near(textUnitToBase("oz", "oz"), 1);
  });
  it("mass text units into lb / kg", () => {
    near(textUnitToBase("kg", "lb"), 2.20462, 4);
    near(textUnitToBase("g", "kg"), 0.001, 6);
    near(textUnitToBase("lb", "lb"), 1);
  });
  it("rejects mass↔volume and count↔physical", () => {
    expect(textUnitToBase("lb", "oz")).toBeNull();
    expect(textUnitToBase("gal", "lb")).toBeNull();
    expect(textUnitToBase("ml", "each")).toBeNull();
    expect(textUnitToBase("each", "oz")).toBeNull();
    near(textUnitToBase("each", "each"), 1);
    near(textUnitToBase("each", "bottle"), 1);
  });
});
