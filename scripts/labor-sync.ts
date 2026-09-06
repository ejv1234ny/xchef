/**
 * pnpm labor:sync                 last run − 36 h → now (first run: 90 days back), all locations
 * pnpm labor:sync --days 90       backfill from N days ago
 * pnpm labor:sync --location <id> one location
 * Reads GET /labor/v1/timeEntries (+ /labor/v1/jobs for titles) into labor_entries; daily_labor and
 * daily_cost_summary are views on top. Needs Toast credentials in Vault (pnpm creds) and .env.local.
 */
import "./_env";
import { arg, log } from "./_env";
import { runLaborSync } from "@/lib/jobs/laborSync";

async function main() {
  const days = arg("days") ? Number(arg("days")) : undefined;
  const since = days && Number.isFinite(days) ? new Date(Date.now() - days * 86_400_000) : undefined;
  const runs = await runLaborSync({ locationId: arg("location"), since, log });
  if (runs.length === 0) {
    console.log("No locations with Toast credentials. Run `pnpm creds` first.");
    return;
  }
  console.table(
    runs.map((r) => ({
      location: r.location_name,
      window: `${r.window_start.slice(0, 16)} → ${r.window_end.slice(0, 16)}`,
      entries: r.entries_fetched,
      rows: r.rows_upserted,
      quarantined: r.quarantined,
      dates: r.dates.length,
      ms: r.duration_ms,
      error: r.error ?? "",
    })),
  );
  if (runs.some((r) => r.error)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
