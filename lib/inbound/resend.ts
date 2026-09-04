import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { ServiceClient } from "@/lib/db/service";
import { createInvoiceDocument, runInvoicePipeline, type IntakeSource, type Logger } from "@/lib/jobs/intake";
import { normalizeMime } from "@/lib/llm/invoice-parse";
import { maxBytesFor } from "@/lib/storage";
import { extractEmail, forwardedSender, guessVendorFromSender, htmlToText, isForwardedSubject, isUsableAttachment, resolveInboundLocation } from "./shared";

/**
 * Resend inbound email (webhook `email.received`, Svix-signed). The route
 * verifies the signature and returns 200 immediately; `processResendEmail`
 * runs in `after()`: attachments are fetched through Resend's API, hashed and
 * handed to the same intake function every other channel uses, then parse →
 * map → post. Every delivery is recorded in inbound_events.
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
  /** GET /emails/receiving/{email_id} → { html, text } */
  getEmail: (emailId: string) => Promise<{ html?: string | null; text?: string | null }>;
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
};

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
    return { eventId, locationId: null, documents, errors: ["no location"] };
  }
  locationId = location.id;

  // Forwarded mail: recover the original sender from the body when we can.
  let emailFrom = senderRaw;
  let bodyText: string | null = null;
  if (forward) {
    try {
      const body = await api.getEmail(data.email_id);
      bodyText = body.text?.trim() || (body.html ? htmlToText(body.html) : null);
      emailFrom = forwardedSender(bodyText) ?? senderRaw;
    } catch (e) {
      errors.push(`body: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const source: IntakeSource = forward ? "forward" : "email";
  const vendorId = await guessVendorFromSender(svc, location.tenant_id, emailFrom);

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

  const eventId = await record({});
  log("resend: received", { emailId: data.email_id, location: location.name, from: emailFrom, source, subject: data.subject, attachments: usable.length, documents: documents.length, errors });

  if (opts.runPipeline !== false) {
    for (const d of documents.filter((d) => !d.duplicate)) {
      try {
        const r = await runInvoicePipeline(svc, d.documentId, { log });
        log("resend: pipeline done", { documentId: d.documentId, ...r });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log("resend: pipeline failed", { documentId: d.documentId, error: msg });
        if (eventId) await svc.from("inbound_events").update({ error: `pipeline: ${msg}` }).eq("id", eventId);
      }
    }
  }
  return { eventId, locationId, documents, errors };
}
