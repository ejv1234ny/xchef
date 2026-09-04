/**
 * pnpm recipes:draft [--limit N] [--all] [--days N]
 * Draft recipes with Claude for the first location's most-sold menu items.
 *   --limit N  cap the number of items (default 10)
 *   --all      include items that already have (unconfirmed) components; confirmed rows are never overwritten
 *   --days N   sales window in days (default 30)
 */
import "./_env";
import { arg, hasFlag, log } from "./_env";
import { createServiceSupabase } from "@/lib/db/service";
import { draftRecipes } from "@/lib/jobs/recipeDraft";

async function main() {
  const svc = createServiceSupabase();
  const { data: locations, error } = await svc.from("locations").select("*").order("created_at").limit(1);
  if (error) throw error;
  const location = locations?.[0];
  if (!location) {
    console.log("No location yet. Sign in to the app once to bootstrap the tenant.");
    return;
  }
  const limitArg = arg("limit");
  const daysArg = arg("days");
  const limit = limitArg ? Number(limitArg) : 10;
  if (!Number.isFinite(limit) || limit <= 0) throw new Error(`Bad --limit: ${limitArg}`);
  const soldWithinDays = daysArg ? Number(daysArg) : 30;
  if (!Number.isFinite(soldWithinDays) || soldWithinDays <= 0) throw new Error(`Bad --days: ${daysArg}`);

  log("recipes:draft", { location: location.name, limit, all: hasFlag("all"), days: soldWithinDays });
  const result = await draftRecipes(svc, {
    tenantId: location.tenant_id,
    locationId: location.id,
    limit,
    onlyWithoutComponents: !hasFlag("all"),
    soldWithinDays,
    log,
  });
  console.table([result]);
  if (result.errors > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
