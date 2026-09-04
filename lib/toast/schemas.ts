import { z } from "zod";

/**
 * Zod schemas for the subset of Toast's Orders API (GET /orders/v2/ordersBulk)
 * that flattening needs. Everything is loose: unknown fields pass through and
 * are kept in toast_orders_raw.payload untouched. Only the fields the rollup
 * depends on are typed and validated.
 */

const guidRef = z.looseObject({ guid: z.string() });

export interface ToastSelection {
  guid: string;
  item?: { guid: string } | null;
  displayName?: string | null;
  quantity: number;
  voided?: boolean | null;
  price?: number | null;
  preDiscountPrice?: number | null;
  unitOfMeasure?: string | null;
  selectionType?: string | null;
  modifiers?: ToastSelection[] | null;
  [key: string]: unknown;
}

export const SelectionSchema: z.ZodType<ToastSelection> = z.looseObject({
  guid: z.string(),
  item: guidRef.nullish(),
  displayName: z.string().nullish(),
  quantity: z.number(),
  voided: z.boolean().nullish(),
  price: z.number().nullish(),
  preDiscountPrice: z.number().nullish(),
  unitOfMeasure: z.string().nullish(),
  selectionType: z.string().nullish(),
  get modifiers() {
    return z.array(SelectionSchema).nullish();
  },
}) as unknown as z.ZodType<ToastSelection>;

export const CheckSchema = z.looseObject({
  guid: z.string(),
  deleted: z.boolean().nullish(),
  voided: z.boolean().nullish(),
  amount: z.number().nullish(),
  totalAmount: z.number().nullish(),
  selections: z.array(SelectionSchema).nullish(),
});

export const OrderSchema = z.looseObject({
  guid: z.string(),
  // Toast returns businessDate as an integer yyyyMMdd (e.g. 20260903).
  businessDate: z.union([z.number().int(), z.string()]),
  openedDate: z.string().nullish(),
  closedDate: z.string().nullish(),
  modifiedDate: z.string(),
  deleted: z.boolean().nullish(),
  voided: z.boolean().nullish(),
  checks: z.array(CheckSchema).nullish(),
});

export type ToastOrder = z.infer<typeof OrderSchema>;
export type ToastCheck = z.infer<typeof CheckSchema>;

export const OrdersPageSchema = z.array(z.unknown());

export const TokenResponseSchema = z.looseObject({
  token: z.looseObject({
    accessToken: z.string(),
    expiresIn: z.number(),
  }),
});

// ---- Menus v2 -------------------------------------------------------------

export const MenusMetadataSchema = z.looseObject({
  restaurantGuid: z.string().nullish(),
  lastUpdated: z.string(),
});

export interface ToastModifierOption {
  guid: string;
  name: string;
  price?: number | null;
  [key: string]: unknown;
}

export const ModifierOptionSchema: z.ZodType<ToastModifierOption> = z.looseObject({
  guid: z.string(),
  name: z.string(),
  price: z.number().nullish(),
}) as unknown as z.ZodType<ToastModifierOption>;

export const ModifierGroupSchema = z.looseObject({
  guid: z.string(),
  name: z.string().nullish(),
  modifierOptionReferences: z.array(z.number()).nullish(),
});

export const MenuItemSchema = z.looseObject({
  guid: z.string(),
  name: z.string(),
  price: z.number().nullish(),
  salesCategory: z.looseObject({ guid: z.string().nullish(), name: z.string().nullish() }).nullish(),
  modifierGroupReferences: z.array(z.number()).nullish(),
});

export const MenuGroupSchema: z.ZodType<{
  guid: string;
  name?: string | null;
  menuItems?: z.infer<typeof MenuItemSchema>[] | null;
  menuGroups?: unknown[] | null;
  [key: string]: unknown;
}> = z.looseObject({
  guid: z.string(),
  name: z.string().nullish(),
  menuItems: z.array(MenuItemSchema).nullish(),
  get menuGroups() {
    return z.array(MenuGroupSchema).nullish();
  },
}) as never;

export const MenusResponseSchema = z.looseObject({
  restaurantGuid: z.string().nullish(),
  lastUpdated: z.string().nullish(),
  menus: z.array(
    z.looseObject({
      guid: z.string(),
      name: z.string().nullish(),
      menuGroups: z.array(MenuGroupSchema).nullish(),
    }),
  ),
  modifierGroupReferences: z.record(z.string(), ModifierGroupSchema).nullish(),
  modifierOptionReferences: z.record(z.string(), ModifierOptionSchema).nullish(),
});

export type MenusResponse = z.infer<typeof MenusResponseSchema>;
