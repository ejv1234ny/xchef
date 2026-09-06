import { NextResponse, type NextRequest } from "next/server";
import { runMenuSync } from "@/lib/jobs/menuSync";
import { runLaborSync } from "@/lib/jobs/laborSync";
import { authorizeCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Daily 09:00 UTC (was /api/cron/menu-sync): menus v2 → menu_items, then Toast
 * labor time entries → labor_entries with a 36-hour re-pull window. Each part
 * records its own sync_runs row and neither can fail the other.
 */
export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const log = (msg: string, meta?: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...meta }));
  const out: { menu: unknown; labor: unknown; errors: string[] } = { menu: null, labor: null, errors: [] };
  try {
    out.menu = await runMenuSync({ log });
  } catch (e) {
    out.errors.push(`menu-sync: ${e instanceof Error ? e.message : String(e)}`);
    console.error("menu-sync failed", e);
  }
  try {
    out.labor = (await runLaborSync({ log })).map((r) => ({ location: r.location_name, entries: r.entries_fetched, rows: r.rows_upserted, quarantined: r.quarantined, dates: r.dates.length, error: r.error }));
  } catch (e) {
    out.errors.push(`labor-sync: ${e instanceof Error ? e.message : String(e)}`);
    console.error("labor-sync failed", e);
  }
  return NextResponse.json(out, { status: out.errors.length ? 500 : 200 });
}
