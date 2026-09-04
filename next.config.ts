import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native canvas + pdfjs + HEIC decoder run in Node, not the bundler.
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas", "heic-convert"],
  // pdfjs loads its worker by computed path; make sure the file ships with every function.
  outputFileTracingIncludes: {
    "/**": ["./node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs", "./node_modules/.pnpm/pdfjs-dist@*/node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
  },
  /* config options here */
};

export default nextConfig;
