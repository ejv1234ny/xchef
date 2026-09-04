import Link from "next/link";

export const metadata = { title: "Offline" };
export const dynamic = "force-static";

/** Served by the service worker when a navigation fails with no network. Renders a plain link so it works with no JS. */
export default function OfflinePage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col items-center justify-center gap-4 px-6 py-12 text-center">
      <span aria-hidden className="text-5xl">
        📵
      </span>
      <h1 className="text-2xl font-semibold">You&apos;re offline</h1>
      <p className="text-sm text-neutral-600">
        xchef needs a connection to read your on-hand numbers. Walk-in coolers are notorious — step out, then try again.
      </p>
      <Link href="/" className="flex h-14 w-full items-center justify-center rounded-xl bg-neutral-900 text-base font-medium text-white">
        Retry
      </Link>
    </main>
  );
}
