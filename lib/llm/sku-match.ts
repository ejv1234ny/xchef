import { z } from "zod";
import { getProvider, toToolCallResult, type LlmProvider, type ToolCallResult } from "./provider";
import { parsePackSize } from "@/lib/core/packs";
import { UOMS, isUom, type Uom } from "@/lib/core/units";
import type { SkuMatch } from "@/lib/core/resolveMapping";

export type { SkuMatch };

/**
 * SKU → inventory item matching (architecture.md §4.3 map job step 3) with
 * Haiku. The caller passes the tenant's inventory list (this build has no
 * pgvector shortlist yet — a single-location catalog fits in the prompt) and
 * gets back: pick an existing item, propose a new one, or "not inventory".
 * The pack size parsed by lib/core/packs.ts is passed as a hint and the model
 * is told to prefer it; resolveMapping applies that precedence regardless.
 */

const UomSchema = z.enum(UOMS as [Uom, ...Uom[]]);

export const SkuMatchSchema: z.ZodType<SkuMatch> = z.object({
  choice: z.enum(["existing", "new", "not_inventory"]),
  inventory_item_id: z.uuid().nullable().optional(),
  new_item: z
    .object({ name: z.string().min(1), category: z.string(), base_unit: UomSchema })
    .nullable()
    .optional(),
  pack: z.object({ units_per_pack: z.number().positive(), base_units_per_unit: z.number().positive().nullable() }),
  brand: z.string().nullable().optional(),
  pack_description: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
  reason: z.string(),
});

export const SKU_MATCH_TOOL_SCHEMA: Record<string, unknown> = {
  properties: {
    choice: { type: "string", enum: ["existing", "new", "not_inventory"] },
    inventory_item_id: { type: ["string", "null"], description: "id of the chosen existing item (uuid), when choice = existing" },
    new_item: {
      type: ["object", "null"],
      description: "when choice = new: the inventory item to create",
      properties: {
        name: { type: "string", description: 'short generic ingredient name, e.g. "Ketchup", "Tequila - Blanco", "Chicken Wings"' },
        category: { type: "string", description: "produce | meat | seafood | dairy | dry | frozen | bakery | beverage | liquor | beer | wine | supplies" },
        base_unit: { type: "string", enum: [...UOMS], description: "unit usage is tracked in: oz for liquids/liquor, lb for bulk food, each for counted items" },
      },
      required: ["name", "category", "base_unit"],
    },
    pack: {
      type: "object",
      description: "how many base units one invoice unit contains",
      properties: {
        units_per_pack: { type: "number", description: "inner units per invoice unit (6 for 6/#10; 1 for a single bag)" },
        base_units_per_unit: { type: ["number", "null"], description: "base units in one inner unit in the item's base_unit (106 for a #10 can in oz; 25.36 for 750 ml in oz); null if unknown" },
      },
      required: ["units_per_pack", "base_units_per_unit"],
    },
    brand: { type: ["string", "null"] },
    pack_description: { type: ["string", "null"], description: 'human form, e.g. "6 × #10 can"' },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    reason: { type: "string" },
  },
  required: ["choice", "pack", "confidence", "reason"],
};

