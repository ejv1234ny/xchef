import { describe, expect, it } from "vitest";
import { heicToJpeg, renderPdfFirstPage } from "./pdf-preview";
import { previewPathFor, isPdfPath } from "./storage";

/** A minimal one-page PDF with one line of text, built by hand (no fixtures needed). */
function tinyPdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 24 Tf 20 100 Td (INVOICE 123) Tj ET";
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

describe("PDF first-page preview", () => {
  it("renders a PNG for a valid PDF", async () => {
    const png = await renderPdfFirstPage(tinyPdf(), { maxWidth: 600 });
    expect(png).not.toBeNull();
    expect(Array.from(png!.slice(0, 4))).toEqual([0x89, 0x50, 0x4e, 0x47]); // PNG signature
    expect(png!.byteLength).toBeGreaterThan(1000);
  }, 30_000);

  it("returns null for garbage instead of throwing", async () => {
    expect(await renderPdfFirstPage(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it("preview path sits next to the original", () => {
    expect(previewPathFor("loc/2026/09/abc.pdf")).toBe("loc/2026/09/abc.preview.png");
    expect(isPdfPath("loc/2026/09/abc.PDF")).toBe(true);
    expect(isPdfPath("loc/2026/09/abc.jpg")).toBe(false);
  });

  it("heicToJpeg returns null for non-HEIC bytes", async () => {
    expect(await heicToJpeg(new Uint8Array([1, 2, 3]))).toBeNull();
  }, 30_000);
});
