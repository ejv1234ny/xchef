"use client";

import Link from "next/link";
import { useRef, useState } from "react";
import { ConfidenceChip } from "./inventory-units";

export type RecipeCardProps = {
  componentId: string;
  menuItemId: string;
  menuItemName: string;
  ingredientName: string;
  unitsSold30d: string;
  /** AI guess, raw numeric string from the DB */
  quantity: string;
  /** unit the quantity is expressed in (component.unit) */
  unit: string;
  /** the ingredient's stocked base unit; shown when it differs from `unit` */
  baseUnit: string;
  confidence: number | string | null;
  note?: string | null;
  /** comma-separated skipped menu item ids to carry through */
  skip: string;
  skipHref: string;
  remainingOnItem: number;
  confirmAction: (formData: FormData) => Promise<void>;
  removeAction: (formData: FormData) => Promise<void>;
};

const primary = "flex h-14 flex-1 items-center justify-center rounded-2xl text-lg font-semibold";

/**
 * One question, one thumb. Accept submits the prefilled guess; Edit focuses
 * the number so the owner can type, then Accept/Save submits the same form.
 */
export function RecipeCard(p: RecipeCardProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(p.quantity);
  const changed = value.trim() !== p.quantity.trim();

  return (
    <div className="flex flex-col gap-5 rounded-2xl border border-neutral-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-1">
        <p className="text-sm text-neutral-500">
          {p.menuItemName} · {p.unitsSold30d} sold in 30 days
          {p.remainingOnItem > 1 ? ` · ${p.remainingOnItem} ingredients to confirm` : ""}
        </p>
        <h2 className="text-2xl font-semibold leading-tight">
          How much <span className="text-neutral-900">{p.ingredientName}</span> in a {p.menuItemName}?
        </h2>
      </div>

      <form action={p.confirmAction} className="flex flex-col gap-5">
        <input type="hidden" name="component_id" value={p.componentId} />
        <input type="hidden" name="menu_item_id" value={p.menuItemId} />
        <input type="hidden" name="unit" value={p.unit} />
        <input type="hidden" name="skip" value={p.skip} />

        <div className="flex items-end gap-3">
          <label className="flex flex-1 flex-col gap-1 text-sm text-neutral-600">
            Per one sold
            <input
              ref={inputRef}
              name="quantity"
              inputMode="decimal"
              pattern="[0-9]*[.]?[0-9]+"
              required
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onFocus={() => setEditing(true)}
              className={`h-16 w-full rounded-xl border px-4 text-3xl font-semibold tabular-nums ${
                editing ? "border-neutral-900" : "border-neutral-300"
              }`}
            />
          </label>
          <div className="flex h-16 flex-col justify-center pb-1">
            <span className="text-2xl font-medium">{p.unit}</span>
            {p.baseUnit !== p.unit ? <span className="text-xs text-neutral-500">stocked in {p.baseUnit}</span> : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 text-sm text-neutral-600">
          <ConfidenceChip confidence={p.confidence} />
          {p.note ? <span className="truncate">{p.note}</span> : null}
        </div>

        <div className="flex gap-3">
          <button type="submit" className={`${primary} bg-neutral-900 text-white`}>
            {changed ? "Save" : "✓ Accept"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(true);
              inputRef.current?.focus();
              inputRef.current?.select();
            }}
            className={`${primary} border border-neutral-300 bg-white`}
          >
            Edit
          </button>
          <Link href={p.skipHref} className={`${primary} border border-neutral-300 bg-white text-neutral-700`}>
            Skip
          </Link>
        </div>
      </form>

      <form action={p.removeAction} className="flex justify-center">
        <input type="hidden" name="component_id" value={p.componentId} />
        <input type="hidden" name="menu_item_id" value={p.menuItemId} />
        <input type="hidden" name="skip" value={p.skip} />
        <button type="submit" className="h-11 px-4 text-sm text-red-700 underline-offset-2 hover:underline">
          Not in this dish — remove {p.ingredientName}
        </button>
      </form>
    </div>
  );
}
