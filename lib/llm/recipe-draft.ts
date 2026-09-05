import { z } from "zod";
import { getProvider, toToolCallResult, type LlmProvider, type ToolCallResult } from "./provider";
import { Constants, type Enums } from "@/lib/db/types";

/** Inventory categories the drafter may propose for a new item. */
export const INVENTORY_CATEGORIES = [
  "liquor",
  "beer",
  "wine",
  "na_bev",
  "produce",
  "protein",
  "dairy",
  "dry",
  "frozen",
  "paper",
  "other",
] as const;
export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number];

const UOMS = Constants.public.Enums.uom;
const uom = z.enum(UOMS);

export const NewItemSchema = z.object({
  name: z.string().trim().min(1).max(120),
  category: z.enum(INVENTORY_CATEGORIES),
  base_unit: uom,
  pack_to_base_factor: z.number().positive().nullable().optional(),
  pack_description: z.string().trim().max(120).nullable().optional(),
});

export const RecipeComponentDraftSchema = z.object({
  existing_inventory_item_id: z.uuid().nullable().optional(),
  new_item: NewItemSchema.nullable().optional(),
  quantity: z.number().positive(),
  unit: uom,
  confidence: z.number().min(0).max(1),
  note: z.string().trim().max(300).optional(),
});

export const RecipeDraftSchema = z.object({
  components: z.array(RecipeComponentDraftSchema),
  is_composite: z.boolean().optional(),
  overall_confidence: z.number().min(0).max(1),
});

export type RecipeDraft = z.infer<typeof RecipeDraftSchema>;
export type RecipeComponentDraft = z.infer<typeof RecipeComponentDraftSchema>;

export type RecipeDraftInput = {
  /** tenants.concept — one sentence describing the operation; falls back to DEFAULT_CONCEPT */
  concept?: string | null;
  menuItem: { id: string; name: string; category: string | null; price: number | string | null };
  modifierNames: string[];
  inventory: Array<{ id: string; name: string; category: string | null; base_unit: Enums<"uom"> }>;
};

export const RECIPE_DRAFT_TOOL = "draft_recipe";

/** JSON schema handed to Claude as the tool's input_schema (the Claude provider adds `type: object`; OpenAI derives a strict schema from zod). */
export const RECIPE_DRAFT_INPUT_SCHEMA: Record<string, unknown> = {
  properties: {
    components: {
      type: "array",
      description: "One entry per ingredient that leaves inventory when one of this menu item is sold.",
      items: {
        type: "object",
        properties: {
          existing_inventory_item_id: {
            type: ["string", "null"],
            description: "UUID of an item from the provided inventory list. Prefer this over new_item whenever the name matches or nearly matches.",
          },
          new_item: {
            type: ["object", "null"],
            description: "Only when no inventory item fits. A new item the restaurant should stock.",
            properties: {
              name: { type: "string" },
              category: { type: "string", enum: [...INVENTORY_CATEGORIES] },
              base_unit: { type: "string", enum: [...UOMS], description: "Unit usage is reported in (oz for liquor/beer/wine, lb for produce and protein, each for counted goods)." },
              pack_to_base_factor: { type: ["number", "null"], description: "Base units per purchased pack, e.g. 25.36 for a 750ml liquor bottle in oz, 33.81 for 1L, 1984 for a 1/2 bbl keg." },
              pack_description: { type: ["string", "null"], description: "e.g. '750ml bottle', '1/2 bbl keg', '24-ct case'." },
            },
            required: ["name", "category", "base_unit"],
          },
          quantity: { type: "number", exclusiveMinimum: 0, description: "Amount used per one menu item sold, in `unit`." },
          unit: { type: "string", enum: [...UOMS], description: "Unit of `quantity`. Should be the ingredient's base unit whenever possible." },
          confidence: { type: "number", minimum: 0, maximum: 1, description: "Honest confidence that quantity and ingredient are right." },
          note: { type: "string", description: "Short reasoning, e.g. 'standard 1.5 oz pour'." },
        },
        required: ["quantity", "unit", "confidence"],
      },
    },
    is_composite: {
      type: "boolean",
      description: "True when the item is a bundle/combo of other menu items rather than a single recipe.",
    },
    overall_confidence: { type: "number", minimum: 0, maximum: 1 },
  },
  required: ["components", "overall_confidence"],
};

