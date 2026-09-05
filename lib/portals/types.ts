/**
 * Vendor-portal adapters (KICKOFF-2 Part 2). One adapter per distributor
 * portal; each logs in with a Playwright page, lists the invoices posted since
 * `since` (YYYY-MM-DD) and returns the files. scripts/portal-pull.ts then POSTs
 * every file to /api/intake/upload with the x-intake-key so it enters the same
 * intake → parse → map → post pipeline as every other channel (source 'api').
 *
 * Contract every adapter must honour:
 *  - never return [] silently: an empty list is logged explicitly with the
 *    filter that was applied; any failure saves a full-page screenshot under
 *    `${artifactsDir}/<vendor>-<timestamp>.png` and throws with a clear message;
 *  - prefer a portal-provided export ("email me my invoices", CSV/PDF export by
 *    date range) over screen-scraping — say so in the adapter's header comment;
 *  - never log credentials.
 */
export type PortalInvoice = {
  invoiceNumber: string;
  /** YYYY-MM-DD as printed on the portal */
  invoiceDate: string;
  buffer: Uint8Array;
  mime: string;
  filename: string;
};

export type PortalLog = (m: string, meta?: Record<string, unknown>) => void;

export type PortalPullContext = {
  page: import("playwright").Page;
  /** YYYY-MM-DD — pull invoices dated on or after this day */
  since: string;
  log: PortalLog;
  /** where failure screenshots go (uploaded as workflow artifacts) */
  artifactsDir: string;
};

export type PortalAdapter = {
  /** vendor name as it appears in `vendors.name` (used for x-vendor and the `since` lookup) */
  vendor: string;
  /** names of the env vars carrying the login */
  env: { user: string; pass: string };
  pull(ctx: PortalPullContext): Promise<PortalInvoice[]>;
};
