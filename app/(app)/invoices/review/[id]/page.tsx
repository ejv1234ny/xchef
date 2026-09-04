import Link from "next/link";
import { notFound } from "next/navigation";
import { getAppContext } from "@/lib/db/context";
import { createServerSupabase } from "@/lib/db/server";
import { createServiceSupabase } from "@/lib/db/service";
import { signedInvoiceUrl } from "@/lib/storage";
import { Constants, type Tables } from "@/lib/db/types";
import { fmtDate, fmtMoney, fmtQty, fmtUnitCost, statusChipClass, statusLabel, Chip, Flash } from "@/components/ui-format";
import { approveAutoMapping, confirmLine, ignoreLine, rejectDocument, rerunMapping, setVendor } from "./actions";

export const metadata = { title: "Review invoice" };

const inputCls = "h-12 w-full rounded-xl border border-neutral-300 bg-white px-3 text-base";
const btnPrimary = "h-14 flex-1 rounded-xl bg-neutral-900 text-base font-medium text-white";
const btnSecondary = "h-14 rounded-xl border border-neutral-300 bg-white px-4 text-base font-medium";
const btnSmall = "h-11 rounded-xl border border-neutral-300 bg-white px-3 text-sm font-medium";

type Line = Tables<"invoice_lines">;
type Mapping = Pick<Tables<"vendor_item_mappings">, "id" | "confirmed_at" | "pack_description" | "units_per_pack" | "base_units_per_unit" | "brand">;
type Item = Pick<Tables<"inventory_items">, "id" | "name" | "base_unit" | "category">;

function fileKind(path: string, source: string): "image" | "pdf" | "none" | "other" {
  if (source === "manual" || source === "paste") return "none";
  const ext = path.toLowerCase().split(".").pop() ?? "";
  if (ext === "pdf") return "pdf";
  if (["jpg", "jpeg", "png", "webp", "gif", "heic", "heif"].includes(ext)) return "image";
  return "other";
}

