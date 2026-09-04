import { sendMagicLink } from "./actions";

export const metadata = { title: "Sign in · xchef" };

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  const sp = await searchParams;
  const sent = typeof sp.sent === "string" ? sp.sent : null;
  const error = typeof sp.error === "string" ? sp.error : null;
  const next = typeof sp.next === "string" ? sp.next : "/";

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center gap-6 px-6 py-12">
      <div>
        <h1 className="text-3xl font-semibold tracking-tight">xchef</h1>
        <p className="mt-1 text-sm text-neutral-600">Usage, on-hand and prices, beside Toast.</p>
      </div>
      {sent ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm text-emerald-900">
          Check <strong>{sent}</strong> for a sign-in link. Open it on this phone to stay signed in here.
        </div>
      ) : (
        <form action={sendMagicLink} className="flex flex-col gap-3">
          <input type="hidden" name="next" value={next} />
          <label className="text-sm font-medium" htmlFor="email">
            Email
          </label>
          <input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            className="h-12 rounded-xl border border-neutral-300 px-4 text-base"
            placeholder="you@madmoose.com"
          />
          <button type="submit" className="h-12 rounded-xl bg-neutral-900 text-base font-medium text-white">
            Email me a sign-in link
          </button>
          {error ? <p className="text-sm text-red-700">{error}</p> : null}
        </form>
      )}
    </main>
  );
}
