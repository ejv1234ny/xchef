import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { computeLineTotals, normalizeDescription, resolveLine, type InventoryRef, type LineInput, type MappingRef, type SkuMatch } from "./resolveMapping";

const SYSCO = "vendor-sysco";
const RD = "vendor-rd";
const KETCHUP = "item-ketchup";
const TOMATO = "item-tomato";

const inventory: InventoryRef[] = [
  { id: KETCHUP, name: "Ketchup", base_unit: "oz", pack_to_base_factor: 106 },
  { id: TOMATO, name: "Tomatoes", base_unit: "lb", pack_to_base_factor: 25 },
];

const line = (over: Partial<LineInput>): LineInput => ({
  id: "line-1",
  vendor_sku: null,
  description: "X",
  pack_size_text: null,
  quantity: "1",
  unit_price: null,
  extended_price: null,
  ai_category_guess: null,
  ...over,
});

const match = (over: Partial<SkuMatch>): SkuMatch => ({
  choice: "existing",
  inventory_item_id: KETCHUP,
  pack: { units_per_pack: 1, base_units_per_unit: null },
  confidence: 0.97,
  reason: "same product",
  ...over,
});

const num = (s: string | null) => new Decimal(s ?? "NaN").toNumber();

describe("resolveLine — (a) ketchup from two vendors normalizes to cost per oz", () => {
  const sysco = resolveLine({
    line: line({ vendor_sku: "1234567", description: "KETCHUP 6/#10", pack_size_text: "6/#10", quantity: "1", unit_price: "62.50", extended_price: "62.50" }),
    vendorId: SYSCO,
    mappings: [],
    inventory,
    skuMatch: match({}),
  });
  const rd = resolveLine({
    line: line({ vendor_sku: "760695", description: "KETCHUP 3/114OZ", pack_size_text: "3/114OZ", quantity: "1", unit_price: "67.19", extended_price: "67.19" }),
    vendorId: RD,
    mappings: [],
    inventory,
    skuMatch: match({}),
  });

  it("both auto-map to Ketchup with a proposed mapping", () => {
    expect(sysco.status).toBe("auto_mapped");
    expect(rd.status).toBe("auto_mapped");
    expect(sysco.inventory_item_id).toBe(KETCHUP);
    expect(sysco.proposed_mapping?.units_per_pack).toBe("6.0000");
    expect(sysco.proposed_mapping?.base_units_per_unit).toBe("106.0000");
    expect(rd.proposed_mapping?.units_per_pack).toBe("3.0000");
    expect(rd.proposed_mapping?.base_units_per_unit).toBe("114.0000");
  });
  it("cost per oz: ≈ 0.0983 (6 × 106) vs ≈ 0.1965 (3 × 114); Sysco is about half", () => {
    expect(sysco.quantity_base_unit).toBe("636.0000");
    expect(rd.quantity_base_unit).toBe("342.0000");
    expect(sysco.cost_per_base_unit).toBe("0.098270");
    expect(rd.cost_per_base_unit).toBe("0.196462");
    // 62.50/636 = 0.09827 vs 67.19/342 = 0.19646: the cans are ~half the price per oz
    // whether a #10 is taken as 106 or 128 oz (at exactly 106 the ratio is 0.5002).
    expect(num(sysco.cost_per_base_unit)).toBeLessThan(num(rd.cost_per_base_unit) * 0.51);
    expect(num(sysco.cost_per_base_unit)).toBeGreaterThan(num(rd.cost_per_base_unit) * 0.49);
  });
  it("the #10 case carries assumed_text with the range; the parsed size does not", () => {
    expect(sysco.pack_source).toBe("default");
    expect(sysco.assumed_text).toContain("#10");
    expect(sysco.assumed_text).toContain("102–128");
    expect(rd.pack_source).toBe("parsed");
    expect(rd.assumed_text).not.toContain("assumed");
  });
});

