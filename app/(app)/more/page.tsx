import Link from "next/link";

export const metadata = { title: "More" };

const LINKS = [
  { href: "/on-hand", label: "On-hand", sub: "Every item, days of supply" },
  { href: "/recipes", label: "Recipe Q&A", sub: "Confirm pours and portions" },
  { href: "/menu", label: "Menu & plate cost", sub: "Worst margins first" },
  { href: "/inventory", label: "Inventory catalog", sub: "Items, units, pack sizes" },
  { href: "/settings", label: "Settings", sub: "Location, Toast access, syncs" },
];

export default function MorePage() {
  return (
    <div className="flex flex-col gap-4 py-4">
      <h1 className="text-2xl font-semibold">More</h1>
      <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
        {LINKS.map((l) => (
          <li key={l.href}>
            <Link href={l.href} className="flex min-h-14 flex-col justify-center px-4 py-2">
              <span className="font-medium">{l.label}</span>
              <span className="text-sm text-neutral-500">{l.sub}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
