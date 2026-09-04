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

export type RenderedImage = { bytes: Uint8Array; mimeType: "image/jpeg"; name: string };

async function loadPdf(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
  try {
    const { createRequire } = await import("node:module");
    const { pathToFileURL } = await import("node:url");
    const req = createRequire(`${process.cwd()}/`);
    pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(req.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs")).href;
  } catch {
    /* pdfjs resolves its own worker */
  }
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), disableFontFace: true, useSystemFonts: true, verbosity: 0 });
  const doc = await task.promise;
  return { doc, task };
}

/** Characters of extractable text on the first pages; ~0 means a scan (image-only) PDF. */
export async function pdfTextLength(bytes: Uint8Array, maxPages = 3): Promise<{ pages: number; textChars: number }> {
  try {
    const { doc, task } = await loadPdf(bytes);
    try {
      let chars = 0;
      for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
        const page = await doc.getPage(p);
        const content = await page.getTextContent();
        chars += content.items.reduce((a, it) => a + ("str" in it ? it.str.trim().length : 0), 0);
      }
      return { pages: doc.numPages, textChars: chars };
    } finally {
      await task.destroy();
    }
  } catch {
    return { pages: 0, textChars: 0 };
  }
}

/**
 * Render pages (and optional quadrant crops of each page) as JPEGs for vision
 * models. Scans of receipts are tall and narrow; the whole page gets
 * downsampled by the API, so crops keep receipt-sized print legible.
 */
export async function renderPdfImages(
  bytes: Uint8Array,
  opts: { maxPages?: number; pageWidth?: number; crops?: { cols: number; rows: number; width: number } | null; quality?: number } = {},
): Promise<RenderedImage[]> {
  const maxPages = opts.maxPages ?? 3;
  const pageWidth = opts.pageWidth ?? 1600;
  const quality = opts.quality ?? 0.85;
  const out: RenderedImage[] = [];
  try {
    const { doc, task } = await loadPdf(bytes);
    const { createCanvas } = await import("@napi-rs/canvas");
    try {
      for (let p = 1; p <= Math.min(doc.numPages, maxPages); p++) {
        const page = await doc.getPage(p);
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(3, pageWidth / base.width);
        const viewport = page.getViewport({ scale });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport, canvas: canvas as unknown as HTMLCanvasElement }).promise;
        out.push({ bytes: new Uint8Array(canvas.toBuffer("image/jpeg", quality)), mimeType: "image/jpeg", name: `page-${p}.jpg` });
        if (opts.crops) {
          const { cols, rows, width } = opts.crops;
          const cropScale = Math.min(4, (width * cols) / base.width);
          const vp = page.getViewport({ scale: cropScale });
          const big = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
          const bctx = big.getContext("2d");
          bctx.fillStyle = "#ffffff";
          bctx.fillRect(0, 0, big.width, big.height);
          await page.render({ canvasContext: bctx as unknown as CanvasRenderingContext2D, viewport: vp, canvas: big as unknown as HTMLCanvasElement }).promise;
          const cw = Math.ceil(big.width / cols);
          const ch = Math.ceil(big.height / rows);
          for (let c = 0; c < cols; c++) {
            for (let r = 0; r < rows; r++) {
              const crop = createCanvas(cw, ch);
              crop.getContext("2d").drawImage(big, c * cw, r * ch, cw, ch, 0, 0, cw, ch);
              const col = cols === 1 ? "" : c === 0 ? "left" : c === cols - 1 ? "right" : `col${c + 1}`;
              const row = rows === 1 ? "" : r === 0 ? "top" : r === rows - 1 ? "bottom" : `row${r + 1}`;
              out.push({ bytes: new Uint8Array(crop.toBuffer("image/jpeg", quality)), mimeType: "image/jpeg", name: `page-${p}-${[col, row].filter(Boolean).join("-") || "full"}.jpg` });
            }
          }
        }
      }
    } finally {
      await task.destroy();
    }
  } catch (e) {
    console.warn(JSON.stringify({ msg: "pdf-render: failed", error: e instanceof Error ? e.message : String(e) }));
  }
  return out;
}