describe("resolveLine — (b) price change doubles cost_per_base_unit exactly", () => {
  const mapping: MappingRef = {
    id: "map-tom",
    vendor_id: RD,
    vendor_sku: "TOM25",
    description_norm: normalizeDescription("TOMATOES 5X6 25 LB"),
    inventory_item_id: TOMATO,
    units_per_pack: 1,
    base_units_per_unit: 25,
    confirmed_at: "2026-08-01T00:00:00Z",
  };
  const at = (price: string) =>
    resolveLine({
      line: line({ vendor_sku: "TOM25", description: "TOMATOES 5X6 25 LB", pack_size_text: "25 LB", quantity: "1", unit_price: price, extended_price: price }),
      vendorId: RD,
      mappings: [mapping],
      inventory,
    });
  it("$28 → 1.1200/lb, $56 → 2.2400/lb", () => {
    const a = at("28.00");
    const b = at("56.00");
    expect(a.status).toBe("auto_mapped");
    expect(a.pack_source).toBe("mapping");
    expect(a.mapping_id).toBe("map-tom");
    expect(a.quantity_base_unit).toBe("25.0000");
    expect(a.cost_per_base_unit).toBe("1.120000");
    expect(b.cost_per_base_unit).toBe("2.240000");
    expect(new Decimal(b.cost_per_base_unit!).div(a.cost_per_base_unit!).toString()).toBe("2");
  });
});

describe("resolveLine — (c) SKU mapping beats description mapping", () => {
  const bySku: MappingRef = {
    id: "map-sku",
    vendor_id: SYSCO,
    vendor_sku: "111",
    description_norm: "something else",
    inventory_item_id: KETCHUP,
    units_per_pack: 6,
    base_units_per_unit: 106,
    confirmed_at: null,
  };
  const byDesc: MappingRef = {
    id: "map-desc",
    vendor_id: SYSCO,
    vendor_sku: null,
    description_norm: normalizeDescription("Ketchup 6/#10"),
    inventory_item_id: TOMATO,
    units_per_pack: 1,
    base_units_per_unit: 25,
    confirmed_at: "2026-08-01T00:00:00Z",
  };
  it("uses the SKU mapping even when a description mapping also matches", () => {
    const r = resolveLine({
      line: line({ vendor_sku: "111", description: "Ketchup 6/#10", extended_price: "62.50" }),
      vendorId: SYSCO,
      mappings: [byDesc, bySku],
      inventory,
    });
    expect(r.mapping_id).toBe("map-sku");
    expect(r.inventory_item_id).toBe(KETCHUP);
  });
  it("falls back to the description mapping when the SKU is unknown", () => {
    const r = resolveLine({
      line: line({ vendor_sku: "999", description: "KETCHUP  6/#10!", extended_price: "62.50" }),
      vendorId: SYSCO,
      mappings: [byDesc, bySku],
      inventory,
    });
    expect(r.mapping_id).toBe("map-desc");
  });
  it("a mapping for another vendor never matches", () => {
    const r = resolveLine({ line: line({ vendor_sku: "111", description: "Ketchup 6/#10" }), vendorId: RD, mappings: [bySku], inventory });
    expect(r.status).toBe("unmapped");
  });
  it("the mapping's pack numbers beat the parsed text (owner's edit wins)", () => {
    const r = resolveLine({
      line: line({ vendor_sku: "111", description: "Ketchup 6/#10", pack_size_text: "6/128OZ", quantity: "2", extended_price: "125.00" }),
      vendorId: SYSCO,
      mappings: [bySku],
      inventory,
    });
    expect(r.base_units_per_unit).toBe("106.0000");
    expect(r.quantity_base_unit).toBe("1272.0000");
  });
});

