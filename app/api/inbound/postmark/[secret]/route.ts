import { after, NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { env } from "@/lib/env";
import { createServiceSupabase, type ServiceClient } from "@/lib/db/service";
import { createInvoiceDocument, emailDomain, runInvoicePipeline, type IntakeSource } from "@/lib/jobs/intake";
import { normalizeMime } from "@/lib/llm/invoice-parse";
import { maxBytesFor, SPREADSHEET_MIME } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Postmark inbound webhook (CLAUDE.md rules 10–11). Secret in the path,
 * Postmark IP allowlist, body cap; ALWAYS returns 200 fast and never bounces.
 * Parsing runs in `after()` once the response has been sent.
 *
 * Location: the `invoices-<slug>@` address in To/Cc → locations.inbound_email_slug,
 * else the first location (single-tenant build). Forwards (Fwd: subject or
 * In-Reply-To/References header) recover the original sender from the first
 * "From:" line of the body → source 'forward'.
 */
const BODY_CAP = 30 * 1024 * 1024;

/** Postmark's published inbound webhook source IPs (override with POSTMARK_IP_ALLOWLIST="a,b" or "*"). */
const POSTMARK_IPS = ["3.134.147.250", "50.31.156.6", "50.31.156.77", "18.217.206.57"];

const Header = z.looseObject({ Name: z.string(), Value: z.string() });
const Attachment = z.looseObject({ Name: z.string(), Content: z.string(), ContentType: z.string(), ContentLength: z.number().optional() });
const Address = z.looseObject({ Email: z.string().optional(), Name: z.string().optional() });

const PostmarkInbound = z.looseObject({
  From: z.string().optional(),
  FromFull: Address.optional(),
  To: z.string().optional(),
  ToFull: z.array(Address).optional(),
  Cc: z.string().optional(),
  CcFull: z.array(Address).optional(),
  Subject: z.string().optional(),
  MessageID: z.string().optional(),
  Date: z.string().optional(),
  TextBody: z.string().optional(),
  HtmlBody: z.string().optional(),
  Headers: z.array(Header).optional(),
  Attachments: z.array(Attachment).optional(),
});
type Inbound = z.infer<typeof PostmarkInbound>;

const ok = (body: Record<string, unknown>) => NextResponse.json({ ok: true, ...body }, { status: 200 });

function clientIp(request: NextRequest): string | null {
  const xff = request.headers.get("x-forwarded-for");
  return xff?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || null;
}

function ipAllowed(request: NextRequest): boolean {
  const override = process.env.POSTMARK_IP_ALLOWLIST;
  if (override === "*") return true;
  if (process.env.NODE_ENV !== "production" && !override) return true;
  const list = override ? override.split(",").map((s) => s.trim()).filter(Boolean) : POSTMARK_IPS;
  const ip = clientIp(request);
  return Boolean(ip && list.includes(ip));
}

function extractEmail(s: string | undefined | null): string | null {
  if (!s) return null;
  const angle = s.match(/<([^>]+)>/);
  const m = (angle ? angle[1] : s).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return m ? m[0].toLowerCase() : null;
}

function isForward(mail: Inbound): boolean {
  if (/^\s*(fwd?|fw)\s*:/i.test(mail.Subject ?? "")) return true;
  const names = new Set((mail.Headers ?? []).map((h) => h.Name.toLowerCase()));
  return names.has("in-reply-to") || names.has("references") || names.has("x-forwarded-message-id");
}

/** First "From:" line inside a forwarded body, e.g. "From: Sysco Billing <ar@sysco.com>". */
function forwardedSender(text: string | undefined): string | null {
  if (!text) return null;
  const m = text.match(/^\s*>?\s*\*?From:\*?\s*(.+)$/im);
  return extractEmail(m?.[1]) ?? null;
}

function slugsIn(mail: Inbound): string[] {
  const addrs = [mail.To ?? "", mail.Cc ?? "", ...(mail.ToFull ?? []).map((a) => a.Email ?? ""), ...(mail.CcFull ?? []).map((a) => a.Email ?? "")].join(" ");
  return [...addrs.matchAll(/invoices-([a-z0-9-]+)@/gi)].map((m) => m[1].toLowerCase());
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|tr|li|h\d)>/gi, "\n")
    .replace(/<\/t[dh]>/gi, "\t")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const DOC_MIMES = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", ...SPREADSHEET_MIME]);

async function resolveLocation(svc: ServiceClient, mail: Inbound): Promise<{ id: string; tenant_id: string; name: string } | null> {
  for (const slug of slugsIn(mail)) {
    const { data } = await svc.from("locations").select("id, tenant_id, name").eq("inbound_email_slug", slug).maybeSingle();
    if (data) return data;
  }
  const { data } = await svc.from("locations").select("id, tenant_id, name").order("created_at").limit(1);
  return data?.[0] ?? null;
}

