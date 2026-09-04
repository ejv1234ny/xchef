import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native canvas + pdfjs + HEIC decoder run in Node, not the bundler.
  serverExternalPackages: ["pdfjs-dist", "@napi-rs/canvas", "heic-convert"],
  /* config options here */
};

export default nextConfig;
