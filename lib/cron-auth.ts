import type { NextRequest } from "next/server";
import { env } from "@/lib/env";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`; `?secret=` is for manual runs. */
export function authorizeCron(request: NextRequest): boolean {
  const secret = env.cronSecret();
  const header = request.headers.get("authorization");
  if (header === `Bearer ${secret}`) return true;
  return request.nextUrl.searchParams.get("secret") === secret;
}
