import Link from "next/link";
import { getAppContext } from "@/lib/db/context";
import { createServerSupabase } from "@/lib/db/server";
import { InvoiceUpload, ManualInvoiceForm } from "@/components/invoice-upload";
import { fmtDate, fmtMoney, statusChipClass, statusLabel, Chip, Flash } from "@/components/ui-format";
import { pasteInvoice } from "./actions";
import { CopyAddress } from "@/components/copy-address";

export const metadata = { title: "Invoices" };

export default async function InvoicesPage({ searchParams }: PageProps<"/invoices">) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();

  const [{ data: docs, error }, { data: vendors }] = await Promise.all([
    supabase.from("invoice_documents").select("*").eq("location_id", ctx.location.id).order("created_at", { ascending: false }).limit(100),
    supabase.from("vendors").select("id, name").eq("tenant_id", ctx.tenant.id),
  ]);
  const docIds = (docs ?? []).map((d) => d.id);
  const { data: unmappedLines } = docIds.length
    ? await supabase.from("invoice_lines").select("invoice_id").eq("status", "unmapped").in("invoice_id", docIds)
    : { data: [] as { invoice_id: string }[] };

  const vendorName = new Map((vendors ?? []).map((v) => [v.id, v.name]));
  const unmappedCount = new Map<string, number>();
  for (const l of unmappedLines ?? []) unmappedCount.set(l.invoice_id, (unmappedCount.get(l.invoice_id) ?? 0) + 1);

  return (
    <div className="flex flex-col gap-6 py-4">
      <h1 className="text-2xl font-semibold">Invoices</h1>
      <Flash ok={sp.ok} error={error ? error.message : sp.error} />

      <section className="flex flex-col gap-3">
        <InvoiceUpload variant="camera" />
        <InvoiceUpload variant="file" />
        {process.env.INBOUND_EMAIL_ADDRESS ? <CopyAddress address={process.env.INBOUND_EMAIL_ADDRESS} /> : null}
      </section>

      <details className="rounded-xl border border-neutral-200 bg-white">
        <summary className="flex min-h-14 cursor-pointer items-center px-4 font-medium">Paste invoice text</summary>
        <form action={pasteInvoice} className="flex flex-col gap-3 border-t border-neutral-200 p-4">
          <textarea
            name="text"
            rows={8}
            required
            className="w-full rounded-xl border border-neutral-300 bg-white p-3 text-base"
            placeholder="Paste the vendor name, date, and every line from the invoice email or PDF…"
          />
          <button className="h-14 rounded-xl bg-neutral-900 text-base font-medium text-white">Read pasted invoice</button>
        </form>
      </details>

      <details className="rounded-xl border border-neutral-200 bg-white">
        <summary className="flex min-h-14 cursor-pointer items-center px-4 font-medium">Enter by hand</summary>
        <div className="border-t border-neutral-200 p-4">
          <ManualInvoiceForm />
        </div>
      </details>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Recent</h2>
        {(docs ?? []).length === 0 ? (
          <p className="rounded-2xl border border-dashed border-neutral-300 bg-white p-5 text-sm text-neutral-600">
            No invoices yet. Photo one above — it is read, matched to your inventory, and posted when every line is mapped.
          </p>
        ) : (
          <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
            {(docs ?? []).map((d) => {
              const pending = unmappedCount.get(d.id) ?? 0;
              return (
                <li key={d.id}>
                  <Link href={`/invoices/review/${d.id}`} className="flex min-h-16 items-center justify-between gap-3 px-4 py-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate font-medium">{(d.vendor_id && vendorName.get(d.vendor_id)) || "Unknown vendor"}</span>
                        <Chip className={statusChipClass(d.status)}>{statusLabel(d.status)}</Chip>
                      </div>
                      <div className="text-sm text-neutral-600">
                        {fmtDate(d.invoice_date ?? d.created_at.slice(0, 10))}
                        {d.invoice_number ? ` · #${d.invoice_number}` : ""}
                        {` · ${d.source}`}
                        {pending > 0 ? <span className="text-amber-800"> · {pending} line{pending === 1 ? "" : "s"} to review</span> : null}
                      </div>
                    </div>
                    <span className="shrink-0 font-medium tabular-nums">{fmtMoney(d.total)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
