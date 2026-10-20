"use client";

import { useEffect, useState } from "react";

type Status = { state: "loading" } | { state: "up"; finalized: number } | { state: "down" };

const POLL_MS = 12_000;

/** Finalized block height from the live V3 node; the dot reflects real reachability, nothing else. */
export function NetworkStatus() {
  const [status, setStatus] = useState<Status>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/network")
        .then((r) => r.json() as Promise<{ reachable: boolean; finalized?: number }>)
        .then((d) => !cancelled && setStatus(d.reachable && d.finalized !== undefined ? { state: "up", finalized: d.finalized } : { state: "down" }))
        .catch(() => !cancelled && setStatus({ state: "down" }));
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  const dot = status.state === "up" ? "bg-positive" : status.state === "down" ? "bg-critical" : "bg-line-strong";
  return (
    <span className="inline-flex items-center gap-2 rounded-lg border border-line bg-surface/70 px-2.5 py-1 text-xs text-muted" aria-live="polite">
      <span className="relative flex size-1.5">
        {status.state === "up" && <span className={`live-ring absolute inset-0 rounded-full ${dot}`} aria-hidden />}
        <span className={`relative size-1.5 rounded-full ${dot}`} aria-hidden />
      </span>
      <span className="hidden sm:inline">V3 testnet</span>
      <span className="font-mono tabular-nums text-ink">
        {status.state === "up" ? `#${status.finalized.toLocaleString("en-US")}` : status.state === "down" ? "unreachable" : "connecting"}
      </span>
      <span className="sr-only">finalized block</span>
    </span>
  );
}
