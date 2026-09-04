"use client";

import { useState } from "react";

/** The inbound invoice address with a tap-to-copy button (phone first). */
export function CopyAddress({ address }: { address: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(address);
      setState("copied");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  }
  return (
    <div className="flex flex-col items-center gap-2 text-center text-xs text-neutral-500">
      <span>Or forward invoices to</span>
      <button type="button" onClick={copy} className="flex min-h-11 max-w-full items-center gap-2 rounded-xl border border-neutral-300 bg-white px-3 text-sm text-neutral-900">
        <code className="break-all">{address}</code>
        <span className="shrink-0 rounded-lg bg-neutral-100 px-2 py-1 text-xs">{state === "copied" ? "Copied ✓" : state === "failed" ? "Select & copy" : "Copy"}</span>
      </button>
    </div>
  );
}
