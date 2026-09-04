import type { Tables } from "@/lib/db/types";
import { INVENTORY_CATEGORY_OPTIONS, UOMS, categoryLabel, rawNumeric } from "./inventory-units";

const inputCls = "h-12 w-full rounded-xl border border-neutral-300 bg-white px-4 text-base";
const btnCls = "h-12 flex-1 rounded-xl bg-neutral-900 px-5 text-base font-medium text-white";
const dangerCls = "h-12 rounded-xl border border-red-200 bg-white px-4 text-base font-medium text-red-700";

type Props = {
  item?: Tables<"inventory_items">;
  saveAction: (formData: FormData) => Promise<void>;
  deleteAction?: (formData: FormData) => Promise<void>;
  submitLabel: string;
};

/** One form per item (or the "Add item" form). Two submit buttons share it: save and delete. */
export function InventoryItemForm({ item, saveAction, deleteAction, submitLabel }: Props) {
  const categories = new Set<string>(INVENTORY_CATEGORY_OPTIONS);
  if (item?.category) categories.add(item.category);
  return (
    <form action={saveAction} className="flex flex-col gap-3">
      {item ? <input type="hidden" name="id" value={item.id} /> : null}
      <label className="text-sm">
        Name
        <input name="name" defaultValue={item?.name ?? ""} required maxLength={120} className={inputCls} autoComplete="off" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">
          Category
          <select name="category" defaultValue={item?.category ?? ""} className={inputCls}>
            <option value="">Uncategorized</option>
            {[...categories].map((c) => (
              <option key={c} value={c}>
                {categoryLabel(c)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          Base unit
          <select name="base_unit" defaultValue={item?.base_unit ?? "oz"} className={inputCls}>
            {UOMS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-sm">
          Base units per pack
          <input
            name="pack_to_base_factor"
            inputMode="decimal"
            placeholder="25.36"
            defaultValue={rawNumeric(item?.pack_to_base_factor)}
            className={inputCls}
          />
        </label>
        <label className="text-sm">
          Cost per base unit ($)
          <input
            name="cost_per_base_unit"
            inputMode="decimal"
            placeholder="0.85"
            defaultValue={rawNumeric(item?.cost_per_base_unit)}
            className={inputCls}
          />
        </label>
      </div>
      <div className="flex gap-3">
        <button className={btnCls}>{submitLabel}</button>
        {item && deleteAction ? (
          <button formAction={deleteAction} className={dangerCls}>
            Delete
          </button>
        ) : null}
      </div>
    </form>
  );
}