export const SKU_MATCH_SYSTEM = `You map one line from a restaurant supplier invoice to the restaurant's inventory list.

Choose exactly one:
- existing: the line IS one of the listed inventory items (same ingredient; brand or pack format may differ). Give its id.
- new: it is an ingredient or bar/kitchen consumable the restaurant would track, but it is not in the list. Propose a short generic name, category and base unit (oz for liquids and liquor, lb for bulk food sold by weight, each for counted items like limes or eggs, or the pack unit when that is how it is used).
- not_inventory: fees, deposits, delivery/fuel charges, tax, discounts, credits with no product, or non-food supplies the restaurant does not track.

Pack size: you are given the pack size text from the invoice and a parse of it computed by a lookup table. If the parse has a size, USE IT (units_per_pack and base_units_per_unit exactly as parsed). Only supply your own numbers when the parse says size unknown, and then only from knowledge printed in the description (e.g. "PD JALAPENO 5# BAG" is 5 lb; "TULK PESTO 32Z" is 32 oz). If you cannot tell, set base_units_per_unit to null.

Standard sizes to know: #10 can ≈ 106 oz (102–128 by product), #5 can ≈ 56 oz, #300 can ≈ 15 oz, 750 ml = 25.36 oz, 1 L = 33.81 oz, 1.75 L = 59.17 oz, 1 gal = 128 fl oz, sixth-barrel keg ≈ 661 oz, half-barrel keg = 1984 oz. "Z" means oz; "#" after a number means lb.

Prefer an existing item whenever the line is the same product: inventory names may carry qualifiers in parentheses ("Coke (Fountain or Bottle)", "Lemonade (Housemade or Pre-mix)"), a brand spelled differently ("Tito's Handmade Vodka" for "TITOS VODKA 750"), or a pack the line does not mention — a bag-in-box fountain syrup IS the fountain drink. Only choose new when no listed item is the same ingredient.

Confidence ≥ 0.92 only when the match is unambiguous (same ingredient and the units line up). Be strict: "Tequila - Blanco" vs "Tequila - Reposado" are different items.`;

export type SkuMatchInput = {
  line: {
    description: string;
    vendor_sku: string | null;
    pack_size_text: string | null;
    unit_price: string | null;
    extended_price: string | null;
    quantity: string;
    category_guess: string | null;
  };
  vendorName: string;
  inventory: Array<{ id: string; name: string; category: string | null; base_unit: string; pack_to_base_factor: number | null }>;
};

const MAX_INVENTORY_IN_PROMPT = 400;

export function buildSkuMatchPrompt(input: SkuMatchInput): string {
  const { line } = input;
  const inventory = input.inventory.slice(0, MAX_INVENTORY_IN_PROMPT);
  const hints = inventory.map((i) => {
    const bu = isUom(i.base_unit) ? i.base_unit : "each";
    const p = parsePackSize(line.pack_size_text, bu);
    return `${i.id}\t${i.name}\t${i.category ?? ""}\t${bu}\tpack parse for this base unit: ${p.base_units_per_unit ? `${p.units_per_pack} × ${p.base_units_per_unit} ${bu} (${p.source})` : `unknown (${p.assumed_text})`}`;
  });
  return [
    `Vendor: ${input.vendorName}`,
    `Invoice line:`,
    `  description: ${line.description}`,
    `  vendor_sku: ${line.vendor_sku ?? "(none)"}`,
    `  pack_size_text: ${line.pack_size_text ?? "(none)"}`,
    `  quantity: ${line.quantity}  unit_price: ${line.unit_price ?? "?"}  extended_price: ${line.extended_price ?? "?"}`,
    `  parser's category guess: ${line.category_guess ?? "(none)"}`,
    ``,
    `Inventory items (id, name, category, base_unit, pack parse):`,
    ...(hints.length ? hints : ["(the inventory list is empty — choose new or not_inventory)"]),
    input.inventory.length > MAX_INVENTORY_IN_PROMPT ? `(list truncated to ${MAX_INVENTORY_IN_PROMPT} items)` : "",
    ``,
    `Call match_sku.`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

/** Match one line (gpt-4.1-mini by default). The caller logs the call (kind 'sku-match', ref_id = line id) including on error. */
export async function matchSku(input: SkuMatchInput, provider: LlmProvider = getProvider()): Promise<ToolCallResult<SkuMatch>> {
  const r = await provider.structured<SkuMatch>({
    task: "sku-match",
    system: SKU_MATCH_SYSTEM,
    user: buildSkuMatchPrompt(input),
    schema: SkuMatchSchema,
    schemaName: "match_sku",
    toolSchema: SKU_MATCH_TOOL_SCHEMA,
    toolDescription: "Map an invoice line to an inventory item (existing, new, or not inventory) and give its pack size.",
    maxTokens: 1024,
  });
  return toToolCallResult(r);
}
