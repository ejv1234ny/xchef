/**
 * pnpm invoices:import-xlsx — import the Restaurant Depot receipt workbooks as
 * manual invoices for the first location, then map + post.
 *   pnpm invoices:import-xlsx
 *   pnpm invoices:import-xlsx --receipts fixtures/invoices/Restaurant_Depot_Receipts.xlsx --items fixtures/invoices/Restaurant_Depot_Items_8-6.xlsx
 *   pnpm invoices:import-xlsx --business "Mad Moose"     only receipts for that business name
 *   pnpm invoices:import-xlsx --dry                       parse the workbooks and print, no DB
 * Needs SUPABASE_SERVICE_ROLE_KEY (+ URL); ANTHROPIC_API_KEY for AI SKU matching.
 */
import "./_env";
import path from "node:path";
import { arg, hasFlag, log } from "./_env";
import { createServiceSupabase } from "@/lib/db/service";
import { importRestaurantDepot, loadCategoryIndex, parseReceiptsWorkbook } from "@/lib/jobs/importSpreadsheet";

async function main() {
  const itemsPath = path.resolve(process.cwd(), arg("items") ?? "fixtures/invoices/Restaurant_Depot_Items_8-6.xlsx");
  const receiptsPath = path.resolve(process.cwd(), arg("receipts") ?? "fixtures/invoices/Restaurant_Depot_Receipts.xlsx");
  const business = arg("business") ?? null;

  if (hasFlag("dry")) {
    const categories = loadCategoryIndex(itemsPath);
    const receipts = parseReceiptsWorkbook(receiptsPath, categories);
    console.table(
      receipts.map((r) => ({
        sheet: r.sheet,
        business: r.business,
        invoice: r.invoiceNumber,
        date: r.invoiceDate,
        lines: r.lines.length,
        subtotal: r.subtotal,
        total: r.total,
        categorized: r.lines.filter((l) => l.category_guess).length,
      })),
    );
    for (const r of receipts.slice(0, 1)) console.table(r.lines.slice(0, 8));
    return;
  }

  const svc = createServiceSupabase();
  let locationId = arg("location");
  if (!locationId) {
    const { data, error } = await svc.from("locations").select("id, name").order("created_at").limit(1);
    if (error) throw error;
    if (!data?.[0]) {
      console.log("No location found. Sign in once to bootstrap the tenant.");
      process.exit(1);
    }
    locationId = data[0].id;
    log("import: location", { id: locationId, name: data[0].name });
  }
  const results = await importRestaurantDepot(svc, { locationId, itemsPath, receiptsPath, log, business });
  console.table(results.map((r) => ({ sheet: r.sheet, invoice: r.invoiceNumber, date: r.invoiceDate, lines: r.lines, dup: r.duplicate, status: r.status, mapped: r.mapped, unmapped: r.unmapped, id: r.documentId.slice(0, 8) })));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