/** Fallback when tenants.concept is null (the original Mad Moose sentence). */
export const DEFAULT_CONCEPT = "a bar & grill in Vermont (burgers, wings, sandwiches, salads, pub entrees, draft and canned beer, wine by the glass, classic cocktails and shots)";

/** System prompt for a tenant; `concept` is tenants.concept (one sentence describing the operation). */
export function recipeDraftSystem(concept: string | null | undefined): string {
  return `You draft ingredient usage for menu items at ${concept?.trim() || DEFAULT_CONCEPT}.` + RECIPE_DRAFT_RULES;
}

const RECIPE_DRAFT_RULES = `

Your job: for one menu item, list the inventory ingredients that leave stock each time one is sold, with a quantity per item sold.

Removal or substitution-out modifiers ("No Gouda", "Hold Onions", "Without Mayo", "Sub out X") consume nothing: return an empty components array with a note saying it is a removal. Never return a component with quantity 0 or a negative quantity.

Standard pours and portions unless the item name says otherwise:
- Spirits: 1.5 oz per cocktail or mixed drink; shots 1.5 oz; doubles 3 oz; martinis/manhattans 2.5-3 oz total spirit.
- Wine by the glass: 5 oz. Draft beer: 16 oz pint (12 oz for high-ABV, 20 oz imperial). Canned/bottled beer: 1 each.
- Cocktail mixers: 0.75-1 oz liqueur, 1 oz fresh juice, 0.5-0.75 oz syrup, 3-4 oz soda/tonic/juice for highballs.
- Burgers: 6-8 oz patty (0.375-0.5 lb ground beef), 1 bun (each), cheese 1 oz, lettuce/tomato/onion small amounts in lb.
- Wings: 1 lb per 10 wings; fries 6-8 oz (0.375-0.5 lb); chicken breast 6-8 oz; steaks 10-14 oz.

Rules:
- Quantities are PER ONE menu item sold, in the ingredient's base unit whenever possible (oz for liquor, beer, wine, sauces; lb for produce, proteins, most dry goods; each for buns, cans, counted items).
- Prefer an existing inventory item when its name matches or nearly matches (e.g. "Tequila - Blanco" for a margarita, "Well Tequila" if that is what exists). Reference it by id and leave new_item null.
- Propose new_item sparingly, only for ingredients that clearly must be stocked and are absent. Use sensible base units and pack sizes: liquor oz with pack_to_base_factor 25.36 (750ml) or 33.81 (1L); draft beer oz with 1984 (1/2 bbl keg) or 661 (1/6 bbl); canned/bottled beer each with 24 (case); wine oz with 25.36 (750ml); produce lb; proteins lb; dry goods lb or each.
- Skip negligible items (salt, ice, garnish picks) unless they are the item itself. Modifier names are hints about what is typically added or substituted; they are not part of the base recipe.
- Bundles/combos (e.g. "Burger + Beer") get is_composite=true and components for each part.
- Be honest with confidence: 0.9 for a textbook pour, 0.5-0.7 for a reasonable portion guess, below 0.4 when you are guessing what the item even is.
- Always call the draft_recipe tool exactly once.`;

/**
 * One Sonnet call, forced tool use, zod-validated. Callers log it with
 * logLlmCall(kind: 'recipe-draft', ref_id: menuItem.id).
 */
export async function draftRecipe(input: RecipeDraftInput, provider: LlmProvider = getProvider()): Promise<ToolCallResult<RecipeDraft>> {
  const payload = {
    menu_item: {
      name: input.menuItem.name,
      category: input.menuItem.category,
      price: input.menuItem.price === null ? null : String(input.menuItem.price),
    },
    modifier_names: input.modifierNames,
    inventory: input.inventory.map((i) => ({ id: i.id, name: i.name, category: i.category, base_unit: i.base_unit })),
  };
  const r = await provider.structured<RecipeDraft>({
    task: "recipe-draft",
    system: recipeDraftSystem(input.concept),
    user: `Draft the recipe for this menu item. Existing inventory is listed with ids; reuse them where they fit.\n\n${JSON.stringify(payload, null, 2)}`,
    schema: RecipeDraftSchema,
    schemaName: RECIPE_DRAFT_TOOL,
    toolSchema: RECIPE_DRAFT_INPUT_SCHEMA,
    toolDescription: "Record the ingredient components and quantities used per one sale of the menu item.",
    maxTokens: 4096,
  });
  return toToolCallResult(r);
}
