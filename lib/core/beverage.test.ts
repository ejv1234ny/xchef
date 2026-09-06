import { describe, expect, it } from "vitest";
import { familyHint, inferBibSize, isGasCylinderLine } from "./beverage";
import { parsePackSize } from "./packs";

describe("beverage distributor tickets — bag-in-box size from the product name", () => {
  it("reads 2.5GBIB / 5GBIB / spelled-out forms", () => {
    expect(inferBibSize("2.5GBIB COKE")).toEqual({ text: "2.5 GAL BIB", gallons: "2.5" });
    expect(inferBibSize("2.5GBIB DT COKE")).toEqual({ text: "2.5 GAL BIB", gallons: "2.5" });
    expect(inferBibSize("5GBIB SPRITE")).toEqual({ text: "5 GAL BIB", gallons: "5" });
    expect(inferBibSize("COKE CLASSIC 2.5 GAL BIB")).toEqual({ text: "2.5 GAL BIB", gallons: "2.5" });
    expect(inferBibSize("BIB 5 GAL LEMONADE")).toEqual({ text: "5 GAL BIB", gallons: "5" });
    expect(inferBibSize("20#CYL CO2 FULL #1")).toBeNull();
    expect(inferBibSize("2.5 GALLO 1-Ls JUICE DRI")).toBeNull();
  });

  it("a 2.5 gal BIB parses to 320 fl oz (default, overridable) and 5 gal to 640", () => {
    const p = parsePackSize("2.5 GAL BIB", "oz");
    expect(p.source).toBe("default");
    expect(p.units_per_pack).toBe("1.0000");
    expect(p.base_units_per_unit).toBe("320.0000");
    expect(p.assumed_text).toContain("320");
    expect(parsePackSize("2.5GBIB", "oz").base_units_per_unit).toBe("320.0000");
    expect(parsePackSize("5GBIB", "oz").base_units_per_unit).toBe("640.0000");
    // in litres it is 9.46 L
    expect(Number(parsePackSize("2.5 GAL BIB", "l").base_units_per_unit)).toBeCloseTo(9.4635, 3);
    // a parsed size always beats the default
    expect(parsePackSize("3/114OZ", "oz").source).toBe("parsed");
  });

  it("the bracketed family the parser appends names the stocked ingredient when the product name is unreadable", () => {
    expect(familyHint("2.5GBIB GP PRE-LMND T [TEA]")).toBe("iced tea");
    expect(familyHint("2.5GBIB COKE [SPARKLING]")).toBeNull();
    expect(familyHint("2.5GBIB COKE")).toBeNull();
  });

  it("CO2 cylinders and tank rentals are gas, not inventory", () => {
    expect(isGasCylinderLine("20#CYL CO2 FULL #1")).toBe(true);
    expect(isGasCylinderLine("CO2 CYLINDER 20 LB")).toBe(true);
    expect(isGasCylinderLine("NITROGEN TANK RENTAL")).toBe(true);
    expect(isGasCylinderLine("2.5GBIB COKE")).toBe(false);
    expect(isGasCylinderLine("CYLINDRICAL ICE CUBES")).toBe(false);
  });
});
