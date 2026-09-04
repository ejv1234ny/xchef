import { NextResponse, type NextRequest } from "next/server";
import { runToastSync } from "@/lib/jobs/toastSync";
import { authorizeCron } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET(request: NextRequest) {
  if (!authorizeCron(request)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  try {
    const result = await runToastSync({
      maxChunks: 3,
      log: (msg, meta) => console.log(JSON.stringify({ msg, ...meta })),
    });
    return NextResponse.json(result);
  } catch (e) {
    console.error("toast-sync failed", e);
    return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
