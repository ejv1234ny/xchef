/**
 * pnpm sync — run the Toast sync locally until caught up.
 *   pnpm sync                 all locations, all pending chunks
 *   pnpm sync --chunks 2      limit chunks per pass
 */
import "./_env";
import { arg, log } from "./_env";
import { runToastSync } from "@/lib/jobs/toastSync";

async function main() {
  const maxChunks = arg("chunks") ? Number(arg("chunks")) : Number.POSITIVE_INFINITY;
  const { runs, caughtUp } = await runToastSync({ maxChunks, log });
  if (runs.length === 0) {
    console.log("No locations with Toast credentials. Run `pnpm creds` first.");
    return;
  }
  console.table(
    runs.map((r) => ({
      kind: r.kind,
      window: `${r.window_start.slice(0, 16)} → ${r.window_end.slice(0, 16)}`,
      fetched: r.orders_fetched,
      upserted: r.orders_upserted,
      quarantined: r.orders_quarantined,
      dates: r.dates_rebuilt.length,
      ms: r.duration_ms,
      error: r.error ?? "",
    })),
  );
  console.log(caughtUp ? "Caught up." : "More to do — run again.");
  if (runs.some((r) => r.error)) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
