"use client";

import { useEffect } from "react";

/** Registers /sw.js in production only. Renders nothing. */
export function ServiceWorkerRegister() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {
      // Offline shell is a convenience; the app works without it.
    });
  }, []);
  return null;
}
