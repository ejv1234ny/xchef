import { createServiceSupabase, type ServiceClient } from "@/lib/db/service";
import type { Json } from "@/lib/db/types";
import { composeQuoteRequest, quoteToken, type QuoteRequestItem } from "@/lib/core/quotes";
import { getLocation, type Logger } from "./intake";

/**
 * Outbound pricing requests (KICKOFF-2 Part 3, BLUEPRINT §5.4). For every
 * vendor that has at least one vendor_item_mappings row (what they supply, in
 * which pack) and a contact_email, compose a plain-text request listing those
 * items and send it through Resend with reply-to = the inbound address, so the
 * reply lands in /api/inbound/resend and threads back by the [Q-…] token in
 * the subject. One quote_requests row per email. At most one request per
 * vendor per 7 days unless forced (the "Ask for pricing" button).
 *
 * Env (names only): RESEND_API_KEY, RESEND_FROM_DOMAIN (the restaurant's own
 * verified sending domain; quotes@<domain>), RESEND_FROM_NAME (display name,
 * default the location name), INBOUND_EMAIL_ADDRESS (reply-to). While the
 * domain is not verified in Resend the request is recorded as
 * status 'blocked_sender' and nothing is sent. Dry runs need none of them.
 */

export const QUOTE_REQUEST_COOLDOWN_DAYS = 7;
/** verification_queue.price_change_30d at or above this triggers a request (10%). */
export const PRICE_SHOCK_THRESHOLD = 0.1;
const RESEND_EMAILS_URL = "https://api.resend.com/emails";

export type QuoteRequestLineItem = QuoteRequestItem & { mapping_id: string; inventory_item_id: string; inventory_item_name: string | null };

export type QuoteRequestResult = {
  vendorId: string;
  vendorName: string;
  to: string | null;
  token: string;
  subject: string;
  text: string;
  items: QuoteRequestLineItem[];
  /** true when the email went out (never in a dry run) */
  sent: boolean;
  dry: boolean;
  /** why nothing was sent: "no contact_email" | "requested within 7 days" | "no mappings" | "blocked_sender: …" | "error: …" */
  skipped: string | null;
  requestId: string | null;
  resendMessageId: string | null;
  /** the From header the email carries (or would carry) */
  from: string;
  /** sending-domain verification (checked once per run when RESEND_API_KEY is present) */
  sender: SenderStatus;
};

export type SendQuoteRequestsOptions = {
  locationId: string;
  /** only this vendor (the prices page button, `--vendor`) */
  vendorId?: string;
  /** ignore the 7-day cooldown */
  force?: boolean;
  /** compose only; nothing sent, nothing written */
  dry?: boolean;
  log?: Logger;
  svc?: ServiceClient;
  fetchImpl?: typeof fetch;
  now?: Date;
};

export type QuoteEnv = { apiKey: string; fromDomain: string; fromName: string; /** "Mad Moose Bar & Grill <quotes@madmoosebarandgrill.com>" */ from: string; replyTo: string };

/** Local part of the sending address on RESEND_FROM_DOMAIN. */
export const QUOTE_FROM_LOCAL_PART = "quotes";
const RESEND_DOMAINS_URL = "https://api.resend.com/domains";

/**
 * Sending needs RESEND_API_KEY, RESEND_FROM_DOMAIN and INBOUND_EMAIL_ADDRESS;
 * RESEND_FROM_NAME defaults to the location's name. A dry run reads what is
 * there and falls back to placeholders. QUOTE_FROM_EMAIL (a sender on another
 * venture's domain) is no longer read: replies must come from the restaurant.
 */
