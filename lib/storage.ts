import type { ServiceClient } from "@/lib/db/service";
import { renderPdfFirstPage } from "@/lib/pdf-preview";

/**
 * Supabase Storage for invoice files (private bucket `invoices`).
 *
 * Path convention — decided here, used everywhere:
 *   `invoice_documents.storage_path` is the OBJECT KEY INSIDE THE `invoices`
 *   BUCKET, with no bucket prefix:
 *       <locationId>/<yyyy>/<mm>/<sha256>.<ext>      real files (email/forward/upload/paste)
 *       manual/<uuid>.json                            manual intake (lines JSON, for audit)
 *   The full reference is therefore `invoices/<storage_path>`. Never store the
 *   bucket name in the column; `svc.storage.from(INVOICES_BUCKET)` supplies it.
 */
export const INVOICES_BUCKET = "invoices";
export const INVOICE_MAX_BYTES = 25 * 1024 * 1024;
/** Spreadsheet invoices (csv/tsv/xlsx/xls) are capped lower: a 5 MB export is already tens of thousands of rows. */
export const SPREADSHEET_MAX_BYTES = 5 * 1024 * 1024;
export const SPREADSHEET_MIME = [
  "text/csv",
  "text/tab-separated-values",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
] as const;
export const INVOICE_ALLOWED_MIME = ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "text/plain", "application/json", ...SPREADSHEET_MIME] as const;

export function isSpreadsheetMime(mimeType: string): boolean {
  return (SPREADSHEET_MIME as readonly string[]).includes(mimeType.toLowerCase().split(";")[0].trim());
}

/** Size cap by type: spreadsheets 5 MB, everything else 25 MB. */
export function maxBytesFor(mimeType: string): number {
  return isSpreadsheetMime(mimeType) ? SPREADSHEET_MAX_BYTES : INVOICE_MAX_BYTES;
}

let ensured = false;

/** Create the private bucket once (idempotent; "already exists" is not an error). */
export async function ensureInvoicesBucket(svc: ServiceClient): Promise<void> {
  if (ensured) return;
  const options = { public: false, fileSizeLimit: INVOICE_MAX_BYTES, allowedMimeTypes: [...INVOICE_ALLOWED_MIME] };
  const { error } = await svc.storage.createBucket(INVOICES_BUCKET, options);
  if (error) {
    if (!/already exists|duplicate|409/i.test(`${error.message} ${"statusCode" in error ? String(error.statusCode) : ""}`)) {
      throw new Error(`createBucket ${INVOICES_BUCKET}: ${error.message}`);
    }
    // Bucket exists: keep its allowed MIME list in sync with this file (spreadsheets were added later).
    const { error: uerr } = await svc.storage.updateBucket(INVOICES_BUCKET, options);
    if (uerr) throw new Error(`updateBucket ${INVOICES_BUCKET}: ${uerr.message}`);
  }
  ensured = true;
}

/** Object key inside the bucket: `<locationId>/<yyyy>/<mm>/<hash>.<ext>` (see header). */
export function invoiceStoragePath(locationId: string, date: Date, hash: string, ext: string): string {
  const yyyy = date.getUTCFullYear().toString();
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, "0");
  const cleanExt = ext.replace(/^\./, "").toLowerCase() || "bin";
  return `${locationId}/${yyyy}/${mm}/${hash}.${cleanExt}`;
}

/** Storage keys that are audit artifacts, not files to show a human. */
export function isDisplayableStoragePath(storagePath: string): boolean {
  return !storagePath.startsWith("manual/");
}

/**
 * Short-lived signed URL for the review screen, with download disabled so
 * browsers render PDFs/images inline instead of saving them; null for manual
 * intake (`manual/…json`) which has no document to show.
 */
export async function signedInvoiceUrl(svc: ServiceClient, storagePath: string, expiresSeconds = 600): Promise<string | null> {
  if (!storagePath || !isDisplayableStoragePath(storagePath)) return null;
  const { data, error } = await svc.storage.from(INVOICES_BUCKET).createSignedUrl(storagePath, expiresSeconds, { download: false });
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
}

/** `<path without extension>.preview.png` — the first page of a PDF, rendered at upload time. */
export function previewPathFor(storagePath: string): string {
  return storagePath.replace(/\.[a-z0-9]+$/i, "") + ".preview.png";
}

export function isPdfPath(storagePath: string): boolean {
  return storagePath.toLowerCase().endsWith(".pdf");
}

/**
 * Make sure a PDF has its first-page PNG preview next to it. Best-effort:
 * returns the preview path when it exists or was just rendered, null when
 * the PDF could not be rendered. Pass the bytes when you already have them.
 */
export async function ensurePdfPreview(svc: ServiceClient, storagePath: string, bytes?: Uint8Array): Promise<string | null> {
  if (!isPdfPath(storagePath)) return null;
  const previewPath = previewPathFor(storagePath);
  const { data: existing } = await svc.storage.from(INVOICES_BUCKET).createSignedUrl(previewPath, 60);
  if (existing?.signedUrl) return previewPath;
  const source = bytes ?? (await downloadInvoiceBytes(svc, storagePath));
  const png = await renderPdfFirstPage(source);
  if (!png) return null;
  const { error } = await svc.storage.from(INVOICES_BUCKET).upload(previewPath, png, { contentType: "image/png", upsert: true });
  if (error) {
    console.warn(JSON.stringify({ msg: "pdf-preview: upload failed", previewPath, error: error.message }));
    return null;
  }
  return previewPath;
}

/** Download an object as bytes. */
export async function downloadInvoiceBytes(svc: ServiceClient, storagePath: string): Promise<Uint8Array> {
  const { data, error } = await svc.storage.from(INVOICES_BUCKET).download(storagePath);
  if (error || !data) throw new Error(`storage download ${storagePath}: ${error?.message ?? "no data"}`);
  return new Uint8Array(await data.arrayBuffer());
}

/** Extension for a mime type (used to name stored objects). */
export function extForMime(mimeType: string, filename?: string): string {
  const m = mimeType.toLowerCase().split(";")[0].trim();
  const map: Record<string, string> = {
    "application/pdf": "pdf",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/gif": "gif",
    "text/plain": "txt",
    "application/json": "json",
    "text/csv": "csv",
    "text/tab-separated-values": "tsv",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-excel": "xls",
  };
  if (map[m]) return map[m];
  const ext = filename?.toLowerCase().split(".").pop();
  return ext && /^[a-z0-9]{1,5}$/.test(ext) ? ext : "bin";
}
