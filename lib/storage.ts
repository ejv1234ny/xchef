import type { ServiceClient } from "@/lib/db/service";

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
export const INVOICE_ALLOWED_MIME = ["application/pdf", "image/jpeg", "image/png", "image/heic", "image/heif", "image/webp", "text/plain", "application/json"] as const;

let ensured = false;

/** Create the private bucket once (idempotent; "already exists" is not an error). */
export async function ensureInvoicesBucket(svc: ServiceClient): Promise<void> {
  if (ensured) return;
  const { error } = await svc.storage.createBucket(INVOICES_BUCKET, {
    public: false,
    fileSizeLimit: INVOICE_MAX_BYTES,
    allowedMimeTypes: [...INVOICE_ALLOWED_MIME],
  });
  if (error && !/already exists|duplicate|409/i.test(`${error.message} ${"statusCode" in error ? String(error.statusCode) : ""}`)) {
    throw new Error(`createBucket ${INVOICES_BUCKET}: ${error.message}`);
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
 * Short-lived signed URL for the review screen; null for manual intake
 * (`manual/…json`) which has no document to show.
 */
export async function signedInvoiceUrl(svc: ServiceClient, storagePath: string, expiresSeconds = 600): Promise<string | null> {
  if (!storagePath || !isDisplayableStoragePath(storagePath)) return null;
  const { data, error } = await svc.storage.from(INVOICES_BUCKET).createSignedUrl(storagePath, expiresSeconds);
  if (error || !data?.signedUrl) return null;
  return data.signedUrl;
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
  };
  if (map[m]) return map[m];
  const ext = filename?.toLowerCase().split(".").pop();
  return ext && /^[a-z0-9]{1,5}$/.test(ext) ? ext : "bin";
}
