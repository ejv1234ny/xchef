/**
 * First-page PNG preview of a PDF, rendered server-side with pdfjs-dist and
 * @napi-rs/canvas (no browser). Used at upload time so phones that cannot
 * embed PDFs still see the invoice on the review screen. Returns null when the
 * PDF cannot be rendered (encrypted, corrupt) — previews are best-effort.
 */
export const PREVIEW_MAX_WIDTH = 1400;

export async function renderPdfFirstPage(bytes: Uint8Array, opts: { maxWidth?: number } = {}): Promise<Uint8Array | null> {
  const maxWidth = opts.maxWidth ?? PREVIEW_MAX_WIDTH;
  try {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { createCanvas } = await import("@napi-rs/canvas");
    // Serverless bundles only include files the tracer can see. Importing the
    // worker with a literal specifier keeps it in the bundle, and pointing
    // workerSrc at its resolved file URL lets pdfjs's in-process "fake worker"
    // load it on Vercel (where relative URL resolution from pdf.mjs fails).
    await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    try {
      const { createRequire } = await import("node:module");
      const { pathToFileURL } = await import("node:url");
      const req = createRequire(`${process.cwd()}/`);
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(req.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
    } catch {
      /* fall back to pdfjs's own resolution */
    }
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: true, verbosity: 0 });
    const doc = await task.promise;
    try {
      const page = await doc.getPage(1);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, maxWidth / base.width);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      // pdfjs draws on any 2D context with the browser Canvas API surface; @napi-rs/canvas provides it.
      await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, canvas: canvas as unknown as HTMLCanvasElement }).promise;
      return new Uint8Array(canvas.toBuffer("image/png"));
    } finally {
      await task.destroy();
    }
  } catch (e) {
    console.warn(JSON.stringify({ msg: "pdf-preview: render failed", error: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}

/** HEIC/HEIF → JPEG so browsers and the LLM can read phone photos. Returns null when conversion fails. */
export async function heicToJpeg(bytes: Uint8Array, quality = 0.85): Promise<Uint8Array | null> {
  try {
    const mod = await import("heic-convert");
    const convert = mod.default ?? mod;
    const out: unknown = await convert({ buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), format: "JPEG", quality });
    if (out instanceof ArrayBuffer) return new Uint8Array(out);
    if (ArrayBuffer.isView(out)) return new Uint8Array(out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength));
    return null;
  } catch (e) {
    console.warn(JSON.stringify({ msg: "heic-convert failed", error: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}