describe("resolveLine — (d) fee lines are ignored", () => {
  it("fee / deposit / tax category → ignored with no quantities", () => {
    for (const cat of ["fee", "deposit", "tax"]) {
      const r = resolveLine({ line: line({ description: "FUEL SURCHARGE", ai_category_guess: cat, extended_price: "5.00" }), vendorId: SYSCO, mappings: [], inventory });
      expect(r.status).toBe("ignored");
      expect(r.quantity_base_unit).toBeNull();
      expect(r.cost_per_base_unit).toBeNull();
    }
  });
  it("LLM not_inventory → ignored", () => {
    const r = resolveLine({
      line: line({ description: "BOTTLE DEPOSIT" }),
      vendorId: SYSCO,
      mappings: [],
      inventory,
      skuMatch: match({ choice: "not_inventory", inventory_item_id: null, reason: "deposit" }),
    });
    expect(r.status).toBe("ignored");
  });
});

describe("resolveLine — (e) credit memos", () => {
  const mapping: MappingRef = {
    id: "map-k",
    vendor_id: SYSCO,
    vendor_sku: "K1",
    description_norm: "ketchup",
    inventory_item_id: KETCHUP,
    units_per_pack: 6,
    base_units_per_unit: 106,
    confirmed_at: null,
  };
  it("isCredit negates quantity_base_unit and keeps cost positive", () => {
    const r = resolveLine({
      line: line({ vendor_sku: "K1", description: "Ketchup", quantity: "1", extended_price: "62.50" }),
      vendorId: SYSCO,
      mappings: [mapping],
      inventory,
      isCredit: true,
    });
    expect(r.quantity_base_unit).toBe("-636.0000");
    expect(num(r.cost_per_base_unit)).toBeCloseTo(0.0983, 4);
  });
  it("a quantity already stored negative (parse job negates credits) is not double-negated", () => {
    const r = resolveLine({
      line: line({ vendor_sku: "K1", description: "Ketchup", quantity: "-1", extended_price: "-62.50" }),
      vendorId: SYSCO,
      mappings: [mapping],
      inventory,
      isCredit: true,
    });
    expect(r.quantity_base_unit).toBe("-636.0000");
    expect(r.cost_per_base_unit).toBe("0.098270");
  });
});

describe("resolveLine — LLM thresholds and proposals", () => {
  it("existing below 0.92 → unmapped with the proposal attached (a branded description the name rule cannot confirm)", () => {
    const r = resolveLine({
      line: line({ vendor_sku: "S1", description: "HEINZ TOMATO KETCHUP 6/#10", pack_size_text: "6/#10", extended_price: "60" }),
      vendorId: SYSCO,
      mappings: [],
      inventory,
      skuMatch: match({ confidence: 0.8 }),
    });
    expect(r.status).toBe("unmapped");
    expect(r.inventory_item_id).toBe(KETCHUP);
    expect(r.proposed_mapping?.base_units_per_unit).toBe("106.0000");
    expect(r.quantity_base_unit).toBeNull();
  });
  it("new item → unmapped with proposed_new_item and pack from the text", () => {
    const r = resolveLine({
      line: line({ vendor_sku: "S2", description: "TEQUILA BLANCO 12/750ML", pack_size_text: "12/750ML" }),
      vendorId: SYSCO,
      mappings: [],
      inventory,
      skuMatch: match({ choice: "new", inventory_item_id: null, new_item: { name: "Tequila - Blanco", category: "liquor", base_unit: "oz" }, pack: { units_per_pack: 12, base_units_per_unit: 25 } }),
    });
    expect(r.status).toBe("unmapped");
    expect(r.proposed_new_item?.name).toBe("Tequila - Blanco");
    expect(r.pack_source).toBe("parsed");
    expect(r.proposed_mapping?.base_units_per_unit).toBe("25.3605");
  });
  it("parsed size beats the LLM pack; LLM pack is used only when the text is unreadable", () => {
    const parsed = resolveLine({
      line: line({ description: "K", pack_size_text: "3/114OZ", extended_price: "67.19" }),
      vendorId: RD,
      mappings: [],
      inventory,
      skuMatch: match({ pack: { units_per_pack: 3, base_units_per_unit: 100 } }),
    });
    expect(parsed.base_units_per_unit).toBe("114.0000");
    expect(parsed.pack_source).toBe("parsed");
    const llm = resolveLine({
      line: line({ description: "K", pack_size_text: "CS", extended_price: "67.19" }),
      vendorId: RD,
      mappings: [],
      inventory,
      skuMatch: match({ pack: { units_per_pack: 3, base_units_per_unit: 100 } }),
    });
    expect(llm.base_units_per_unit).toBe("100.0000");
    expect(llm.pack_source).toBe("llm");
    expect(llm.assumed_text).toContain("AI guess");
  });
  it("no skuMatch and no mapping → unmapped", () => {
    const r = resolveLine({ line: line({ description: "MYSTERY" }), vendorId: SYSCO, mappings: [], inventory });
    expect(r.status).toBe("unmapped");
    expect(r.proposed_mapping ?? null).toBeNull();
  });
});

