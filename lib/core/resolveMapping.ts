import Decimal from "decimal.js";
import type { Tables } from "@/lib/db/types";
import { parsePackSize, type PackParse } from "./packs";
import { fixed4, fixed6, isUom, type Uom } from "./units";

/**
 * Map-job step 1–4 as a pure function (architecture.md §4.3). No I/O: the job
 * loads the vendor's mappings and the tenant's inventory, optionally asks the
 * LLM, and hands everything here. Precedence, highest first:
 *
 *   1. (vendor_id, vendor_sku) mapping        → auto_mapped, mapping's pack numbers
 *   2. (vendor_id, description_norm) mapping  → auto_mapped, mapping's pack numbers
 *   3. fee / deposit / tax / discount line    → ignored
 *   4. LLM sku-match: not_inventory → ignored; existing ≥ 0.92 → auto_mapped with a
 *      proposed (unconfirmed) mapping; otherwise unmapped with proposals
 *
 * The owner's edit (a mapping row) beats a parsed pack size, which beats a
 * default, which beats the LLM's guess (CLAUDE.md rule 4).
 */

export type SkuMatch = {
  choice: "existing" | "new" | "not_inventory";
  inventory_item_id?: string | null;
  new_item?: { name: string; category: string; base_unit: Uom } | null;
  pack: { units_per_pack: number; base_units_per_unit: number | null };
  brand?: string | null;
  pack_description?: string | null;
  confidence: number;
  reason: string;
};

export type MappingRef = Pick<
  Tables<"vendor_item_mappings">,
  "id" | "vendor_id" | "vendor_sku" | "description_norm" | "inventory_item_id" | "units_per_pack" | "base_units_per_unit" | "confirmed_at"
>;

export type InventoryRef = { id: string; name: string; base_unit: Uom; pack_to_base_factor: number | null };

export type LineInput = {
  id: string;
  vendor_sku: string | null;
  description: string;
  pack_size_text: string | null;
  quantity: string;
  unit_price: string | null;
  extended_price: string | null;
  ai_category_guess: string | null;
};

export type Resolution = {
  status: "auto_mapped" | "unmapped" | "ignored";
  mapping_id: string | null;
  inventory_item_id: string | null;
  units_per_pack: string | null;
  base_units_per_unit: string | null;
  quantity_base_unit: string | null;
  cost_per_base_unit: string | null;
  pack_source: "mapping" | "parsed" | "default" | "llm" | "unknown";
  assumed_text: string | null;
  proposed_new_item?: { name: string; category: string; base_unit: Uom } | null;
  proposed_mapping?: {
    vendor_sku: string | null;
    description_norm: string;
    units_per_pack: string;
    base_units_per_unit: string;
    brand: string | null;
    pack_description: string | null;
  } | null;
  reason: string;
};

export const AUTO_MAP_CONFIDENCE = 0.92;

/** Categories the parser assigns to non-inventory lines. */
export const NON_INVENTORY_CATEGORIES: ReadonlySet<string> = new Set(["fee", "deposit", "tax", "discount", "adjustment", "delivery", "fuel_surcharge"]);

/** lowercase, collapse whitespace, strip punctuation except / # . */
export function normalizeDescription(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s/#.]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeSku(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  return t ? t.toUpperCase() : null;
}

function dec(s: string | null | undefined): Decimal | null {
  if (s == null || s === "") return null;
  try {
    const d = new Decimal(s);
    return d.isNaN() ? null : d;
  } catch {
    return null;
  }
}

/**
 * quantity_base_unit = |quantity| × units_per_pack × base_units_per_unit,
 * negative for credits (either flagged or already stored as a negative quantity).
 * cost_per_base_unit = |extended_price| / |quantity_base_unit|, null when missing or zero.
 */
