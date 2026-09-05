import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ServiceClient } from "@/lib/db/service";
import { createInvoiceDocument, runInvoicePipeline, type IntakeSource, type Logger } from "@/lib/jobs/intake";
import { findQuoteRequestByToken, ingestQuoteDocument, isQuoteDocument, markQuoteDocuments } from "@/lib/jobs/quoteIngest";
import { extractQuoteToken } from "@/lib/core/quotes";
import { normalizeMime } from "@/lib/llm/invoice-parse";
import { maxBytesFor } from "@/lib/storage";
import { extractEmail, forwardedSender, guessVendorFromSender, htmlToText, isForwardedSubject, isUsableAttachment, resolveInboundLocation } from "./shared";

/**
 * Resend inbound email (webhook `email.received`, Svix-signed). The route
 * verifies the signature and returns 200 immediately; `processResendEmail`
 * runs in `after()`: attachments are fetched through Resend's API, hashed and
 * handed to the same intake function every other channel uses, then parse →
 * map → post. Every delivery is recorded in inbound_events.
 *
 * Quote replies (KICKOFF-2 Part 3): a message whose subject — or, for a
 * "Re:" reply, whose body / In-Reply-To — carries a [Q-…] token is a vendor's
 * answer to a pricing request. Its documents are flagged document_kind =
 * 'quote' and linked to the quote_requests row before parsing, and after the
 * pipeline their mapped lines are written to vendor_quotes (never purchases).
 * A price list that arrives without a token is caught the same way when the
 * parser itself says document_kind = 'quote'.
 */

// ---- Svix signature ---------------------------------------------------------

const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

export type SvixHeaders = { id: string | null; timestamp: string | null; signature: string | null };

/**
 * Manual Svix verification: HMAC-SHA256 over `${id}.${timestamp}.${body}` with
 * the base64-decoded secret (after the `whsec_` prefix); header carries one
 * or more `v1,<base64>` entries. Rejects timestamps outside ±5 minutes.
 */
