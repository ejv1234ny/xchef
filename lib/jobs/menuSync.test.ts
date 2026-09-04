import { describe, expect, it } from "vitest";
import { MenusResponseSchema } from "@/lib/toast/schemas";
import { dedupeNames, extractMenuItems } from "./menuSync";

const menus = MenusResponseSchema.parse({
  restaurantGuid: "r1",
  lastUpdated: "2026-09-01T12:00:00.000+0000",
  menus: [
    {
      guid: "m1",
      name: "Bar",
      menuGroups: [
        {
          guid: "g1",
          name: "Cocktails",
          menuItems: [
            { guid: "item-margarita", name: "Classic Margarita", price: 12, salesCategory: { name: "Liquor" }, modifierGroupReferences: [1] },
          ],
          menuGroups: [{ guid: "g1b", name: "Frozen", menuItems: [{ guid: "item-frozen", name: "Frozen Marg", price: 13 }] }],
        },
      ],
    },
    {
      guid: "m2",
      name: "Food",
      menuGroups: [{ guid: "g2", name: "Burgers", menuItems: [{ guid: "item-burger", name: "Moose Burger", price: 17 }] }],
    },
  ],
  modifierGroupReferences: { "1": { guid: "mg1", name: "Tequila", modifierOptionReferences: [10] } },
  modifierOptionReferences: { "10": { guid: "item-sub-patron", name: "Sub Patron", price: 3 } },
});

describe("extractMenuItems", () => {
  it("walks nested menu groups and uses sales category, falling back to group name", () => {
    const { items, modifiers } = extractMenuItems(menus);
    expect(items.map((i) => i.guid).sort()).toEqual(["item-burger", "item-frozen", "item-margarita"]);
    expect(items.find((i) => i.guid === "item-margarita")?.category).toBe("Liquor");
    expect(items.find((i) => i.guid === "item-frozen")?.category).toBe("Frozen");
    expect(modifiers).toEqual([{ guid: "item-sub-patron", name: "Sub Patron", price: 3, category: "modifier" }]);
  });
});

describe("dedupeNames", () => {
  it("suffixes names already owned by a different guid", () => {
    const out = dedupeNames(
      [
        { guid: "a", name: "Coke", price: 3, category: null },
        { guid: "b", name: "Coke", price: 3, category: null },
        { guid: "c", name: "Fries", price: 5, category: null },
      ],
      [{ toast_menu_item_guid: "z", name: "Fries" }],
    );
    expect(out.map((o) => o.name)).toEqual(["Coke", "Coke #b", "Fries #c"]);
  });
});
