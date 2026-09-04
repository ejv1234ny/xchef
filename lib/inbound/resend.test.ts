import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { config } from "dotenv";
import { processResendEmail, ResendEvent, ResendReceivedData, signSvix, verifySvixSignature, type ResendApi } from "./resend";
import { forwardedSender, htmlToText, isForwardedSubject, isUsableAttachment } from "./shared";

config({ path: path.resolve(__dirname, "../../.env.local"), quiet: true });

const fixture = JSON.parse(readFileSync(path.join(__dirname, "../../fixtures/resend/email-received.json"), "utf8"));
const SECRET = "whsec_" + Buffer.from("test-secret-please-ignore").toString("base64");

describe("Svix signature", () => {
  const body = JSON.stringify(fixture);
  it("accepts a valid v1 signature within tolerance", () => {
    const h = signSvix(body, SECRET, "msg_1");
    expect(verifySvixSignature(body, h, SECRET)).toEqual({ ok: true });
  });
  it("accepts when one of several v1 entries matches", () => {
    const h = signSvix(body, SECRET, "msg_1");
    expect(verifySvixSignature(body, { ...h, signature: `v1,AAAA ${h.signature}` }, SECRET)).toEqual({ ok: true });
  });
  it("rejects a tampered body, a wrong secret, missing headers and stale timestamps", () => {
    const h = signSvix(body, SECRET, "msg_1");
    expect(verifySvixSignature(body + " ", h, SECRET).ok).toBe(false);
    expect(verifySvixSignature(body, h, "whsec_" + Buffer.from("other").toString("base64")).ok).toBe(false);
    expect(verifySvixSignature(body, { id: null, timestamp: h.timestamp, signature: h.signature }, SECRET)).toEqual({ ok: false, reason: "missing svix headers" });
    const old = signSvix(body, SECRET, "msg_1", Math.floor(Date.now() / 1000) - 600);
    expect(verifySvixSignature(body, old, SECRET)).toEqual({ ok: false, reason: "timestamp outside tolerance" });
  });
});

describe("payload + helpers", () => {
  it("parses the email.received fixture", () => {
    const ev = ResendEvent.parse(fixture);
    expect(ev.type).toBe("email.received");
    const data = ResendReceivedData.parse(ev.data);
    expect(data.email_id).toBe("re_test_fixture_0001");
    expect(data.attachments).toHaveLength(2);
  });
  it("keeps invoice-like attachments and drops inline images", () => {
    expect(isUsableAttachment("synthetic-rd-receipt.csv", "text/csv")).toBe(true);
    expect(isUsableAttachment("scan.HEIC", "application/octet-stream")).toBe(true);
    expect(isUsableAttachment("logo.gif", "image/gif")).toBe(false);
  });
  it("detects forwards and recovers the original sender", () => {
    expect(isForwardedSubject("Fwd: Invoice 123")).toBe(true);
    expect(isForwardedSubject("FW: Invoice 123")).toBe(true);
    expect(isForwardedSubject("Invoice 123")).toBe(false);
    expect(forwardedSender("---------- Forwarded message ---------\nFrom: Sysco AR <ar@sysco.com>\nDate: Mon")).toBe("ar@sysco.com");
    expect(htmlToText("<p>From: <b>Sysco</b> &lt;ar@sysco.com&gt;</p>")).toContain("ar@sysco.com");
  });
});

const hasDb = Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.NEXT_PUBLIC_SUPABASE_URL);

describe.skipIf(!hasDb)("processResendEmail against xchef-dev (mocked Resend API)", () => {
  it("creates one invoice_documents row and one inbound_events row", async () => {
    const { createServiceSupabase } = await import("@/lib/db/service");
    const svc = createServiceSupabase();
    const csv = readFileSync(path.join(__dirname, "../../fixtures/invoices/synthetic-rd-receipt.csv"));
    // Unique content per run so dedupe does not turn this into a duplicate on re-runs.
    const stamp = `,,,,\n# test-run ${Date.now()}\n`;
    const bytes = new Uint8Array(Buffer.concat([csv, Buffer.from(stamp)]));
    const calls: string[] = [];
    const api: ResendApi = {
      getAttachment: async (emailId, attachmentId) => {
        calls.push(`attachment:${emailId}:${attachmentId}`);
        return { download_url: "https://example.invalid/att", filename: "synthetic-rd-receipt.csv", content_type: "text/csv" };
      },
      getEmail: async (emailId) => {
        calls.push(`email:${emailId}`);
        return { html: "<p>see attached</p>", text: "see attached" };
      },
      download: async () => bytes,
    };
    const data = ResendReceivedData.parse({ ...fixture.data, email_id: `re_test_${Date.now()}`, message_id: `<fixture-${Date.now()}@restaurantdepot.com>` });
    const result = await processResendEmail(svc, api, data, { runPipeline: false });

    expect(result.errors).toEqual([]);
    expect(result.documents).toHaveLength(1); // the gif was skipped
    expect(result.documents[0].duplicate).toBe(false);
    expect(calls).toEqual([`attachment:${data.email_id}:att_fixture_0001`]); // not a forward → body not fetched

    const { data: doc } = await svc.from("invoice_documents").select("id, source, status, email_from, email_message_id, storage_path").eq("id", result.documents[0].documentId).single();
    expect(doc?.source).toBe("email");
    expect(doc?.status).toBe("received");
    expect(doc?.email_from).toBe("receipts@restaurantdepot.com");
    expect(doc?.email_message_id).toBe(data.message_id);
    expect(doc?.storage_path.endsWith(".csv")).toBe(true);

    const { data: ev } = await svc.from("inbound_events").select("*").eq("id", result.eventId!).single();
    expect(ev?.provider).toBe("resend");
    expect(ev?.event_type).toBe("email.received");
    expect(ev?.email_id).toBe(data.email_id);
    expect(ev?.attachment_count).toBe(2);
    expect(ev?.documents_created).toBe(1);
    expect(ev?.document_ids).toEqual([result.documents[0].documentId]);
    expect(ev?.error).toBeNull();

    // cleanup so the test data does not accumulate as invoices
    await svc.from("invoice_documents").delete().eq("id", result.documents[0].documentId);
    await svc.from("inbound_events").delete().eq("id", result.eventId!);
  }, 30_000);
});