export function computeLineTotals(
  line: Pick<LineInput, "quantity" | "extended_price">,
  unitsPerPack: Decimal,
  baseUnitsPerUnit: Decimal,
  isCredit: boolean,
): { quantity_base_unit: string; cost_per_base_unit: string | null } {
  const qty = dec(line.quantity) ?? new Decimal(0);
  const negative = isCredit || qty.isNegative();
  const qbu = qty.abs().times(unitsPerPack).times(baseUnitsPerUnit);
  const ext = dec(line.extended_price);
  const cost = ext && !qbu.isZero() ? ext.abs().div(qbu) : null;
  return {
    quantity_base_unit: fixed4(negative ? qbu.negated() : qbu),
    cost_per_base_unit: cost ? fixed6(cost) : null,
  };
}

function fromMapping(line: LineInput, m: MappingRef, isCredit: boolean, how: "sku" | "description"): Resolution {
  const upp = new Decimal(m.units_per_pack);
  const bupu = new Decimal(m.base_units_per_unit);
  const totals = computeLineTotals(line, upp, bupu, isCredit);
  return {
    status: "auto_mapped",
    mapping_id: m.id,
    inventory_item_id: m.inventory_item_id,
    units_per_pack: fixed4(upp),
    base_units_per_unit: fixed4(bupu),
    ...totals,
    pack_source: "mapping",
    assumed_text: `${upp.toString()} × ${bupu.toString()} per pack (${m.confirmed_at ? "confirmed mapping" : "saved mapping"})`,
    reason: how === "sku" ? `vendor SKU ${m.vendor_sku} has a ${m.confirmed_at ? "confirmed" : "saved"} mapping` : `description matched a ${m.confirmed_at ? "confirmed" : "saved"} mapping`,
  };
}

function ignored(reason: string): Resolution {
  return {
    status: "ignored",
    mapping_id: null,
    inventory_item_id: null,
    units_per_pack: null,
    base_units_per_unit: null,
    quantity_base_unit: null,
    cost_per_base_unit: null,
    pack_source: "unknown",
    assumed_text: null,
    reason,
  };
}

function unmapped(reason: string, extra: Partial<Resolution> = {}): Resolution {
  return {
    status: "unmapped",
    mapping_id: null,
    inventory_item_id: null,
    units_per_pack: null,
    base_units_per_unit: null,
    quantity_base_unit: null,
    cost_per_base_unit: null,
    pack_source: "unknown",
    assumed_text: null,
    reason,
    ...extra,
  };
}

/**
 * Pick the pack numbers for a line against a target base unit:
 * parsed text > default > LLM guess > unknown.
 */
export function choosePack(
  packText: string | null,
  baseUnit: Uom,
  llm: SkuMatch["pack"] | null | undefined,
): { units_per_pack: Decimal; base_units_per_unit: Decimal | null; source: Resolution["pack_source"]; assumed_text: string; parse: PackParse } {
  const parse = parsePackSize(packText, baseUnit);
  if (parse.base_units_per_unit && (parse.source === "parsed" || parse.source === "default")) {
    return {
      units_per_pack: new Decimal(parse.units_per_pack),
      base_units_per_unit: new Decimal(parse.base_units_per_unit),
      source: parse.source,
      assumed_text: parse.assumed_text,
      parse,
    };
  }
  if (llm && llm.base_units_per_unit != null && llm.base_units_per_unit > 0 && llm.units_per_pack > 0) {
    return {
      units_per_pack: new Decimal(llm.units_per_pack),
      base_units_per_unit: new Decimal(llm.base_units_per_unit),
      source: "llm",
      assumed_text: `${llm.units_per_pack} × ${llm.base_units_per_unit} ${baseUnit} (AI guess — check)`,
      parse,
    };
  }
  return {
    units_per_pack: new Decimal(parse.units_per_pack || "1"),
    base_units_per_unit: null,
    source: "unknown",
    assumed_text: parse.assumed_text,
    parse,
  };
}

