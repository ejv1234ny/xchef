/**
 * pnpm exec tsx scripts/gen-icons.ts — writes the PWA icons into public/icons
 * using only node built-ins: a PNG encoder (zlib deflate + CRC32) over RGBA
 * scanlines, and a glyph drawn with pixel math (dark rounded square, light "x").
 *
 *   icon-192.png            192  rounded square, transparent corners
 *   icon-512.png            512  rounded square, transparent corners
 *   icon-maskable-512.png   512  full-bleed background, glyph inside the 80% safe zone
 *   apple-touch-icon.png    180  full-bleed (iOS applies its own mask)
 */
import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const BG = [0x17, 0x17, 0x17] as const; // #171717 (theme colour)
const FG = [0xfa, 0xfa, 0xfa] as const; // #fafafa (background colour of the app)

// ---- PNG encoder --------------------------------------------------------

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBytes = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, Buffer.from(data)])), 0);
  return Buffer.concat([len, typeBytes, Buffer.from(data), crc]);
}
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

// ---- Glyph --------------------------------------------------------------

/** Signed distance from (px,py) to the segment (ax,ay)-(bx,by). */
function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / (vx * vx + vy * vy)));
  const dx = px - (ax + t * vx);
  const dy = py - (ay + t * vy);
  return Math.sqrt(dx * dx + dy * dy);
}

/** Coverage (0..1) of a rounded square of half-size h and corner radius r centred at 0. */
function roundedSquare(x: number, y: number, h: number, r: number): number {
  const qx = Math.abs(x) - (h - r);
  const qy = Math.abs(y) - (h - r);
  const d = Math.sqrt(Math.max(qx, 0) ** 2 + Math.max(qy, 0) ** 2) + Math.min(Math.max(qx, qy), 0) - r;
  return Math.max(0, Math.min(1, 0.5 - d)); // 1px anti-alias
}

function render(size: number, opts: { fullBleed: boolean; glyphScale: number }): Uint8Array {
  const out = new Uint8Array(size * size * 4);
  const c = size / 2;
  const half = size / 2;
  const radius = size * 0.22;
  // The "x": two strokes across the glyph box.
  const g = half * opts.glyphScale;
  const stroke = size * 0.075;
  const ss = 3; // supersampling per axis
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let bgCov = 0;
      let fgCov = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const px = x + (sx + 0.5) / ss - c;
          const py = y + (sy + 0.5) / ss - c;
          const inBg = opts.fullBleed ? 1 : roundedSquare(px, py, half, radius);
          bgCov += inBg;
          const d = Math.min(segDist(px, py, -g, -g, g, g), segDist(px, py, -g, g, g, -g));
          const inFg = Math.max(0, Math.min(1, stroke - d + 0.5));
          fgCov += inBg * inFg;
        }
      }
      bgCov /= ss * ss;
      fgCov /= ss * ss;
      const i = (y * size + x) * 4;
      const a = bgCov;
      // premultiplied blend of fg over bg, then straight alpha = coverage of bg
      const mix = a > 0 ? fgCov / a : 0;
      out[i] = Math.round(BG[0] + (FG[0] - BG[0]) * mix);
      out[i + 1] = Math.round(BG[1] + (FG[1] - BG[1]) * mix);
      out[i + 2] = Math.round(BG[2] + (FG[2] - BG[2]) * mix);
      out[i + 3] = Math.round(a * 255);
    }
  }
  return out;
}

// ---- Main ---------------------------------------------------------------

const outDir = path.resolve(process.cwd(), "public", "icons");
mkdirSync(outDir, { recursive: true });

const files: Array<[string, number, { fullBleed: boolean; glyphScale: number }]> = [
  ["icon-192.png", 192, { fullBleed: false, glyphScale: 0.42 }],
  ["icon-512.png", 512, { fullBleed: false, glyphScale: 0.42 }],
  ["icon-maskable-512.png", 512, { fullBleed: true, glyphScale: 0.3 }], // inside the 80% safe zone
  ["apple-touch-icon.png", 180, { fullBleed: true, glyphScale: 0.42 }],
];

for (const [name, size, opts] of files) {
  const png = encodePng(size, size, render(size, opts));
  writeFileSync(path.join(outDir, name), png);
  console.log(`wrote public/icons/${name} (${size}×${size}, ${png.length} bytes)`);
}
