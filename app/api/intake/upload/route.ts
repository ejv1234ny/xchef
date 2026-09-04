import { NextResponse, type NextRequest } from "next/server";
import { createInvoiceDocument, runInvoicePipeline } from "@/lib/jobs/intake";
import { normalizeMime } from "@/lib/llm/invoice-parse";
import { INVOICE_MAX_BYTES, maxBytesFor, SPREADSHEET_MIME } from "@/lib/storage";
import { authenticateIntake, errorResponse, isResponse } from "../_auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ACCEPTED = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", ...SPREADSHEET_MIME]);

/** POST multipart/form-data with `file` → invoice_documents (source 'upload') → parse → map → post. */
export async function POST(request: NextRequest) {
  const auth = await authenticateIntake();
  if (isResponse(auth)) return auth;
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) return NextResponse.json({ error: "multipart field `file` is required" }, { status: 400 });
    if (file.size === 0) return NextResponse.json({ error: "empty file" }, { status: 400 });
    if (file.size > INVOICE_MAX_BYTES) return NextResponse.json({ error: `file exceeds ${INVOICE_MAX_BYTES / 1024 / 1024} MB` }, { status: 413 });
    const mimeType = normalizeMime(file.type, file.name);
    if (!ACCEPTED.has(mimeType)) return NextResponse.json({ error: `unsupported type ${mimeType}; send a PDF, JPEG, PNG, HEIC, WebP, CSV, TSV, XLSX or XLS` }, { status: 415 });
    if (file.size > maxBytesFor(mimeType)) return NextResponse.json({ error: `spreadsheets are limited to ${maxBytesFor(mimeType) / 1024 / 1024} MB` }, { status: 413 });

    const bytes = new Uint8Array(await file.arrayBuffer());
    const created = await createInvoiceDocument(auth.svc, { locationId: auth.locationId, source: "upload", bytes, mimeType, filename: file.name || `upload.${mimeType.split("/")[1]}` });
    const result = await runInvoicePipeline(auth.svc, created.documentId, { log: (msg, meta) => console.log(JSON.stringify({ msg, ...meta })) });
    return NextResponse.json({ documentId: created.documentId, status: result.status, duplicate: created.duplicate, lines: result.lines, mapped: result.mapped, unmapped: result.unmapped });
  } catch (e) {
    console.error("intake/upload failed", e);
    return errorResponse(e);
  }
}
