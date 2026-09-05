import { pfg } from "./pfg";
import { sysco } from "./sysco";
import type { PortalAdapter } from "./types";

export type { PortalAdapter, PortalInvoice, PortalPullContext } from "./types";

/**
 * Registry of portal adapters, keyed by the short vendor key used on the CLI
 * (`pnpm portal:pull --vendor pfg`) and in the GitHub secret names
 * (PORTAL_PFG_USER / PORTAL_PFG_PASS, PORTAL_SYSCO_USER / PORTAL_SYSCO_PASS).
 */
export const PORTAL_ADAPTERS: Record<string, PortalAdapter> = {
  pfg,
  sysco,
};

/** Names a vendor may carry in `vendors.name` for the `since` lookup (ilike). */
export const PORTAL_VENDOR_ALIASES: Record<string, string[]> = {
  pfg: ["Performance Food Group", "PFG", "Performance Foodservice"],
  sysco: ["Sysco"],
};

export function portalKeys(): string[] {
  return Object.keys(PORTAL_ADAPTERS);
}

export function adapterFor(key: string): PortalAdapter | undefined {
  return PORTAL_ADAPTERS[key.toLowerCase()];
}

/** True when both env vars for the adapter are set (never logs their values). */
export function hasCredentials(adapter: PortalAdapter, env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env[adapter.env.user] && env[adapter.env.pass]);
}
