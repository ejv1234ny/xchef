import { getAppContext } from "@/lib/db/context";
import { createServerSupabase } from "@/lib/db/server";
import { signOut } from "@/app/login/actions";
import Link from "next/link";
import { saveToastCredentials, syncMenuNow, syncToastNow, updateLocation, updateVendorContact } from "./actions";

export const metadata = { title: "Settings" };

const inputCls = "h-12 w-full rounded-xl border border-neutral-300 bg-white px-4 text-base";
const btnCls = "h-12 rounded-xl bg-neutral-900 px-5 text-base font-medium text-white disabled:opacity-40";
const btn2Cls = "h-12 rounded-xl border border-neutral-300 bg-white px-5 text-base font-medium";

export default async function SettingsPage({ searchParams }: PageProps<"/settings">) {
  const sp = await searchParams;
  const ctx = await getAppContext();
  const supabase = await createServerSupabase();
  const [{ data: creds }, { data: runs }, { count: menuCount }, { data: vendors }, { data: mappings }] = await Promise.all([
    supabase.from("toast_credentials").select("client_id, last_synced_at, created_at").eq("location_id", ctx.location.id).maybeSingle(),
    supabase.from("sync_runs").select("*").eq("location_id", ctx.location.id).order("created_at", { ascending: false }).limit(8),
    supabase.from("menu_items").select("id", { count: "exact", head: true }).eq("tenant_id", ctx.tenant.id),
    supabase.from("vendors").select("id, name, kind, contact_email").eq("tenant_id", ctx.tenant.id).order("name"),
    supabase.from("vendor_item_mappings").select("vendor_id").eq("tenant_id", ctx.tenant.id),
  ]);
  const mappingCount = new Map<string, number>();
  for (const m of mappings ?? []) mappingCount.set(m.vendor_id, (mappingCount.get(m.vendor_id) ?? 0) + 1);

  return (
    <div className="flex flex-col gap-8 py-4">
      <h1 className="text-2xl font-semibold">Settings</h1>
      {typeof sp.ok === "string" ? <p className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900">{sp.ok}</p> : null}
      {typeof sp.error === "string" ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{sp.error}</p> : null}

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Location</h2>
        <form action={updateLocation} className="flex flex-col gap-3">
          <label className="text-sm">
            Name
            <input name="name" defaultValue={ctx.location.name} className={inputCls} />
          </label>
          <label className="text-sm">
            Timezone (IANA)
            <input name="timezone" defaultValue={ctx.location.timezone} className={inputCls} />
          </label>
          <label className="text-sm">
            Toast location GUID
            <input name="toast_location_guid" defaultValue={ctx.location.toast_location_guid ?? ""} className={inputCls} />
          </label>
          <label className="text-sm">
            Inbound email slug
            <input name="inbound_email_slug" defaultValue={ctx.location.inbound_email_slug ?? ""} className={inputCls} />
          </label>
          <p className="text-xs text-neutral-500">
            {process.env.INBOUND_EMAIL_ADDRESS ? (
              <>
                Vendors can email invoices to <code>{process.env.INBOUND_EMAIL_ADDRESS}</code> today.
              </>
            ) : (
              "Inbound email address not configured (INBOUND_EMAIL_ADDRESS)."
            )}
          </p>
          <button className={btnCls}>Save location</button>
        </form>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Toast API access</h2>
        <p className="text-sm text-neutral-600">
          {creds ? (
            <>
              Client id <code>{creds.client_id}</code> stored {new Date(creds.created_at).toLocaleDateString()}.
              {creds.last_synced_at ? ` Last synced ${new Date(creds.last_synced_at).toLocaleString()}.` : " Never synced."}
            </>
          ) : (
            "No credentials yet. Toast Web → Integrations → Toast API access (Standard). The secret is stored in Supabase Vault and never shown again."
          )}
        </p>
        <form action={saveToastCredentials} className="flex flex-col gap-3">
          <label className="text-sm">
            Client id
            <input name="client_id" defaultValue={creds?.client_id ?? ""} className={inputCls} autoComplete="off" />
          </label>
          <label className="text-sm">
            Client secret
            <input name="client_secret" type="password" className={inputCls} autoComplete="off" />
          </label>
          <label className="text-sm">
            Location GUID
            <input name="toast_location_guid" defaultValue={ctx.location.toast_location_guid ?? ""} className={inputCls} />
          </label>
          <button className={btnCls}>Store credentials</button>
        </form>
        <div className="flex gap-3">
          <form action={syncToastNow}>
            <button className={btn2Cls} disabled={!creds}>
              Sync sales now
            </button>
          </form>
          <form action={syncMenuNow}>
            <button className={btn2Cls} disabled={!creds}>
              Sync menu now ({menuCount ?? 0} items)
            </button>
          </form>
        </div>
      </section>

      <section id="vendors" className="flex flex-col gap-3">
        <h2 className="text-lg font-medium">Vendors</h2>
        <p className="text-sm text-neutral-600">
          The sales rep&apos;s email for each vendor. Pricing requests go there (every Monday, on a 10% price jump, or from the{" "}
          <Link href="/prices" className="underline">
            Prices
          </Link>{" "}
          page) and replies file themselves as quotes.
        </p>
        {vendors?.length ? (
          <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
            {vendors.map((v) => {
              const n = mappingCount.get(v.id) ?? 0;
              return (
                <li key={v.id} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">{v.name}</span>
                    <span className="text-xs text-neutral-500">
                      {v.kind.replace(/_/g, " ")} · {n} mapped item{n === 1 ? "" : "s"}
                    </span>
                  </div>
                  <form action={updateVendorContact} className="flex gap-2">
                    <input type="hidden" name="vendor_id" value={v.id} />
                    <input
                      name="contact_email"
                      type="email"
                      inputMode="email"
                      autoComplete="off"
                      placeholder="rep@vendor.com"
                      defaultValue={v.contact_email ?? ""}
                      aria-label={`${v.name} contact email`}
                      className={`${inputCls} min-w-0 flex-1`}
                    />
                    <button className={btn2Cls}>Save</button>
                  </form>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">No vendors yet — they are created from your first posted invoice.</p>
        )}
      </section>

      <section className="flex flex-col gap-2">
        <h2 className="text-lg font-medium">Recent syncs</h2>
        {runs?.length ? (
          <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white text-sm">
            {runs.map((r) => (
              <li key={r.id} className="flex flex-col gap-0.5 px-3 py-2">
                <div className="flex justify-between">
                  <span className="font-medium">{r.kind}</span>
                  <span className="text-neutral-500">{new Date(r.created_at).toLocaleString()}</span>
                </div>
                <div className="text-neutral-600">
                  {r.orders_upserted} orders · {r.dates_rebuilt.length} dates · {r.orders_quarantined} quarantined · {r.duration_ms ?? 0} ms
                </div>
                {r.error ? <div className="text-red-700">{r.error}</div> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-neutral-500">No sync runs yet.</p>
        )}
      </section>

      <form action={signOut}>
        <button className={btn2Cls}>Sign out ({ctx.email})</button>
      </form>
    </div>
  );
}