async function guessVendor(svc: ServiceClient, tenantId: string, sender: string | null): Promise<string | null> {
  const domain = emailDomain(sender);
  if (!domain) return null;
  const { data } = await svc.from("vendors").select("id").eq("tenant_id", tenantId).contains("email_domains", [domain]).limit(1);
  return data?.[0]?.id ?? null;
}

export async function POST(request: NextRequest, ctx: RouteContext<"/api/inbound/postmark/[secret]">) {
  const { secret } = await ctx.params;
  if (!env.has("POSTMARK_INBOUND_SECRET") || secret !== env.postmarkInboundSecret()) return new NextResponse(null, { status: 404 });
  if (!ipAllowed(request)) {
    console.warn(JSON.stringify({ msg: "postmark: ip not allowed", ip: clientIp(request) }));
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (declared > BODY_CAP) return ok({ skipped: "body too large" });

  const rawText = await request.text();
  if (rawText.length > BODY_CAP) return ok({ skipped: "body too large" });
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    console.warn("postmark: body is not JSON");
    return ok({ skipped: "not json" });
  }
  const parsed = PostmarkInbound.safeParse(json);
  if (!parsed.success) {
    console.warn(JSON.stringify({ msg: "postmark: payload failed validation", issues: parsed.error.issues.slice(0, 5) }));
    return ok({ skipped: "invalid payload" });
  }
  const mail = parsed.data;

  const svc = createServiceSupabase();
  const location = await resolveLocation(svc, mail);
  if (!location) {
    console.warn(JSON.stringify({ msg: "postmark: no location for address", to: mail.To, messageId: mail.MessageID }));
    return ok({ skipped: "unknown location" });
  }

  const forward = isForward(mail);
  const senderRaw = mail.FromFull?.Email ?? extractEmail(mail.From);
  const originalSender = forward ? (forwardedSender(mail.TextBody) ?? forwardedSender(mail.HtmlBody ? htmlToText(mail.HtmlBody) : undefined)) : null;
  const emailFrom = (originalSender ?? senderRaw ?? null)?.toLowerCase() ?? null;
  const source: IntakeSource = forward ? "forward" : "email";
  const vendorId = await guessVendor(svc, location.tenant_id, emailFrom);

  const created: Array<{ documentId: string; duplicate: boolean; name: string }> = [];
  const errors: string[] = [];
  const attachments = (mail.Attachments ?? []).filter((a) => DOC_MIMES.has(normalizeMime(a.ContentType, a.Name)));
  for (const a of attachments) {
    try {
      const bytes = new Uint8Array(Buffer.from(a.Content, "base64"));
      if (bytes.byteLength === 0) continue;
      const cap = maxBytesFor(normalizeMime(a.ContentType, a.Name));
      if (bytes.byteLength > cap) {
        errors.push(`${a.Name}: over ${cap / 1024 / 1024} MB`);
        continue;
      }
      const doc = await createInvoiceDocument(svc, {
        locationId: location.id,
        source,
        bytes,
        mimeType: normalizeMime(a.ContentType, a.Name),
        filename: a.Name || "attachment",
        emailFrom,
        emailSubject: mail.Subject ?? null,
        emailMessageId: mail.MessageID ?? null,
        vendorId,
      });
      created.push({ ...doc, name: a.Name });
    } catch (e) {
      errors.push(`${a.Name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (attachments.length === 0) {
    const text = (mail.TextBody ?? "").trim() || (mail.HtmlBody ? htmlToText(mail.HtmlBody) : "");
    if (text.length >= 20) {
      try {
        const doc = await createInvoiceDocument(svc, {
          locationId: location.id,
          source,
          text,
          mimeType: "text/plain",
          filename: `email-${(mail.MessageID ?? Date.now().toString()).replace(/[^a-z0-9-]/gi, "").slice(0, 40)}.txt`,
          emailFrom,
          emailSubject: mail.Subject ?? null,
          emailMessageId: mail.MessageID ?? null,
          vendorId,
        });
        created.push({ ...doc, name: "body" });
      } catch (e) {
        errors.push(`body: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  const fresh = created.filter((c) => !c.duplicate).map((c) => c.documentId);
  console.log(JSON.stringify({ msg: "postmark: received", location: location.name, from: emailFrom, source, subject: mail.Subject, messageId: mail.MessageID, documents: created.length, fresh: fresh.length, errors }));

  if (fresh.length) {
    after(async () => {
      for (const id of fresh) {
        try {
          const r = await runInvoicePipeline(svc, id, { log: (msg, meta) => console.log(JSON.stringify({ msg, ...meta })) });
          console.log(JSON.stringify({ msg: "postmark: pipeline done", documentId: id, ...r }));
        } catch (e) {
          console.error("postmark: pipeline failed", id, e);
        }
      }
    });
  }
  return ok({ documents: created.map((c) => ({ documentId: c.documentId, duplicate: c.duplicate, name: c.name })), errors });
}