describe("helpers", () => {
  it("normalizeDescription keeps / # . and collapses whitespace", () => {
    expect(normalizeDescription("  KETCHUP,  Fancy 6/#10 (Heinz) 1.5L ")).toBe("ketchup fancy 6/#10 heinz 1.5l");
  });
  it("computeLineTotals returns null cost when price or quantity is missing", () => {
    expect(computeLineTotals({ quantity: "0", extended_price: "10" }, new Decimal(1), new Decimal(1), false).cost_per_base_unit).toBeNull();
    expect(computeLineTotals({ quantity: "2", extended_price: null }, new Decimal(1), new Decimal(1), false)).toEqual({ quantity_base_unit: "2.0000", cost_per_base_unit: null });
  });
});

describe("resolveLine — name match: draft-born items win over duplicates (KICKOFF-3 item 3)", () => {
  const TITOS = "item-titos";
  const WELL = "item-well-vodka";
  const COKE = "item-coke";
  const DIET = "item-diet-coke";
  const catalog: InventoryRef[] = [
    ...inventory,
    { id: TITOS, name: "Tito's Handmade Vodka", base_unit: "oz", pack_to_base_factor: 25.36 },
    { id: WELL, name: "Vodka - Well", base_unit: "oz", pack_to_base_factor: 33.81 },
    { id: COKE, name: "Coke (Fountain or Bottle)", base_unit: "oz", pack_to_base_factor: null },
    { id: DIET, name: "Diet Coke (Fountain or Bottle)", base_unit: "oz", pack_to_base_factor: null },
  ];

  it("TITOS VODKA 750 with the model proposing a NEW Tito's Vodka maps to the existing draft-born item", () => {
    const r = resolveLine({
      line: line({ vendor_sku: "88021", description: "TITOS VODKA 750", pack_size_text: "750ML", quantity: "6", unit_price: "21.99", extended_price: "131.94" }),
      vendorId: "vendor-802",
      mappings: [],
      inventory: catalog,
      skuMatch: match({ choice: "new", inventory_item_id: null, new_item: { name: "Tito's Vodka", category: "liquor", base_unit: "oz" }, confidence: 0.9, reason: "not in list" }),
    });
    expect(r.status).toBe("auto_mapped");
    expect(r.inventory_item_id).toBe(TITOS);
    expect(r.proposed_new_item ?? null).toBeNull();
    expect(r.proposed_mapping?.base_units_per_unit).toBe("25.3605");
    expect(num(r.quantity_base_unit)).toBeCloseTo(6 * 25.3605, 3);
    expect(r.reason).toContain("by name");
  });

  it("the same line with no model verdict maps deterministically when the pack is readable (no LLM call needed)", () => {
    const r = resolveLine({ line: line({ description: "TITOS VODKA 750", pack_size_text: "750ML", quantity: "1", extended_price: "21.99" }), vendorId: "vendor-802", mappings: [], inventory: catalog });
    expect(r.status).toBe("auto_mapped");
    expect(r.inventory_item_id).toBe(TITOS);
    expect(r.pack_source).toBe("parsed");
  });

  it("a hesitant existing verdict is confirmed by the name; Diet Coke never lands on Coke", () => {
    const hesitant = resolveLine({
      line: line({ description: "2.5GBIB DT COKE", pack_size_text: "2.5 GAL BIB", quantity: "1", extended_price: "66.80" }),
      vendorId: "vendor-coke",
      mappings: [],
      inventory: catalog,
      skuMatch: match({ choice: "existing", inventory_item_id: COKE, confidence: 0.7, reason: "probably coke" }),
    });
    expect(hesitant.status).toBe("auto_mapped");
    expect(hesitant.inventory_item_id).toBe(DIET);
    expect(hesitant.pack_source).toBe("default");
    expect(num(hesitant.cost_per_base_unit)).toBeCloseTo(66.8 / 320, 5);
  });

  it("a bare generic word does not claim a branded item — falls through to the model", () => {
    const r = resolveLine({ line: line({ description: "VODKA 1.75L", pack_size_text: "1.75L", quantity: "1" }), vendorId: "vendor-802", mappings: [], inventory: catalog });
    expect(r.status).toBe("unmapped");
  });
});