export function quoteEnv(strict: boolean, fallbackName = ""): QuoteEnv {
  const apiKey = process.env.RESEND_API_KEY ?? "";
  const fromDomain = (process.env.RESEND_FROM_DOMAIN ?? "").trim().toLowerCase().replace(/^@/, "");
  const fromName = (process.env.RESEND_FROM_NAME ?? "").trim() || fallbackName;
  const replyTo = process.env.INBOUND_EMAIL_ADDRESS ?? "";
  if (strict) {
    const missing = [!apiKey && "RESEND_API_KEY", !fromDomain && "RESEND_FROM_DOMAIN", !replyTo && "INBOUND_EMAIL_ADDRESS"].filter(Boolean);
    if (missing.length) throw new Error(`Missing environment variable(s) ${missing.join(", ")}`);
  }
  const address = fromDomain ? `${QUOTE_FROM_LOCAL_PART}@${fromDomain}` : "(RESEND_FROM_DOMAIN not set)";
  const from = fromName ? `${fromName.replace(/[<>]/g, "")} <${address}>` : address;
  return { apiKey, fromDomain, fromName, from, replyTo: replyTo || "(INBOUND_EMAIL_ADDRESS not set)" };
}

export type DnsRecord = { record: string; type: string; name: string; value: string; ttl?: string | null; priority?: number | null; status?: string | null };
export type SenderStatus = { ok: boolean; domain: string; status: string | null; reason: string | null; dns: DnsRecord[] };

/**
 * Is RESEND_FROM_DOMAIN verified for sending in Resend? When it is not, the DNS
 * records Resend wants are returned so the report / dry run can show them.
 * Never throws: an API failure is a blocked sender with the reason.
 */
export async function checkSender(env: Pick<QuoteEnv, "apiKey" | "fromDomain">, fetchImpl: typeof fetch = fetch): Promise<SenderStatus> {
  const base: SenderStatus = { ok: false, domain: env.fromDomain, status: null, reason: null, dns: [] };
  if (!env.fromDomain) return { ...base, reason: "RESEND_FROM_DOMAIN is not set" };
  if (!env.apiKey) return { ...base, reason: "RESEND_API_KEY is not set (cannot verify the sending domain)" };
  const headers = { Authorization: `Bearer ${env.apiKey}` };
  try {
    const res = await fetchImpl(RESEND_DOMAINS_URL, { headers });
    if (!res.ok) return { ...base, reason: `Resend GET /domains: ${res.status}` };
    const body = (await res.json()) as { data?: Array<{ id: string; name: string; status: string }> };
    const d = (body.data ?? []).find((x) => x.name.toLowerCase() === env.fromDomain);
    if (!d) return { ...base, reason: `${env.fromDomain} is not registered as a sending domain in Resend` };
    if (d.status === "verified") return { ...base, ok: true, status: "verified" };
    const det = await fetchImpl(`${RESEND_DOMAINS_URL}/${encodeURIComponent(d.id)}`, { headers });
    const detail = det.ok ? ((await det.json()) as { records?: DnsRecord[] }) : {};
    return { ...base, status: d.status, reason: `${env.fromDomain} is "${d.status}" in Resend — its DNS records are not in place yet`, dns: detail.records ?? [] };
  } catch (e) {
    return { ...base, reason: `Resend domains lookup failed: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** POST https://api.resend.com/emails → { id }. */
export async function sendViaResend(env: QuoteEnv, msg: { to: string; subject: string; text: string; token: string }, fetchImpl: typeof fetch = fetch): Promise<string> {
  const res = await fetchImpl(RESEND_EMAILS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: env.from, to: [msg.to], reply_to: env.replyTo, subject: msg.subject, text: msg.text, tags: [{ name: "kind", value: "quote-request" }, { name: "token", value: msg.token }] }),
  });
  if (!res.ok) throw new Error(`Resend POST /emails: ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { id?: string };
  if (!body.id) throw new Error("Resend POST /emails: no id in response");
  return body.id;
}

/**
 * Receipt OCR leaves near-duplicate mappings for one product ("TITO S HANDMADE
 * VODKA", "TITOS VODKA 750ML" → the same ingredient and pack). Ask the rep once
 * per (ingredient, pack): keep the mapping with a SKU, else the longest description.
 */
export function dedupeItems(items: QuoteRequestLineItem[]): QuoteRequestLineItem[] {
  const byKey = new Map<string, QuoteRequestLineItem>();
  for (const it of items) {
    const key = `${it.inventory_item_id}|${(it.pack_description ?? "").toLowerCase()}`;
    const prev = byKey.get(key);
    if (!prev) byKey.set(key, it);
    else if ((!prev.vendor_sku && it.vendor_sku) || (Boolean(prev.vendor_sku) === Boolean(it.vendor_sku) && it.description.length > prev.description.length)) byKey.set(key, it);
  }
  return [...byKey.values()].sort((a, b) => a.description.localeCompare(b.description));
}

async function uniqueToken(svc: ServiceClient): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const t = quoteToken();
    const { data } = await svc.from("quote_requests").select("id").eq("token", t).maybeSingle();
    if (!data) return t;
  }
  throw new Error("could not allocate a unique quote token");
}

