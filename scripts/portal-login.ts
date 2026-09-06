/**
 * pnpm portal:login --vendor pfg|sysco [--timeout 600]
 *
 * One-time, supervised login for a vendor portal that asks for a one-time code
 * or "remember this device" (KICKOFF-3 item 1). Opens a HEADED Chromium at the
 * portal's login page with PORTAL_<KEY>_USER / _PASS from .env.portals
 * pre-filled when possible; you finish the login (code, checkbox) in the
 * window. When the URL leaves the login page — or you press Enter here — the
 * browser's cookies + localStorage are written to portal-state/<key>.json
 * (gitignored). Then:
 *
 *   base64 -w0 portal-state/pfg.json | gh secret set PORTAL_PFG_STATE      (Linux / Git Bash)
 *   certutil -encode portal-state\pfg.json tmp.b64 & findstr /v CERT tmp.b64 | gh secret set PORTAL_PFG_STATE   (cmd)
 *
 * and the scheduled pull reuses that session. Re-auth = run this again and
 * update the secret. Never prints a credential.
 */
import "./_env";
import { config } from "dotenv";
import path from "node:path";
import { createInterface } from "node:readline";
import { arg } from "./_env";
import { adapterFor, portalKeys } from "@/lib/portals";
import { PFG_URLS } from "@/lib/portals/pfg";
import { SYSCO_URLS } from "@/lib/portals/sysco";
import { savePortalState } from "@/lib/portals/shared";

config({ path: path.resolve(process.cwd(), ".env.portals"), quiet: true });

const LOGIN_URLS: Record<string, string> = { pfg: PFG_URLS.login, sysco: SYSCO_URLS.login };

async function main() {
  const key = (arg("vendor") ?? "").toLowerCase();
  const adapter = adapterFor(key);
  if (!adapter) throw new Error(`--vendor must be one of: ${portalKeys().join(", ")}`);
  const timeoutS = Number(arg("timeout") ?? 600);
  const user = process.env[adapter.env.user];
  const pass = process.env[adapter.env.pass];

  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  await page.goto(LOGIN_URLS[key], { waitUntil: "domcontentloaded" });
  if (user && pass) {
    // best effort pre-fill; the person completes anything else (Next, code, remember-me)
    const u = page.locator('input[name="username"], input[type="email"], input#username, input[autocomplete="username"]').first();
    if ((await u.count()) > 0) await u.fill(user).catch(() => undefined);
    const p = page.locator('input[name="password"], input[type="password"]').first();
    if ((await p.count()) > 0) await p.fill(pass).catch(() => undefined);
    console.log(`Filled ${adapter.env.user} / ${adapter.env.pass} on ${LOGIN_URLS[key]}. Finish the login in the browser window.`);
  } else {
    console.log(`No ${adapter.env.user} / ${adapter.env.pass} in .env.portals — log in by hand in the browser window.`);
  }
  console.log(`Waiting up to ${timeoutS}s for the login to complete (URL leaves the login page), or press Enter here to save now.`);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const enter = new Promise<void>((resolve) => rl.once("line", () => resolve()));
  const left = page.waitForURL((u) => !/login|auth|signin|sign-in/i.test(u.toString()), { timeout: timeoutS * 1000 }).then(() => page.waitForTimeout(3000));
  await Promise.race([enter, left.catch(() => undefined)]);
  rl.close();

  const state = await context.storageState();
  const file = savePortalState(key, state);
  console.log(`Saved ${state.cookies.length} cookies and ${state.origins.length} origin(s) of local storage to ${file} (at ${page.url()}).`);
  console.log(`Next: put it in GitHub as PORTAL_${key.toUpperCase()}_STATE (base64) — see the header of this script.`);
  await browser.close();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