describe("resolveLine — beverage distributor tickets (KICKOFF-3 item 2)", () => {
  const COKE = "item-coke";
  const catalog: InventoryRef[] = [...inventory, { id: COKE, name: "Coke (Fountain or Bottle)", base_unit: "oz", pack_to_base_factor: null }];
  it("a 2.5 gal bag-in-box maps to the fountain item at 320 fl oz per box (default, shown as assumed)", () => {
    const r = resolveLine({ line: line({ vendor_sku: "103886", description: "2.5GBIB COKE", pack_size_text: "2.5 GAL BIB", quantity: "2", unit_price: "66.80", extended_price: "133.60" }), vendorId: "vendor-coke", mappings: [], inventory: catalog, vendorKind: "beverage_distributor" });
    expect(r.status).toBe("auto_mapped");
    expect(r.inventory_item_id).toBe(COKE);
    expect(r.base_units_per_unit).toBe("320.0000");
    expect(num(r.quantity_base_unit)).toBe(640);
    expect(num(r.cost_per_base_unit)).toBeCloseTo(133.6 / 640, 6);
    expect(r.assumed_text).toContain("assumed");
  });
  it("an unreadable product name with the parser's [TEA] family hint lands on the stocked iced tea, not a new item", () => {
    const TEA = "item-tea";
    const r = resolveLine({
      line: line({ vendor_sku: "132765", description: "2.5GBIB GP PRE-LMND T [TEA]", pack_size_text: "2.5 GAL BIB", quantity: "1", extended_price: "66.80" }),
      vendorId: "vendor-coke",
      mappings: [],
      inventory: [...catalog, { id: TEA, name: "Iced Tea (Housemade or Pre-mix)", base_unit: "oz", pack_to_base_factor: 128 }],
      skuMatch: match({ choice: "new", inventory_item_id: null, new_item: { name: "Green Tea Pre-mix BIB", category: "beverage", base_unit: "oz" }, confidence: 0.9, reason: "not in list" }),
      vendorKind: "beverage_distributor",
    });
    expect(r.status).toBe("auto_mapped");
    expect(r.inventory_item_id).toBe(TEA);
  });
  it("CO2 cylinders on a beverage ticket are ignored as gas, not inventory; on other vendors they still go to the model", () => {
    const l = line({ vendor_sku: "104631", description: "20#CYL CO2 FULL #1", pack_size_text: null, quantity: "1", unit_price: "80", extended_price: "80", ai_category_guess: "beverage" });
    expect(resolveLine({ line: l, vendorId: "vendor-coke", mappings: [], inventory: catalog, vendorKind: "beverage_distributor" }).status).toBe("ignored");
    expect(resolveLine({ line: l, vendorId: "vendor-rd", mappings: [], inventory: catalog, vendorKind: "distributor" }).status).toBe("unmapped");
  });
});
