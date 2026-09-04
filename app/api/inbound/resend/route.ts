import { after, NextResponse, type NextRequest } from "next/server";
import { createServiceSupabase } from "@/lib/db/service";
import { env } from "@/lib/env";
import { processResendEmail, resendApi, ResendEvent, ResendReceivedData, verifySvixSignature } from "@/lib/inbound/resend";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BODY_CAP = 2 * 1024 * 1024; // Resend sends metadata only; attachments are fetched via the API

/**
 * Resend inbound webhook (CLAUDE.md rules 9–11). Svix signature verified with
 * RESEND_WEBHOOK_SECRET (401 on failure); only `email.received` is handled,
 * everything else is acknowledged with 200. The response is sent immediately
 * and attachment fetching + parsing run in `after()`.
 */
export async function POST(request: NextRequest) {
  if (!env.has("RESEND_WEBHOOK_SECRET")) return NextResponse.json({ error: "inbound not configured" }, { status: 503 });
  const rawBody = await request.text();
  if (rawBody.length > BODY_CAP) return NextResponse.json({ error: "body too large" }, { status: 413 });

  const verdict = verifySvixSignature(
    rawBody,
    { id: request.headers.get("svix-id"), timestamp: request.headers.get("svix-timestamp"), signature: request.headers.get("svix-signature") },
    process.env.RESEND_WEBHOOK_SECRET!,
  );
  if (!verdict.ok) {
    console.warn(JSON.stringify({ msg: "resend: bad signature", reason: verdict.reason }));
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  let event: unknown;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: true, skipped: "not json" });
  }
  const parsed = ResendEvent.safeParse(event);
  if (!parsed.success) return NextResponse.json({ ok: true, skipped: "unrecognized payload" });
  if (parsed.data.type !== "email.received") return NextResponse.json({ ok: true, skipped: parsed.data.type });

  const data = ResendReceivedData.safeParse(parsed.data.data);
  if (!data.success) {
    console.warn(JSON.stringify({ msg: "resend: email.received failed validation", issues: data.error.issues.slice(0, 5) }));
    return NextResponse.json({ ok: true, skipped: "invalid email.received data" });
  }

  const svc = createServiceSupabase();
  const log = (msg: string, meta?: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...meta }));
  after(async () => {
    try {
      if (!env.has("RESEND_API_KEY")) {
        await svc.from("inbound_events").insert({ provider: "resend", event_type: "email.received", email_id: data.data.email_id, message_id: data.data.message_id ?? null, from_address: data.data.from ?? null, to_addresses: data.data.to ?? [], subject: data.data.subject ?? null, attachment_count: (data.data.attachments ?? []).length, error: "RESEND_API_KEY not configured" });
        return;
      }
      await processResendEmail(svc, resendApi(process.env.RESEND_API_KEY!), data.data, { log });
    } catch (e) {
      console.error("resend: processing failed", e);
    }
  });
  return NextResponse.json({ ok: true, email_id: data.data.email_id });
}
