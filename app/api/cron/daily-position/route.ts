import { NextResponse, type NextRequest } from "next/server";
import { runDailyPosition } from "@/lib/jobs/dailyPosition";
import { authorizeCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * 0 9 * * * UTC (5 a.m. Eastern): reconcile yesterday's business date for every
 * location with a Toast credential or any inventory, plus any earlier dates a
 * late invoice, sales rebuild, backdated count or recipe change touched.
 * `?date=YYYY-MM-DD` (repeatable) recomputes specific dates by hand.
 */
export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const dates = request.nextUrl.searchParams.getAll("date").filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  try {
    const result = await runDailyPosition({
      dates: dates.length ? dates : undefined,
      log: (msg, meta) => console.log(JSON.stringify({ msg, ...meta })),
    });
    const status = result.runs.some((r) => r.error) ? 500 : 200;
    return NextResponse.json(result, { status });
  } catch (e) {
    console.error("daily-position failed", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
