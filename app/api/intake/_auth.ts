import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createServerSupabase } from "@/lib/db/server";
import { createServiceSupabase, type ServiceClient } from "@/lib/db/service";

/**
 * Shared by the intake routes: the signed-in user (anon key + cookie session,
 * RLS applies) resolves their tenant's location; the pipeline itself then runs
 * with the service role. Not a route file (no HTTP exports).
 *
 * Second path (vendor-portal pull, KICKOFF-2 Part 2): header `x-intake-key`
 * equal to env INTAKE_API_KEY. No user; the location comes from
 * `?location=<uuid>` or defaults to the first location. Documents created
 * this way are `source = 'api'`.
 */
export type IntakeAuth = { svc: ServiceClient; userId: string; locationId: string; tenantId: string; viaKey?: false };
export type IntakeKeyAuth = { svc: ServiceClient; userId: null; locationId: string; tenantId: string; viaKey: true };

export const INTAKE_KEY_HEADER = "x-intake-key";

export async function authenticateIntake(): Promise<IntakeAuth | NextResponse> {
  const supabase = await createServerSupabase();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const { data: locations, error } = await supabase.from("locations").select("id, tenant_id").order("created_at").limit(1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const location = locations?.[0];
  if (!location) return NextResponse.json({ error: "no location for this account" }, { status: 403 });
  return { svc: createServiceSupabase(), userId: user.id, locationId: location.id, tenantId: location.tenant_id };
}

/** Constant-time equality on fixed-length digests, so neither length nor content leaks through timing. */
export function intakeKeyMatches(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!given || !expected) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `x-intake-key` path. 503 when INTAKE_API_KEY is not configured on the
 * server, 401 when the header is missing or wrong, 404 when `?location` names
 * an unknown location. Never echoes the key.
 */
export async function authenticateIntakeKey(request: NextRequest): Promise<IntakeKeyAuth | NextResponse> {
  const expected = process.env.INTAKE_API_KEY;
  if (!expected) return NextResponse.json({ error: "intake key not configured" }, { status: 503 });
  const given = request.headers.get(INTAKE_KEY_HEADER);
  if (!intakeKeyMatches(given, expected)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const svc = createServiceSupabase();
  const wanted = request.nextUrl.searchParams.get("location");
  if (wanted) {
    if (!UUID_RE.test(wanted)) return NextResponse.json({ error: "location must be a uuid" }, { status: 400 });
    const { data, error } = await svc.from("locations").select("id, tenant_id").eq("id", wanted).maybeSingle();
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (!data) return NextResponse.json({ error: "location not found" }, { status: 404 });
    return { svc, userId: null, locationId: data.id, tenantId: data.tenant_id, viaKey: true };
  }
  const { data, error } = await svc.from("locations").select("id, tenant_id").order("created_at").limit(1);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const location = data?.[0];
  if (!location) return NextResponse.json({ error: "no location configured" }, { status: 404 });
  return { svc, userId: null, locationId: location.id, tenantId: location.tenant_id, viaKey: true };
}

export function isResponse(x: unknown): x is NextResponse {
  return x instanceof NextResponse;
}

export function errorResponse(e: unknown, status = 500): NextResponse {
  const message = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: message }, { status });
}
