import type { PortalAdapter, PortalInvoice, PortalPullContext } from "./types";
import { clickAndDownload, mimeForFilename, NAV_TIMEOUT_MS, requireCreds, STEP_TIMEOUT_MS, step, toIsoDate, toUsDate } from "./shared";

/**
 * Performance Food Group — customer portal (customer.pfgc.com).
 *
 * What the portal offers (as of writing, from the customer-facing help pages):
 *  - Accounts → Invoices lists posted invoices with a date-range filter and a
 *    per-invoice "PDF" download; there is also a "Download" / "Export"
 *    control on the list that produces a CSV of the filtered invoices.
 *  - The account settings offer "Invoice delivery by email" (PFG will email
 *    the PDF the morning after delivery). PREFER THAT: point it at the xchef
 *    inbound address (INBOUND_EMAIL_ADDRESS) and this adapter becomes a
 *    backstop only — zero-maintenance email beats a login script that breaks
 *    on a redesign (BLUEPRINT §5.2).
 *
 * This adapter: log in → Accounts → Invoices → set the "from" date to `since`
 * → download every invoice's PDF. Selectors are BEST-EFFORT and expected to
 * be wrong on first contact; every step screenshots and throws on failure and
 * an empty list is logged explicitly, never returned silently.
 */
export const PFG_URLS = {
  login: "https://customer.pfgc.com/login",
  invoices: "https://customer.pfgc.com/accounts/invoices",
};

const VENDOR = "Performance Food Group";

export const pfg: PortalAdapter = {
  vendor: VENDOR,
  env: { user: "PORTAL_PFG_USER", pass: "PORTAL_PFG_PASS" },
  pull: pullPfg,
};

export async function pullPfg(ctx: PortalPullContext): Promise<PortalInvoice[]> {
  const { page, since, log } = ctx;
  const creds = requireCreds(pfg.env);
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT_MS);

  await step(ctx, VENDOR, "open login page", async () => {
    await page.goto(PFG_URLS.login, { waitUntil: "domcontentloaded" });
  });

  await step(ctx, VENDOR, "sign in", async () => {
    const user = page.locator('input[name="username"], input[type="email"], input#username, input[autocomplete="username"]').first();
    await user.waitFor({ state: "visible" });
    await user.fill(creds.user);
    const pass = page.locator('input[name="password"], input[type="password"]').first();
    await pass.fill(creds.pass);
    await Promise.all([
      page.waitForURL((u) => !/login/i.test(u.toString()), { timeout: NAV_TIMEOUT_MS }),
      page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in")').first().click(),
    ]);
  });

  await step(ctx, VENDOR, "open Accounts → Invoices", async () => {
    await page.goto(PFG_URLS.invoices, { waitUntil: "domcontentloaded" });
    await page.locator('h1:has-text("Invoices"), h2:has-text("Invoices"), [data-testid*="invoice"], table').first().waitFor({ state: "visible" });
  });

  await step(ctx, VENDOR, `filter from ${since}`, async () => {
    const from = page.locator('input[name*="from" i], input[aria-label*="from" i], input[placeholder*="from" i], input[type="date"]').first();
    if ((await from.count()) === 0) {
      log("portal: pfg: no date filter found, listing the default range", { since });
      return;
    }
    await from.fill((await from.getAttribute("type")) === "date" ? since : toUsDate(since));
    await from.press("Enter");
    const apply = page.locator('button:has-text("Apply"), button:has-text("Search"), button:has-text("Filter")').first();
    if ((await apply.count()) > 0) await apply.click();
    await page.waitForLoadState("networkidle", { timeout: NAV_TIMEOUT_MS }).catch(() => undefined);
  });

  const rows = await step(ctx, VENDOR, "read the invoice list", async () => {
    const rowLoc = page.locator('table tbody tr, [role="row"]:not([role="columnheader"]), [data-testid*="invoice-row"]');
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
    log("portal: pfg: invoice list is empty for the filter — nothing to pull", { since, url: page.url() });
    return [];
  }
  log("portal: pfg: invoices listed", { count: rows.length, since });

  const invoices: PortalInvoice[] = [];
  for (const r of rows) {
    const file = await step(ctx, VENDOR, `download invoice ${r.invoiceNumber}`, async () => {
      const row = page.locator('table tbody tr, [role="row"]:not([role="columnheader"]), [data-testid*="invoice-row"]').nth(r.index);
      const trigger = row.locator('a:has-text("PDF"), button:has-text("PDF"), a[href$=".pdf"], a:has-text("Download"), button:has-text("Download"), [aria-label*="download" i]').first();
      await trigger.waitFor({ state: "visible" });
      return clickAndDownload(page, trigger);
    });
    const filename = /\.[a-z0-9]{2,5}$/i.test(file.filename) ? file.filename : `pfg-${r.invoiceNumber}.pdf`;
    invoices.push({ invoiceNumber: r.invoiceNumber, invoiceDate: r.invoiceDate, buffer: file.bytes, mime: mimeForFilename(filename), filename });
  }
  return invoices;
}
