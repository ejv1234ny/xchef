import type { ServiceClient } from "@/lib/db/service";
import { emailDomain } from "@/lib/jobs/intake";

/**
 * Helpers shared by the inbound email routes (Resend, and Postmark while it is
 * still wired): address parsing, forward detection, HTML → text, location and
 * vendor resolution. Pure except the two DB lookups.
 */

export function extractEmail(s: string | undefined | null): string | null {
  if (!s) return null;
  const angle = s.match(/<([^>]+)>/);
  const m = (angle ? angle[1] : s).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
}

/** Fwd:/FW:/Fw: subject, or threading headers when the provider exposes them. */
export function isForwardedSubject(subject: string | undefined | null): boolean {
  return /^\s*(fwd?|fw)\s*:/i.test(subject ?? "");
}

/** First "From:" line inside a forwarded body, e.g. "From: Sysco Billing <ar@sysco.com>". */
export function forwardedSender(text: string | undefined | null): string | null {
  if (!text) return null;
  const m = text.match(/^\s*>?\s*\*?From:\*?\s*(.+)$/im);
  return extractEmail(m?.[1]) ?? null;
}

export function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** `invoices-<slug>@…` local parts found in a list of addresses (future per-location routing). */
export function slugsInAddresses(addresses: string[]): string[] {
  return addresses.flatMap((a) => [...a.matchAll(/invoices-([a-z0-9-]+)@/gi)].map((m) => m[1].toLowerCase()));
}

export type InboundLocation = { id: string; tenant_id: string; name: string };

/**
 * Location for an inbound email: a matching inbound_email_slug wins; otherwise
 * the single (first) location — one restaurant for now, per CLAUDE.md.
 */
export async function resolveInboundLocation(svc: ServiceClient, addresses: string[]): Promise<InboundLocation | null> {
  for (const slug of slugsInAddresses(addresses)) {
    const { data } = await svc.from("locations").select("id, tenant_id, name").eq("inbound_email_slug", slug).maybeSingle();
    if (data) return data;
  }
  const { data } = await svc.from("locations").select("id, tenant_id, name").order("created_at").limit(1);
  return data?.[0] ?? null;
}

/** Vendor whose email_domains contains the sender's domain. */
export async function guessVendorFromSender(svc: ServiceClient, tenantId: string, sender: string | null): Promise<string | null> {
  const domain = emailDomain(sender);
  if (!domain) return null;
  const { data } = await svc.from("vendors").select("id").eq("tenant_id", tenantId).contains("email_domains", [domain]).limit(1);
  return data?.[0]?.id ?? null;
}

/** Attachment types the pipeline can parse (mirrors the upload validator). */
export const INBOUND_ATTACHMENT_EXTS = new Set(["pdf", "jpg", "jpeg", "png", "heic", "heif", "webp", "csv", "tsv", "xlsx", "xls"]);

export function isUsableAttachment(filename: string | undefined | null, contentType: string | undefined | null): boolean {
  const ext = (filename ?? "").toLowerCase().split(".").pop() ?? "";
  if (INBOUND_ATTACHMENT_EXTS.has(ext)) return true;
  const ct = (contentType ?? "").toLowerCase().split(";")[0].trim();
  return [
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/heic",
    "image/heif",
    "image/webp",
    "text/csv",
    "text/tab-separated-values",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-excel",
  ].includes(ct);
}
