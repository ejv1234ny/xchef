"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

type Phase = { kind: "idle" } | { kind: "preparing" } | { kind: "uploading" } | { kind: "reading" } | { kind: "error"; message: string };

const MAX_SIDE = 2000;
const JPEG_QUALITY = 0.85;

function isHeic(file: File): boolean {
  const t = file.type.toLowerCase();
  const n = file.name.toLowerCase();
  return t === "image/heic" || t === "image/heif" || n.endsWith(".heic") || n.endsWith(".heif");
}

/**
 * Photos from a phone are 12 MP+; the parser does not need that. Draw to a
 * canvas with the longest side ≤ 2000px and export JPEG. HEIC/HEIF cannot be
 * decoded by canvas in most browsers, and PDFs are not images: both go as-is.
 */
async function prepare(file: File): Promise<Blob> {
  if (!file.type.startsWith("image/") || isHeic(file)) return file;
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error("Could not read that photo"));
      el.src = url;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    return blob ?? file;
  } finally {
    URL.revokeObjectURL(url);
  }
}

const uploadResponse = (v: unknown): { documentId: string; status: string; duplicate?: boolean } | null => {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.documentId !== "string") return null;
  return { documentId: o.documentId, status: String(o.status ?? ""), duplicate: o.duplicate === true };
};

async function readError(res: Response): Promise<string> {
  try {
    const j: unknown = await res.json();
    if (typeof j === "object" && j !== null && typeof (j as Record<string, unknown>).error === "string") {
      return (j as Record<string, string>).error;
    }
  } catch {
    // not JSON
  }
  return `Upload failed (${res.status})`;
}

export function InvoiceUpload({ variant }: { variant: "camera" | "file" }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const busy = phase.kind === "preparing" || phase.kind === "uploading" || phase.kind === "reading";

  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    try {
      setPhase({ kind: "preparing" });
      const blob = await prepare(file);
      const isJpegExport = blob !== file;
      const name = isJpegExport ? file.name.replace(/\.[^.]+$/, "") + ".jpg" : file.name;
      const body = new FormData();
      body.append("file", blob, name);
      setPhase({ kind: "uploading" });
      const res = await fetch("/api/intake/upload", { method: "POST", body });
      if (!res.ok) throw new Error(await readError(res));
      setPhase({ kind: "reading" });
      const json = uploadResponse(await res.json());
      if (!json) throw new Error("Unexpected response from the server");
      router.push(`/invoices/review/${json.documentId}${json.duplicate ? "?ok=Already%20on%20file" : ""}`);
    } catch (err) {
      setPhase({ kind: "error", message: err instanceof Error ? err.message : "Upload failed" });
    }
  }

  const label = variant === "camera" ? "📷 Photo an invoice" : "📄 Choose a PDF or photo";
  const status =
    phase.kind === "preparing" ? "Preparing photo…" : phase.kind === "uploading" ? "Uploading…" : phase.kind === "reading" ? "Reading invoice…" : null;

  return (
    <div className="flex flex-col gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf"
        {...(variant === "camera" ? { capture: "environment" as const } : {})}
        className="hidden"
        onChange={onChange}
        disabled={busy}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={busy}
        aria-busy={busy}
        className={
          variant === "camera"
            ? "flex h-20 w-full items-center justify-center rounded-2xl bg-neutral-900 text-xl font-semibold text-white disabled:opacity-60"
            : "flex h-14 w-full items-center justify-center rounded-xl border border-neutral-300 bg-white text-base font-medium disabled:opacity-60"
        }
      >
        {status ?? label}
      </button>
      {phase.kind === "error" ? (
        <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">
          {phase.message}
        </p>
      ) : null}
    </div>
  );
}

const LINE_COUNT = 5;
const inputCls = "h-12 w-full rounded-xl border border-neutral-300 bg-white px-3 text-base";

/**
 * "Enter by hand": posts JSON to /api/intake/manual, which writes the document
 * and its lines (that logic lives with the pipeline, not here) and returns the
 * new document id.
 */
export function ManualInvoiceForm() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const str = (k: string) => String(fd.get(k) ?? "").trim();
    const lines: Array<{
      description: string;
      vendor_sku?: string;
      pack_size_text?: string;
      quantity: string;
      unit_price?: string;
      extended_price?: string;
    }> = [];
    for (let i = 0; i < LINE_COUNT; i++) {
      const description = str(`desc_${i}`);
      const quantity = str(`qty_${i}`);
      if (!description && !quantity) continue;
      if (!description || !quantity) {
        setError(`Line ${i + 1} needs both a description and a quantity`);
        return;
      }
      const line: (typeof lines)[number] = { description, quantity };
      const sku = str(`sku_${i}`);
      const pack = str(`pack_${i}`);
      const unit = str(`unit_${i}`);
      const ext = str(`ext_${i}`);
      if (sku) line.vendor_sku = sku;
      if (pack) line.pack_size_text = pack;
      if (unit) line.unit_price = unit;
      if (ext) line.extended_price = ext;
      lines.push(line);
    }
    const vendorName = str("vendorName");
    const invoiceDate = str("invoiceDate");
    if (!vendorName || !invoiceDate) {
      setError("Vendor and date are required");
      return;
    }
    if (lines.length === 0) {
      setError("Add at least one line");
      return;
    }
    const invoiceNumber = str("invoiceNumber");
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/intake/manual", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ vendorName, invoiceDate, ...(invoiceNumber ? { invoiceNumber } : {}), lines }),
      });
      if (!res.ok) throw new Error(await readError(res));
      const json = uploadResponse(await res.json());
      if (!json) throw new Error("Unexpected response from the server");
      router.push(`/invoices/review/${json.documentId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-2">
        <label className="col-span-2 text-sm">
          Vendor
          <input name="vendorName" required className={inputCls} placeholder="Sysco" autoComplete="organization" />
        </label>
        <label className="text-sm">
          Date
          <input name="invoiceDate" type="date" required className={inputCls} />
        </label>
        <label className="text-sm">
          Invoice #
          <input name="invoiceNumber" className={inputCls} inputMode="numeric" />
        </label>
      </div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: LINE_COUNT }, (_, i) => (
          <fieldset key={i} className="rounded-xl border border-neutral-200 p-2">
            <legend className="px-1 text-xs text-neutral-500">Line {i + 1}</legend>
            <div className="grid grid-cols-6 gap-2">
              <input name={`desc_${i}`} placeholder="Description" className={`${inputCls} col-span-4`} />
              <input name={`pack_${i}`} placeholder="Pack (6/#10)" className={`${inputCls} col-span-2`} />
              <input name={`qty_${i}`} placeholder="Qty" inputMode="decimal" className={`${inputCls} col-span-2`} />
              <input name={`unit_${i}`} placeholder="Unit $" inputMode="decimal" className={`${inputCls} col-span-2`} />
              <input name={`ext_${i}`} placeholder="Total $" inputMode="decimal" className={`${inputCls} col-span-2`} />
              <input name={`sku_${i}`} placeholder="SKU (optional)" className={`${inputCls} col-span-6`} />
            </div>
          </fieldset>
        ))}
      </div>
      {error ? (
        <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      ) : null}
      <button type="submit" disabled={busy} className="h-14 rounded-xl bg-neutral-900 text-base font-medium text-white disabled:opacity-60">
        {busy ? "Saving…" : "Save invoice"}
      </button>
    </form>
  );
}
