import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/db/server";
import { createServiceSupabase, type ServiceClient } from "@/lib/db/service";

/**
 * Shared by the intake routes: the signed-in user (anon key + cookie session,
 * RLS applies) resolves their tenant's location; the pipeline itself then runs
 * with the service role. Not a route file (no HTTP exports).
 */
export type IntakeAuth = { svc: ServiceClient; userId: string; locationId: string; tenantId: string };

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

export function isResponse(x: unknown): x is NextResponse {
  return x instanceof NextResponse;
}

export function errorResponse(e: unknown, status = 500): NextResponse {
  const message = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: message }, { status });
}
