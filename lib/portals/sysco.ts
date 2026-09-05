import type { PortalAdapter, PortalInvoice, PortalPullContext } from "./types";
import { clickAndDownload, mimeForFilename, NAV_TIMEOUT_MS, requireCreds, STEP_TIMEOUT_MS, step, toIsoDate, toUsDate } from "./shared";

/**
 * Sysco — Sysco Shop (shop.sysco.com).
 *
 * What the portal offers:
 *  - Invoices page (shop.sysco.com/app/invoices) lists posted invoices with a
 *    date-range filter, a per-invoice "Download PDF", and an "Export" control
 *    that produces a CSV of the filtered invoice LIST (headers only — the CSV
 *    does not carry line items, so the PDF is still needed per invoice).
 *  - Account settings offer "Invoice notifications" by email with the PDF
 *    attached. PREFER THAT: send them to INBOUND_EMAIL_ADDRESS and keep this
 *    adapter as the backstop (BLUEPRINT §5.2: export/email over scraping).
 *
 * This adapter: log in → Invoices → filter from `since` → download each
 * invoice's PDF. Selectors are BEST-EFFORT (Sysco Shop is a React SPA with
 * generated class names; data-test ids are used where they are known to
 * exist). Every step screenshots and throws on failure; an empty list is
 * logged explicitly, never returned silently.
 */
export const SYSCO_URLS = {
  login: "https://shop.sysco.com/auth/login",
  invoices: "https://shop.sysco.com/app/invoices",
};

const VENDOR = "Sysco";

export const sysco: PortalAdapter = {
  vendor: VENDOR,
  env: { user: "PORTAL_SYSCO_USER", pass: "PORTAL_SYSCO_PASS" },
  pull: pullSysco,
};

export async function pullSysco(ctx: PortalPullContext): Promise<PortalInvoice[]> {
  const { page, since, log } = ctx;
  const creds = requireCreds(sysco.env);
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  await step(ctx, VENDOR, "open login page", async () => {
    await page.goto(SYSCO_URLS.login, { waitUntil: "domcontentloaded" });
  });

  await step(ctx, VENDOR, "sign in", async () => {
    const user = page.locator('input[name="username"], input[type="email"], input#username, input[data-test="login-username"]').first();
    await user.waitFor({ state: "visible" });
    await user.fill(creds.user);
    // Sysco's login is two-step on some accounts: username → Next → password.
    const next = page.locator('button:has-text("Next"), button:has-text("Continue")').first();
    if ((await next.count()) > 0 && (await next.isVisible())) await next.click();
    const pass = page.locator('input[name="password"], input[type="password"], input[data-test="login-password"]').first();
    await pass.waitFor({ state: "visible" });
    await pass.fill(creds.pass);
    await Promise.all([
      page.waitForURL((u) => !/login|auth/i.test(u.toString()), { timeout: NAV_TIMEOUT_MS }),
      page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button[data-test="login-submit"]').first().click(),
    ]);
  });

  await step(ctx, VENDOR, "open Invoices", async () => {
    await page.goto(SYSCO_URLS.invoices, { waitUntil: "domcontentloaded" });
    await page.locator('h1:has-text("Invoices"), [data-test*="invoices"], table').first().waitFor({ state: "visible" });
  });

  await step(ctx, VENDOR, `filter from ${since}`, async () => {
    const from = page.locator('input[data-test*="start" i], input[name*="start" i], input[aria-label*="start" i], input[aria-label*="from" i], input[type="date"]').first();
    if ((await from.count()) === 0) {
      log("portal: sysco: no date filter found, listing the default range", { since });
      return;
    }
    await from.fill((await from.getAttribute("type")) === "date" ? since : toUsDate(since));
    await from.press("Enter");
    const apply = page.locator('button:has-text("Apply"), button:has-text("Search"), button[data-test*="apply" i]').first();
    if ((await apply.count()) > 0) await apply.click();
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
  });

  const rows = await step(ctx, VENDOR, "read the invoice list", async () => {
    const rowLoc = page.locator('[data-test*="invoice-row"], table tbody tr, [role="row"]:not([role="columnheader"])');
    await rowLoc.first().waitFor({ state: "attached", timeout: STEP_TIMEOUT_MS }).catch(() => undefined);
    const n = await rowLoc.count();
    const out: Array<{ invoiceNumber: string; invoiceDate: string; index: number }> = [];
    for (let i = 0; i < n; i++) {
      const text = (await rowLoc.nth(i).innerText()).replace(/\s+/g, " ").trim();
      const num = text.match(/\b(\d{6,12})\b/)?.[1] ?? null;
      const date = toIsoDate(text.match(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b|\b\d{4}-\d{2}-\d{2}\b/)?.[0]);
      if (!num || !date) continue;
      if (date < since) continue;
      out.push({ invoiceNumber: num, invoiceDate: date, index: i });
    }
    return out;
  });

  if (rows.length === 0) {
    log("portal: sysco: invoice list is empty for the filter — nothing to pull", { since, url: page.url() });
    return [];
  }
  log("portal: sysco: invoices listed", { count: rows.length, since });

  const invoices: PortalInvoice[] = [];
  for (const r of rows) {
    const file = await step(ctx, VENDOR, `download invoice ${r.invoiceNumber}`, async () => {
      const row = page.locator('[data-test*="invoice-row"], table tbody tr, [role="row"]:not([role="columnheader"])').nth(r.index);
      const trigger = row.locator('[data-test*="download" i], a:has-text("PDF"), button:has-text("PDF"), a[href$=".pdf"], button:has-text("Download"), [aria-label*="download" i]').first();
      await trigger.waitFor({ state: "visible" });
      return clickAndDownload(page, trigger);
    });
    const filename = /\.[a-z0-9]{2,5}$/i.test(file.filename) ? file.filename : `sysco-${r.invoiceNumber}.pdf`;
    invoices.push({ invoiceNumber: r.invoiceNumber, invoiceDate: r.invoiceDate, buffer: file.bytes, mime: mimeForFilename(filename), filename });
  }
  return invoices;
}
