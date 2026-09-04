import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { createInvoiceDocument, runInvoicePipeline } from "@/lib/jobs/intake";
import { authenticateIntake, errorResponse, isResponse } from "../_auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const Body = z.object({ text: z.string().trim().min(20, "paste the invoice text (at least 20 characters)").max(200_000) });

/** POST JSON { text } → text document (source 'paste') → parse → map → post. */
export async function POST(request: NextRequest) {
  const auth = await authenticateIntake();
  if (isResponse(auth)) return auth;
  try {
    const parsed = Body.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "invalid body" }, { status: 400 });
    const created = await createInvoiceDocument(auth.svc, {
      locationId: auth.locationId,
      source: "paste",
      text: parsed.data.text,
      mimeType: "text/plain",
      filename: `paste-${new Date().toISOString().slice(0, 10)}.txt`,
    });
    const result = await runInvoicePipeline(auth.svc, created.documentId, { log: (msg, meta) => console.log(JSON.stringify({ msg, ...meta })) });
    return NextResponse.json({ documentId: created.documentId, status: result.status, duplicate: created.duplicate, lines: result.lines, mapped: result.mapped, unmapped: result.unmapped });
  } catch (e) {
    console.error("intake/paste failed", e);
    return errorResponse(e);
  }
}
