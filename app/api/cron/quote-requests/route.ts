import { NextResponse, type NextRequest } from "next/server";
import { createServiceSupabase } from "@/lib/db/service";
import { requestsForPriceShock, sendQuoteRequests } from "@/lib/jobs/quoteRequest";
import { authorizeCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Monday 13:00 UTC (9 a.m. Eastern): the weekly pricing request to every vendor
 * with a contact and at least one mapping, then a request for any vendor whose
 * ingredient shows a ≥ 10% 30-day price change (verification_queue). Both honor
 * the once-per-vendor-per-7-days rule, so a vendor never gets two emails.
 * `?dry=1` composes without sending.
 */
export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dry = request.nextUrl.searchParams.get("dry") === "1";
  const log = (msg: string, meta?: Record<string, unknown>) => console.log(JSON.stringify({ msg, ...meta }));
  try {
    const svc = createServiceSupabase();
    const { data: locations, error } = await svc.from("locations").select("id, name").order("created_at");
    if (error) throw new Error(`read locations: ${error.message}`);
    const out: Array<{ location: string; weekly: unknown[]; price_shock: unknown[] }> = [];
    for (const loc of locations ?? []) {
      const weekly = await sendQuoteRequests({ locationId: loc.id, dry, log, svc });
      const shock = await requestsForPriceShock({ locationId: loc.id, dry, log, svc });
      out.push({
        location: loc.name,
        weekly: weekly.map((r) => ({ vendor: r.vendorName, sent: r.sent, skipped: r.skipped, items: r.items.length })),
        price_shock: shock.map((r) => ({ vendor: r.vendorName, sent: r.sent, skipped: r.skipped, items: r.items.length })),
      });
    }
    return NextResponse.json({ dry, locations: out });
  } catch (e) {
    console.error("quote-requests failed", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
