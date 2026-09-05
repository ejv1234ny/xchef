import { NextResponse, type NextRequest } from "next/server";
import { createApiDocument, createInvoiceDocument, runInvoicePipeline } from "@/lib/jobs/intake";
import { normalizeMime } from "@/lib/llm/invoice-parse";
import { INVOICE_MAX_BYTES, maxBytesFor, SPREADSHEET_MIME } from "@/lib/storage";
import { authenticateIntake, authenticateIntakeKey, errorResponse, INTAKE_KEY_HEADER, isResponse } from "../_auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const ACCEPTED = new Set(["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", ...SPREADSHEET_MIME]);

const log = (msg: string, meta?: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...meta }));

/**
 * POST multipart/form-data with `file`.
 *  - Session (cookie): invoice_documents (source 'upload') → parse → map → post.
 *  - `x-intake-key` header (vendor-portal pull): source 'api'; optional
 *    `x-vendor` and `x-invoice-number` headers let a second arrival of the same
 *    invoice attach as the clean copy of the paper document instead of
 *    creating a second one (lib/jobs/intake.ts createApiDocument). Response
 *    echoes { documentId, status, duplicate, attached?, attachedTo? }.
 */
export async function POST(request: NextRequest) {
  const auth = request.headers.has(INTAKE_KEY_HEADER) ? await authenticateIntakeKey(request) : await authenticateIntake();
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
    const filename = file.name || `upload.${mimeType.split("/")[1]}`;

    if (auth.viaKey) {
      const r = await createApiDocument(auth.svc, {
        locationId: auth.locationId,
        bytes,
        mimeType,
        filename,
        vendorName: request.headers.get("x-vendor"),
        invoiceNumber: request.headers.get("x-invoice-number"),
        log,
      });
      return NextResponse.json({
        documentId: r.documentId,
        status: r.status,
        duplicate: r.duplicate,
        ...(r.attached ? { attached: true as const, attachedTo: r.documentId, outcome: r.outcome } : {}),
        lines: r.lines,
        mapped: r.mapped,
        unmapped: r.unmapped,
      });
    }

    const created = await createInvoiceDocument(auth.svc, { locationId: auth.locationId, source: "upload", bytes, mimeType, filename });
    const result = await runInvoicePipeline(auth.svc, created.documentId, { log });
    return NextResponse.json({ documentId: created.documentId, status: result.status, duplicate: created.duplicate, lines: result.lines, mapped: result.mapped, unmapped: result.unmapped });
  } catch (e) {
    console.error("intake/upload failed", e);
    return errorResponse(e);
  }
}