export default async function ReviewPage({ params, searchParams }: PageProps<"/invoices/review/[id]">) {
  const { id } = await params;
  const sp = await searchParams;
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();

  const { data: doc } = await supabase.from("invoice_documents").select("*").eq("id", id).eq("location_id", ctx.location.id).maybeSingle();
  if (!doc) notFound();

  const [{ data: lines }, { data: vendors }, { data: items }] = await Promise.all([
    supabase.from("invoice_lines").select("*").eq("invoice_id", doc.id).order("line_no"),
    supabase.from("vendors").select("id, name").eq("tenant_id", ctx.tenant.id).order("name"),
    supabase.from("inventory_items").select("id, name, base_unit, category").eq("tenant_id", ctx.tenant.id).order("name"),
  ]);
  const mappingIds = [...new Set((lines ?? []).map((l) => l.mapping_id).filter((m): m is string => Boolean(m)))];
  const { data: mappings } = mappingIds.length
    ? await supabase.from("vendor_item_mappings").select("id, confirmed_at, pack_description, units_per_pack, base_units_per_unit, brand").in("id", mappingIds)
    : { data: [] as Mapping[] };

  const kind = fileKind(doc.storage_path, doc.source);
  // Service role is used here only to sign a short-lived URL for the private bucket.
  let fileUrl: string | null = null;
  if (kind !== "none") {
    try {
      fileUrl = await signedInvoiceUrl(createServiceSupabase(), doc.storage_path, 600);
    } catch {
      fileUrl = null;
    }
  }

  const itemById = new Map((items ?? []).map((i) => [i.id, i]));
  const mappingById = new Map((mappings ?? []).map((m) => [m.id, m]));
  const vendorNameById = new Map((vendors ?? []).map((v) => [v.id, v.name]));
  const allLines = lines ?? [];
  const unresolved = allLines.filter((l) => l.status === "unmapped");
  const resolved = allLines.filter((l) => l.status !== "unmapped");

  return (
    <div className="flex flex-col gap-5 py-4">
      <div className="flex items-center justify-between">
        <Link href="/invoices" className="flex h-11 items-center text-sm text-neutral-600">
          ← Invoices
        </Link>
        <Chip className={statusChipClass(doc.status)}>{statusLabel(doc.status)}</Chip>
      </div>
      <Flash ok={sp.ok} error={sp.error} />

      <details open className="rounded-xl border border-neutral-200 bg-white">
        <summary className="flex min-h-12 cursor-pointer items-center px-4 text-sm font-medium">Document</summary>
        <div className="h-[40vh] border-t border-neutral-200 bg-neutral-100">
          {kind === "none" ? (
            <p className="p-4 text-sm text-neutral-600">No file — this invoice was {doc.source === "paste" ? "pasted as text" : "entered by hand"}.</p>
          ) : !fileUrl ? (
            <p className="p-4 text-sm text-neutral-600">File preview unavailable.</p>
          ) : kind === "pdf" ? (
            <iframe src={fileUrl} title="Invoice PDF" className="h-full w-full" />
          ) : kind === "image" ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={fileUrl} alt="Invoice" className="h-full w-full object-contain" />
          ) : (
            <a href={fileUrl} target="_blank" rel="noreferrer" className="flex h-12 items-center px-4 text-sm underline">
              Open file
            </a>
          )}
        </div>
      </details>

      <header className="flex flex-col gap-3 rounded-2xl border border-neutral-200 bg-white p-4">
        <form action={setVendor} className="flex items-end gap-2">
          <input type="hidden" name="document_id" value={doc.id} />
          <label className="flex-1 text-sm">
            Vendor
            <select name="vendor_id" defaultValue={doc.vendor_id ?? ""} className={inputCls}>
              <option value="">— pick a vendor —</option>
              {(vendors ?? []).map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <button className={`${btnSmall} h-12`}>Set</button>
        </form>
        <dl className="grid grid-cols-3 gap-2 text-sm">
          <div>
            <dt className="text-xs text-neutral-500">Invoice #</dt>
            <dd className="font-medium">{doc.invoice_number ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Date</dt>
            <dd className="font-medium">{fmtDate(doc.invoice_date)}</dd>
          </div>
          <div>
            <dt className="text-xs text-neutral-500">Total</dt>
            <dd className="font-medium tabular-nums">{fmtMoney(doc.total)}</dd>
          </div>
          <div className="col-span-3 text-xs text-neutral-500">
            Subtotal {fmtMoney(doc.subtotal)} · Tax {fmtMoney(doc.tax)}
            {doc.parse_confidence != null ? ` · read with ${Math.round(doc.parse_confidence * 100)}% confidence` : ""}
            {doc.posted_at ? ` · posted ${fmtDate(doc.posted_at.slice(0, 10))}` : ""}
          </div>
        </dl>
        {doc.parse_error ? <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">{doc.parse_error}</p> : null}
        <div className="flex gap-2">
          <form action={rerunMapping} className="flex-1">
            <input type="hidden" name="document_id" value={doc.id} />
            <button className={`${btnSecondary} w-full`}>Re-run mapping</button>
          </form>
          {doc.status !== "rejected" ? (
            <form action={rejectDocument} className="flex-1">
              <input type="hidden" name="document_id" value={doc.id} />
              <button className={`${btnSecondary} w-full text-red-800`}>Not an invoice</button>
            </form>
          ) : null}
        </div>
      </header>

      {unresolved.length > 0 ? (
        <section className="flex flex-col gap-3">
          <h2 className="text-lg font-medium">
            {unresolved.length} line{unresolved.length === 1 ? "" : "s"} to review
          </h2>
          {!doc.vendor_id ? <p className="text-sm text-amber-800">Pick the vendor above first — mappings are learned per vendor.</p> : null}
          {unresolved.map((l) => (
            <UnresolvedLine key={l.id} line={l} documentId={doc.id} items={items ?? []} />
          ))}
        </section>
      ) : null}

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">{unresolved.length > 0 ? "Already mapped" : "Lines"}</h2>
        {resolved.length === 0 ? (
          <p className="text-sm text-neutral-500">{allLines.length === 0 ? "No lines were read from this document." : "Nothing mapped yet."}</p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
            {resolved.map((l) => (
              <ResolvedLine key={l.id} line={l} documentId={doc.id} item={l.inventory_item_id ? itemById.get(l.inventory_item_id) : undefined} mapping={l.mapping_id ? mappingById.get(l.mapping_id) : undefined} />
            ))}
          </ul>
        )}
        {doc.vendor_id ? <p className="text-xs text-neutral-500">Mappings learned for {vendorNameById.get(doc.vendor_id)} apply to every future invoice from them.</p> : null}
      </section>
    </div>
  );
}

function qtyText(line: Line): string {
  const q = fmtQty(line.quantity);
  return line.pack_size_text ? `${q} × ${line.pack_size_text}` : q;
}

function ResolvedLine({ line, documentId, item, mapping }: { line: Line; documentId: string; item: Item | undefined; mapping: Mapping | undefined }) {
  const ai = line.status === "auto_mapped" && !mapping?.confirmed_at;
  const unit = item?.base_unit ?? "";
  return (
    <li className="flex min-h-14 flex-col gap-2 px-4 py-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <span className="font-medium">{qtyText(line)}</span> · {line.description}
          {line.status === "ignored" ? (
            <span className="text-neutral-500"> → not inventory</span>
          ) : (
            <>
              <span className="text-neutral-500"> → </span>
              <span className="font-medium">{item?.name ?? "?"}</span>
              {line.quantity_base_unit != null ? (
                <span className="text-neutral-600">
                  {" "}
                  · {fmtQty(line.quantity_base_unit)} {unit}
                </span>
              ) : null}
              {line.cost_per_base_unit != null ? (
                <span className="text-neutral-600">
                  {" "}
                  · {fmtUnitCost(line.cost_per_base_unit)}/{unit}
                </span>
              ) : null}
            </>
          )}
          {mapping?.pack_description ? <div className="text-xs text-neutral-500">assumed {mapping.pack_description} = {fmtQty(mapping.units_per_pack * mapping.base_units_per_unit)} {unit}{mapping.brand ? ` · ${mapping.brand}` : ""}</div> : null}
        </div>
        <span className="shrink-0 tabular-nums text-neutral-700">{fmtMoney(line.extended_price)}</span>
      </div>
      {ai ? (
        <form action={approveAutoMapping} className="flex items-center gap-2">
          <input type="hidden" name="document_id" value={documentId} />
          <input type="hidden" name="line_id" value={line.id} />
          <Chip className="bg-violet-100 text-violet-900">AI</Chip>
          <button className={btnSmall}>✓ looks right</button>
        </form>
      ) : null}
    </li>
  );
}

function UnresolvedLine({ line, documentId, items }: { line: Line; documentId: string; items: Item[] }) {
  return (
    <form action={confirmLine} className="flex flex-col gap-3 rounded-2xl border border-amber-300 bg-amber-50 p-4">
      <input type="hidden" name="document_id" value={documentId} />
      <input type="hidden" name="line_id" value={line.id} />
      <div className="flex items-start justify-between gap-2 text-sm">
        <div>
          <div className="font-medium">{line.description}</div>
          <div className="text-neutral-600">
            {qtyText(line)}
            {line.vendor_sku ? ` · SKU ${line.vendor_sku}` : ""}
            {line.unit_price != null ? ` · ${fmtMoney(line.unit_price)} each` : ""}
          </div>
        </div>
        <span className="shrink-0 tabular-nums">{fmtMoney(line.extended_price)}</span>
      </div>

      <label className="text-sm">
        Inventory item
        <select name="inventory_item_id" defaultValue="" className={inputCls}>
          <option value="">— choose —</option>
          {items.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} ({i.base_unit})
            </option>
          ))}
        </select>
      </label>
      <details className="rounded-xl border border-neutral-200 bg-white">
        <summary className="flex min-h-11 cursor-pointer items-center px-3 text-sm font-medium">＋ New item…</summary>
        <div className="grid grid-cols-2 gap-2 border-t border-neutral-200 p-3">
          <label className="col-span-2 text-sm">
            Name
            <input name="new_name" className={inputCls} placeholder="Tequila - Blanco" />
          </label>
          <label className="text-sm">
            Category
            <input name="new_category" className={inputCls} placeholder="liquor" list={`cats-${line.id}`} />
            <datalist id={`cats-${line.id}`}>
              {[...new Set(items.map((i) => i.category).filter((c): c is string => Boolean(c)))].map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </label>
          <label className="text-sm">
            Base unit
            <select name="new_base_unit" defaultValue="" className={inputCls}>
              <option value="">—</option>
              {Constants.public.Enums.uom.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
          </label>
        </div>
      </details>

      <div className="grid grid-cols-2 gap-2">
        <label className="text-sm">
          Units per pack
          <input name="units_per_pack" defaultValue="1" inputMode="decimal" className={inputCls} />
        </label>
        <label className="text-sm">
          Base units per unit
          <input name="base_units_per_unit" inputMode="decimal" required className={inputCls} placeholder="25.36" />
        </label>
        <label className="text-sm">
          Pack description
          <input name="pack_description" defaultValue={line.pack_size_text ?? ""} className={inputCls} placeholder="6/#10" />
        </label>
        <label className="text-sm">
          Brand
          <input name="brand" className={inputCls} placeholder="Heinz" />
        </label>
      </div>
      <p className="text-xs text-neutral-600">Units per pack × base units per unit = base units bought per invoice unit. Shown as “assumed” on every price row.</p>

      <div className="flex gap-2">
        <button formAction={confirmLine} className={btnPrimary}>
          Confirm
        </button>
        <button formAction={ignoreLine} formNoValidate className={btnSecondary}>
          Not inventory
        </button>
      </div>
    </form>
  );
}