export function resolveLine(input: {
  line: LineInput;
  vendorId: string;
  mappings: MappingRef[];
  inventory: InventoryRef[];
  skuMatch?: SkuMatch | null;
  isCredit?: boolean;
}): Resolution {
  const { line, vendorId, mappings, inventory } = input;
  const isCredit = Boolean(input.isCredit);
  const sku = normalizeSku(line.vendor_sku);
  const descNorm = normalizeDescription(line.description);

  // 1. exact vendor SKU
  if (sku) {
    const m = mappings.find((x) => x.vendor_id === vendorId && normalizeSku(x.vendor_sku) === sku);
    if (m) return fromMapping(line, m, isCredit, "sku");
  }
  // 2. normalized description
  if (descNorm) {
    const m = mappings.find((x) => x.vendor_id === vendorId && x.description_norm === descNorm);
    if (m) return fromMapping(line, m, isCredit, "description");
  }
  // 3. fee / deposit / tax
  const cat = (line.ai_category_guess ?? "").trim().toLowerCase();
  if (cat && NON_INVENTORY_CATEGORIES.has(cat)) return ignored(`${cat} line — not inventory`);

  // 4. LLM
  const sm = input.skuMatch;
  if (!sm) return unmapped("no saved mapping for this vendor SKU / description; needs review");
  if (sm.choice === "not_inventory") return ignored(`not inventory: ${sm.reason}`);

  if (sm.choice === "existing" && sm.inventory_item_id) {
    const item = inventory.find((i) => i.id === sm.inventory_item_id);
    if (!item) return unmapped(`AI picked an inventory item that does not exist (${sm.inventory_item_id})`);
    const pack = choosePack(line.pack_size_text, item.base_unit, sm.pack);
    const proposed_mapping =
      pack.base_units_per_unit
        ? {
            vendor_sku: sku,
            description_norm: descNorm,
            units_per_pack: fixed4(pack.units_per_pack),
            base_units_per_unit: fixed4(pack.base_units_per_unit),
            brand: sm.brand ?? null,
            pack_description: sm.pack_description ?? line.pack_size_text ?? null,
          }
        : null;
    if (sm.confidence >= AUTO_MAP_CONFIDENCE && proposed_mapping && pack.base_units_per_unit) {
      const totals = computeLineTotals(line, pack.units_per_pack, pack.base_units_per_unit, isCredit);
      return {
        status: "auto_mapped",
        mapping_id: null,
        inventory_item_id: item.id,
        units_per_pack: proposed_mapping.units_per_pack,
        base_units_per_unit: proposed_mapping.base_units_per_unit,
        ...totals,
        pack_source: pack.source,
        assumed_text: pack.assumed_text,
        proposed_mapping,
        reason: `AI matched "${item.name}" (${sm.confidence.toFixed(2)}): ${sm.reason}`,
      };
    }
    return unmapped(
      sm.confidence < AUTO_MAP_CONFIDENCE
        ? `AI suggests "${item.name}" at ${sm.confidence.toFixed(2)} — below ${AUTO_MAP_CONFIDENCE}; confirm`
        : `AI matched "${item.name}" but the pack size is unknown (${pack.assumed_text}); set it`,
      {
        inventory_item_id: item.id,
        units_per_pack: fixed4(pack.units_per_pack),
        base_units_per_unit: pack.base_units_per_unit ? fixed4(pack.base_units_per_unit) : null,
        pack_source: pack.source,
        assumed_text: pack.assumed_text,
        proposed_mapping,
      },
    );
  }

  // 'new' (or 'existing' without an id)
  const newItem = sm.new_item && isUom(sm.new_item.base_unit) ? sm.new_item : null;
  const baseUnit: Uom = newItem?.base_unit ?? "each";
  const pack = choosePack(line.pack_size_text, baseUnit, sm.pack);
  return unmapped(newItem ? `AI proposes a new item "${newItem.name}" (${newItem.base_unit}): ${sm.reason}` : `AI could not match: ${sm.reason}`, {
    units_per_pack: fixed4(pack.units_per_pack),
    base_units_per_unit: pack.base_units_per_unit ? fixed4(pack.base_units_per_unit) : null,
    pack_source: pack.source,
    assumed_text: pack.assumed_text,
    proposed_new_item: newItem,
    proposed_mapping: pack.base_units_per_unit
      ? {
          vendor_sku: sku,
          description_norm: descNorm,
          units_per_pack: fixed4(pack.units_per_pack),
          base_units_per_unit: fixed4(pack.base_units_per_unit),
          brand: sm.brand ?? null,
          pack_description: sm.pack_description ?? line.pack_size_text ?? null,
        }
      : null,
  });
}
