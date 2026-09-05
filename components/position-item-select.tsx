"use client";

import { useRouter } from "next/navigation";

type Item = { id: string; name: string };

/** Ingredient picker for /position: changing it navigates to ?item=<id> (server renders the table). */
export function PositionItemSelect({ items, value }: { items: Item[]; value: string | null }) {
  const router = useRouter();
  return (
    <label className="flex flex-col gap-1 text-sm text-neutral-600">
      Ingredient
      <select
        name="item"
        value={value ?? ""}
        onChange={(e) => router.push(`/position?item=${encodeURIComponent(e.target.value)}`)}
        className="h-12 w-full rounded-xl border border-neutral-300 bg-white px-3 text-base text-neutral-900"
      >
        {value ? null : <option value="">Choose an ingredient…</option>}
        {items.map((i) => (
          <option key={i.id} value={i.id}>
            {i.name}
          </option>
        ))}
      </select>
    </label>
  );
}
