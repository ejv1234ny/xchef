import { describe, expect, it } from "vitest";
import { inferBottleSize } from "./liquor";

describe("inferBottleSize (retail liquor receipts)", () => {
  it("reads common bottle sizes out of item names", () => {
    expect(inferBottleSize("TITOS HANDMADE VODKA 1.75L")).toMatchObject({ text: "1.75L", ml: 1750, assumed: false });
    expect(inferBottleSize("JAMESON IRISH WHISKEY 1L")).toMatchObject({ text: "1L", ml: 1000, assumed: false });
    expect(inferBottleSize("BEEFEATER GIN 750ML")).toMatchObject({ text: "750ML", ml: 750, assumed: false });
    expect(inferBottleSize("Jose Cuervo Especial G 750")).toMatchObject({ text: "750ML", assumed: false });
    expect(inferBottleSize("FIREBALL 50ML NIPS")).toMatchObject({ text: "50ML", ml: 50 });
    expect(inferBottleSize("MR BOSTON TRIPLE SEC 375ML")).toMatchObject({ text: "375ML", ml: 375 });
  });
  it("handles beer multipacks and single cans", () => {
    expect(inferBottleSize("BUD LIGHT 12PK 12OZ CANS")).toMatchObject({ text: "12/12OZ", assumed: false });
    expect(inferBottleSize("SWITCHBACK ALE 6 PK 12 OZ")).toMatchObject({ text: "6/12OZ" });
    expect(inferBottleSize("HEADY TOPPER 16OZ CAN")).toMatchObject({ text: "16OZ", assumed: false });
  });
  it("defaults to 750 ml, flagged as assumed, when nothing is printed", () => {
    expect(inferBottleSize("Baileys Original Irish Cream")).toEqual({ text: "750ML", ml: 750, assumed: true });
    expect(inferBottleSize("")).toEqual({ text: "750ML", ml: 750, assumed: true });
  });
});