export function verifySvixSignature(rawBody: string, headers: SvixHeaders, secret: string, now = Date.now()): { ok: true } | { ok: false; reason: string } {
  if (!headers.id || !headers.timestamp || !headers.signature) return { ok: false, reason: "missing svix headers" };
  const ts = Number(headers.timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: "bad timestamp" };
  if (Math.abs(now / 1000 - ts) > SIGNATURE_TOLERANCE_SECONDS) return { ok: false, reason: "timestamp outside tolerance" };
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  if (key.length === 0) return { ok: false, reason: "bad secret" };
  const expected = createHmac("sha256", key).update(`${headers.id}.${headers.timestamp}.${rawBody}`).digest();
  for (const part of headers.signature.split(/\s+/)) {
    const [version, sig] = part.split(",");
    if (version !== "v1" || !sig) continue;
    const given = Buffer.from(sig, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "signature mismatch" };
}

/** Test helper / local tooling: produce a valid signature header for a body. */
export function signSvix(rawBody: string, secret: string, id = "msg_test", timestamp = Math.floor(Date.now() / 1000)): Required<SvixHeaders> {
  const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const sig = createHmac("sha256", key).update(`${id}.${timestamp}.${rawBody}`).digest("base64");
  return { id, timestamp: String(timestamp), signature: `v1,${sig}` };
}

// ---- Payload -------------------------------------------------------------------

export const ResendAttachmentRef = z.looseObject({
  id: z.string(),
  filename: z.string().nullish(),
  content_type: z.string().nullish(),
  content_disposition: z.string().nullish(),
});

export const ResendReceivedData = z.looseObject({
  email_id: z.string(),
  from: z.string().nullish(),
  to: z.array(z.string()).nullish(),
  cc: z.array(z.string()).nullish(),
  subject: z.string().nullish(),
  message_id: z.string().nullish(),
  attachments: z.array(ResendAttachmentRef).nullish(),
});

export const ResendEvent = z.looseObject({
  type: z.string(),
  created_at: z.string().nullish(),
  data: z.unknown().optional(),
});

export type ResendReceived = z.infer<typeof ResendReceivedData>;

// ---- Resend API -----------------------------------------------------------------

export type ResendApi = {
  /** GET /emails/receiving/{email_id}/attachments/{attachment_id} → { download_url, filename, content_type } */
  getAttachment: (emailId: string, attachmentId: string) => Promise<{ download_url: string; filename?: string | null; content_type?: string | null }>;
  /** GET /emails/receiving/{email_id} → { html, text, headers? } (headers when Resend exposes them; In-Reply-To is read from there) */
  getEmail: (emailId: string) => Promise<{ html?: string | null; text?: string | null; headers?: Array<{ name: string; value: string }> | Record<string, string> | null; in_reply_to?: string | null }>;
  /** fetch an attachment's bytes from its download_url */
  download: (url: string) => Promise<Uint8Array>;
};

const RESEND_BASE = "https://api.resend.com";

export function resendApi(apiKey: string, fetchImpl: typeof fetch = fetch): ResendApi {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const json = async <T>(path: string): Promise<T> => {
    const res = await fetchImpl(`${RESEND_BASE}${path}`, { headers });
    if (!res.ok) throw new Error(`Resend GET ${path}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  };
  return {
    getAttachment: (emailId, attachmentId) => json(`/emails/receiving/${encodeURIComponent(emailId)}/attachments/${encodeURIComponent(attachmentId)}`),
    getEmail: (emailId) => json(`/emails/receiving/${encodeURIComponent(emailId)}`),
    download: async (url) => {
      const res = await fetchImpl(url);
      if (!res.ok) throw new Error(`download ${res.status}`);
      return new Uint8Array(await res.arrayBuffer());
    },
  };
}

// ---- Processing ----------------------------------------------------------------

export type ProcessResult = {
  eventId: string | null;
  locationId: string | null;
  documents: Array<{ documentId: string; duplicate: boolean; name: string }>;
  errors: string[];
  /** [Q-…] token found on the message, when it is a quote reply */
  quoteToken: string | null;
};

/** "Re:", "RE:", "AW:" (German clients), "SV:" — a reply, where the token may live only in the quoted body. */
export function isReplySubject(subject: string | undefined | null): boolean {
  return /^\s*(re|aw|sv|antw)\s*:/i.test(subject ?? "");
}

/** In-Reply-To header from the shapes Resend may return. */
export function inReplyToOf(email: { headers?: Array<{ name: string; value: string }> | Record<string, string> | null; in_reply_to?: string | null }): string | null {
  if (email.in_reply_to) return email.in_reply_to;
  const h = email.headers;
  if (!h) return null;
  if (Array.isArray(h)) return h.find((x) => x.name.toLowerCase() === "in-reply-to")?.value ?? null;
  const key = Object.keys(h).find((k) => k.toLowerCase() === "in-reply-to");
  return key ? h[key] : null;
}

/**
 * Handle one `email.received`. Records an inbound_events row no matter what
 * happens, creates documents through createInvoiceDocument (dedupe on
 * content_hash / message_id), then runs the pipeline for fresh ones.
 */
export async function processResendEmail(svc: ServiceClient, api: ResendApi, data: ResendReceived, opts: { log?: Logger; runPipeline?: boolean } = {}): Promise<ProcessResult> {
  const log = opts.log ?? (() => {});
  const to = [...(data.to ?? []), ...(data.cc ?? [])];
  const senderRaw = extractEmail(data.from);
  const forward = isForwardedSubject(data.subject);
  const documents: ProcessResult["documents"] = [];
  const errors: string[] = [];
  let locationId: string | null = null;

  const record = async (extra: { error?: string | null }) => {
    const { data: ev } = await svc
      .from("inbound_events")
      .insert({
        location_id: locationId,
        provider: "resend",
        event_type: "email.received",
        email_id: data.email_id,
        message_id: data.message_id ?? null,
        from_address: senderRaw ?? data.from ?? null,
        to_addresses: to,
        subject: data.subject ?? null,
        attachment_count: (data.attachments ?? []).length,
        documents_created: documents.filter((d) => !d.duplicate).length,
        document_ids: documents.map((d) => d.documentId),
        error: extra.error ?? (errors.length ? errors.join("; ") : null),
      })
      .select("id")
      .single();
    return ev?.id ?? null;
  };

  const location = await resolveInboundLocation(svc, to);
  if (!location) {
    log("resend: no location", { to, emailId: data.email_id });
    const eventId = await record({ error: "no location for address" });
    return { eventId, locationId: null, documents, errors: ["no location"], quoteToken: null };
  }
  locationId = location.id;

  // Quote reply? The token is normally in the subject; for a "Re:" without one, look in the body / In-Reply-To.
  let quoteToken = extractQuoteToken(data.subject);
  let emailFrom = senderRaw;
  let bodyText: string | null = null;
  const needBody = forward || (!quoteToken && isReplySubject(data.subject));
  if (needBody) {
    try {
      const body = await api.getEmail(data.email_id);
      bodyText = body.text?.trim() || (body.html ? htmlToText(body.html) : null);
      // Forwarded mail: recover the original sender from the body when we can.
      if (forward) emailFrom = forwardedSender(bodyText) ?? senderRaw;
      if (!quoteToken) {
        quoteToken = extractQuoteToken(bodyText);
        const inReplyTo = inReplyToOf(body);
        if (!quoteToken && inReplyTo) {
          // Resend's Message-ID for a sent email carries its id: <{resend_message_id}@…>
          const idPart = inReplyTo.replace(/^\s*<|>\s*$/g, "").split("@")[0];
          if (idPart) {
            const { data: req } = await svc.from("quote_requests").select("token").eq("resend_message_id", idPart).maybeSingle();
            quoteToken = req?.token ?? null;
          }
        }
      }
    } catch (e) {
      errors.push(`body: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const quoteRequest = quoteToken ? await findQuoteRequestByToken(svc, quoteToken).catch(() => null) : null;
  const source: IntakeSource = forward ? "forward" : "email";
  const vendorId = (await guessVendorFromSender(svc, location.tenant_id, emailFrom)) ?? quoteRequest?.vendor_id ?? null;

  const usable = (data.attachments ?? []).filter((a) => isUsableAttachment(a.filename, a.content_type));
  for (const a of usable) {
    const name = a.filename || `attachment-${a.id}`;
    try {
      const meta = await api.getAttachment(data.email_id, a.id);
      const bytes = await api.download(meta.download_url);
      const mimeType = normalizeMime(meta.content_type ?? a.content_type ?? "", meta.filename ?? name);
      if (bytes.byteLength === 0) {
        errors.push(`${name}: empty`);
        continue;
      }
      if (bytes.byteLength > maxBytesFor(mimeType)) {
        errors.push(`${name}: over ${maxBytesFor(mimeType) / 1048576} MB`);
        continue;
      }
      const doc = await createInvoiceDocument(svc, {
        locationId: location.id,
        source,
        bytes,
        mimeType,
        filename: meta.filename ?? name,
        emailFrom,
        emailSubject: data.subject ?? null,
        emailMessageId: data.message_id ?? null,
        vendorId,
      });
      documents.push({ ...doc, name });
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  if (usable.length === 0) {
    try {
      if (bodyText == null) {
        const body = await api.getEmail(data.email_id);
        bodyText = body.text?.trim() || (body.html ? htmlToText(body.html) : null);
      }
      if (bodyText && bodyText.length >= 20) {
        const doc = await createInvoiceDocument(svc, {
          locationId: location.id,
          source,
          text: bodyText,
          mimeType: "text/plain",
          filename: `email-${data.email_id.replace(/[^a-z0-9-]/gi, "").slice(0, 40)}.txt`,
          emailFrom,
          emailSubject: data.subject ?? null,
          emailMessageId: data.message_id ?? null,
          vendorId,
        });
        documents.push({ ...doc, name: "body" });
      } else {
        errors.push("no usable attachment and no body text");
      }
    } catch (e) {
      errors.push(`body: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const fresh = documents.filter((d) => !d.duplicate).map((d) => d.documentId);
  if (quoteToken && fresh.length) {
    try {
      await markQuoteDocuments(svc, fresh, quoteToken, log);
    } catch (e) {
      errors.push(`quote: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const eventId = await record({});
  log("resend: received", { emailId: data.email_id, location: location.name, from: emailFrom, source, subject: data.subject, quoteToken, attachments: usable.length, documents: documents.length, errors });

  if (opts.runPipeline !== false) {
    for (const d of documents.filter((d) => !d.duplicate)) {
      try {
        const r = await runInvoicePipeline(svc, d.documentId, { log });
        log("resend: pipeline done", { documentId: d.documentId, ...r });
        // Quote replies (token) and unsolicited price lists (parser said 'quote'): mapped lines → vendor_quotes.
        if (r.status !== "deleted" && (quoteToken || (await isQuoteDocument(svc, d.documentId)))) {
          const q = await ingestQuoteDocument(svc, d.documentId, { log });
          log("resend: quote ingested", { documentId: d.documentId, quotes: q.reduce((a, x) => a + x.quotes, 0), documents: q.length });
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log("resend: pipeline failed", { documentId: d.documentId, error: msg });
        if (eventId) await svc.from("inbound_events").update({ error: `pipeline: ${msg}` }).eq("id", eventId);
      }
    }
  }
  return { eventId, locationId, documents, errors, quoteToken };
}
