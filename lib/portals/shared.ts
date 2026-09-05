import { mkdirSync } from "node:fs";
import path from "node:path";
import type { Download, Locator, Page } from "playwright";
import type { PortalLog, PortalPullContext } from "./types";

/** Generous waits: portals are slow and selectors are best-effort on first write. */
export const NAV_TIMEOUT_MS = 60_000;
export const STEP_TIMEOUT_MS = 30_000;

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Full-page screenshot to `${artifactsDir}/<vendor>-<timestamp>.png`; never throws (the original error matters more). */
export async function saveFailureScreenshot(page: Page, artifactsDir: string, vendor: string, log: PortalLog): Promise<string | null> {
  try {
    mkdirSync(artifactsDir, { recursive: true });
    const file = path.join(artifactsDir, `${slug(vendor)}-${timestamp()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log("portal: screenshot saved", { vendor, file, url: page.url() });
    return file;
  } catch (e) {
    log("portal: screenshot failed", { vendor, error: e instanceof Error ? e.message : String(e) });
    return null;
  }
}

/** Run one portal step; on failure screenshot and rethrow with the step named. Never returns zero silently. */
export async function step<T>(ctx: PortalPullContext, vendor: string, name: string, fn: () => Promise<T>): Promise<T> {
  ctx.log(`portal: ${vendor}: ${name}`);
  try {
    return await fn();
  } catch (e) {
    const shot = await saveFailureScreenshot(ctx.page, ctx.artifactsDir, vendor, ctx.log);
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`${vendor}: step "${name}" failed at ${ctx.page.url()}: ${msg}${shot ? ` (screenshot ${shot})` : ""}`);
  }
}

export function requireCreds(env: { user: string; pass: string }): { user: string; pass: string } {
  const user = process.env[env.user];
  const pass = process.env[env.pass];
  if (!user || !pass) throw new Error(`missing credentials: set ${env.user} and ${env.pass}`);
  return { user, pass };
}

/** Click something that triggers a browser download and return its bytes + suggested filename. */
export async function clickAndDownload(page: Page, trigger: Locator, timeoutMs = STEP_TIMEOUT_MS): Promise<{ bytes: Uint8Array; filename: string }> {
  const [download] = await Promise.all([page.waitForEvent("download", { timeout: timeoutMs }), trigger.click({ timeout: timeoutMs })]);
  return { bytes: await downloadToBuffer(download), filename: download.suggestedFilename() };
}

export async function downloadToBuffer(download: Download): Promise<Uint8Array> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return new Uint8Array(Buffer.concat(chunks));
}

export function mimeForFilename(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  return (
    {
      pdf: "application/pdf",
      csv: "text/csv",
      tsv: "text/tab-separated-values",
      xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      xls: "application/vnd.ms-excel",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
    }[ext] ?? "application/octet-stream"
  );
}

/** "08/20/2026" | "2026-08-20" | "Aug 20, 2026" → "2026-08-20"; null when unreadable. */
export function toIsoDate(s: string | null | undefined): string | null {
  const t = (s ?? "").trim();
  if (!t) return null;
  const iso = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const us = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})/);
  if (us) {
    const y = us[3].length === 2 ? `20${us[3]}` : us[3];
    return `${y}-${us[1].padStart(2, "0")}-${us[2].padStart(2, "0")}`;
  }
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

/** MM/DD/YYYY for portal date filters. */
export function toUsDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${m}/${d}/${y}`;
}