export async function sendQuoteRequests(opts: SendQuoteRequestsOptions): Promise<QuoteRequestResult[]> {
  const svc = opts.svc ?? createServiceSupabase();
  const log = opts.log ?? (() => {});
  const dry = opts.dry ?? false;
  const now = opts.now ?? new Date();
  const location = await getLocation(svc, opts.locationId);
  const env = quoteEnv(!dry, location.name);
  const { data: tenant } = await svc.from("tenants").select("owner_first_name").eq("id", location.tenant_id).maybeSingle();
  const sender = await checkSender(env, opts.fetchImpl);

  let vq = svc.from("vendors").select("id, name, contact_email").eq("tenant_id", location.tenant_id);
  if (opts.vendorId) vq = vq.eq("id", opts.vendorId);
  const { data: vendors, error: verr } = await vq.order("name");
  if (verr) throw new Error(`read vendors: ${verr.message}`);
  if (!vendors || vendors.length === 0) return [];

  const vendorIds = vendors.map((v) => v.id);
  const [{ data: mappingRows, error: merr }, { data: recent, error: rerr }] = await Promise.all([
    svc.from("vendor_item_mappings").select("id, vendor_id, vendor_sku, description_norm, pack_description, inventory_item_id").in("vendor_id", vendorIds).order("description_norm"),
    svc
      .from("quote_requests")
      .select("vendor_id, sent_at")
      .in("vendor_id", vendorIds)
      .in("status", ["sent", "replied", "no_reply"])
      .gte("sent_at", new Date(now.getTime() - QUOTE_REQUEST_COOLDOWN_DAYS * 86_400_000).toISOString()),
  ]);
  if (merr) throw new Error(`read vendor_item_mappings: ${merr.message}`);
  if (rerr) throw new Error(`read quote_requests: ${rerr.message}`);
  const mappings = mappingRows ?? [];
  const itemIds = [...new Set(mappings.map((m) => m.inventory_item_id))];
  const itemNames = new Map<string, string>();
  if (itemIds.length) {
    const { data: items } = await svc.from("inventory_items").select("id, name").in("id", itemIds);
    for (const it of items ?? []) itemNames.set(it.id, it.name);
  }
  const recentVendors = new Set((recent ?? []).map((r) => r.vendor_id));

  const results: QuoteRequestResult[] = [];
  for (const vendor of vendors) {
    const items = dedupeItems(
      mappings
        .filter((m) => m.vendor_id === vendor.id)
        .map((m) => ({
          mapping_id: m.id,
          inventory_item_id: m.inventory_item_id,
          inventory_item_name: itemNames.get(m.inventory_item_id) ?? null,
          vendor_sku: m.vendor_sku,
          description: m.description_norm.toUpperCase(),
          pack_description: m.pack_description,
        })),
    );
    // Only vendors we actually buy something from are asked; an explicitly named vendor still gets a (skipped) row.
    if (items.length === 0 && !opts.vendorId) continue;

    const token = dry ? quoteToken() : await uniqueToken(svc);
    const composed = composeQuoteRequest({ locationName: location.name, vendorName: vendor.name, items, token, replyTo: env.replyTo, ownerFirstName: tenant?.owner_first_name ?? null });
    const result: QuoteRequestResult = { vendorId: vendor.id, vendorName: vendor.name, to: vendor.contact_email, token, ...composed, items, sent: false, dry, skipped: null, requestId: null, resendMessageId: null, from: env.from, sender };

    if (items.length === 0) result.skipped = "no mappings";
    else if (!vendor.contact_email) result.skipped = "no contact_email";
    else if (recentVendors.has(vendor.id) && !opts.force) result.skipped = `requested within ${QUOTE_REQUEST_COOLDOWN_DAYS} days`;

    if (!result.skipped && !dry && !sender.ok) {
      // Held, not sent: nothing leaves from a domain that is not the restaurant's own verified one.
      const { data: row, error: berr } = await svc
        .from("quote_requests")
        .insert({ tenant_id: location.tenant_id, location_id: location.id, vendor_id: vendor.id, token, sent_at: now.toISOString(), items: items as unknown as Json, status: "blocked_sender", note: sender.reason })
        .select("id")
        .single();
      result.skipped = `blocked_sender: ${sender.reason}`;
      result.requestId = berr ? null : row.id;
    } else if (!result.skipped && !dry) {
      try {
        const messageId = await sendViaResend(env, { to: vendor.contact_email as string, subject: composed.subject, text: composed.text, token }, opts.fetchImpl);
        const { data: row, error: ierr } = await svc
          .from("quote_requests")
          .insert({
            tenant_id: location.tenant_id,
            location_id: location.id,
            vendor_id: vendor.id,
            token,
            sent_at: now.toISOString(),
            resend_message_id: messageId,
            items: items as unknown as Json,
            status: "sent",
          })
          .select("id")
          .single();
        if (ierr) throw new Error(`insert quote_requests: ${ierr.message}`);
        result.sent = true;
        result.requestId = row.id;
        result.resendMessageId = messageId;
        recentVendors.add(vendor.id);
      } catch (e) {
        result.skipped = `error: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    log("quote-request", { vendor: vendor.name, to: vendor.contact_email, from: env.from, token, items: items.length, dry, sent: result.sent, skipped: result.skipped });
    results.push(result);
  }
  return results;
}

/**
 * Price shock: any vendor supplying an ingredient whose 30-day price change in
 * verification_queue is ≥ 10% gets a request (cooldown applies, never forced).
 */
export async function requestsForPriceShock(opts: Omit<SendQuoteRequestsOptions, "vendorId" | "force">): Promise<QuoteRequestResult[]> {
  const svc = opts.svc ?? createServiceSupabase();
  const log = opts.log ?? (() => {});
  const { data: queue, error } = await svc.from("verification_queue").select("inventory_item_id, inventory_item_name, price_change_30d").eq("location_id", opts.locationId).gte("price_change_30d", PRICE_SHOCK_THRESHOLD);
  if (error) throw new Error(`read verification_queue: ${error.message}`);
  const itemIds = (queue ?? []).map((q) => q.inventory_item_id).filter((id): id is string => Boolean(id));
  if (itemIds.length === 0) return [];
  const { data: maps, error: merr } = await svc.from("vendor_item_mappings").select("vendor_id").in("inventory_item_id", itemIds);
  if (merr) throw new Error(`read vendor_item_mappings: ${merr.message}`);
  const vendorIds = [...new Set((maps ?? []).map((m) => m.vendor_id))];
  log("quote-request: price shock", { items: (queue ?? []).map((q) => `${q.inventory_item_name} ${Math.round((q.price_change_30d ?? 0) * 100)}%`), vendors: vendorIds.length });
  const out: QuoteRequestResult[] = [];
  for (const vendorId of vendorIds) out.push(...(await sendQuoteRequests({ ...opts, svc, vendorId, force: false })));
  return out;
}
