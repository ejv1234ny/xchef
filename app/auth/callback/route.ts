import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { createServerSupabase } from "@/lib/db/server";

/** Magic-link landing: exchanges the PKCE code (or token_hash) for a session cookie. */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type") as EmailOtpType | null;
  const nextPath = searchParams.get("next") ?? "/";
  const next = nextPath.startsWith("/") ? nextPath : "/";

  const supabase = await createServerSupabase();
  let errorMessage: string | null = null;
  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    errorMessage = error?.message ?? null;
  } else if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    errorMessage = error?.message ?? null;
  } else {
    errorMessage = "Missing sign-in code";
  }
  if (errorMessage) return NextResponse.redirect(`${origin}/login?error=${encodeURIComponent(errorMessage)}`);
  return NextResponse.redirect(`${origin}${next}`);
}
