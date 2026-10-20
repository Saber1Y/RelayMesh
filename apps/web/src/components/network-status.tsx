"use client";

import { useEffect, useState } from "react";

type Status = { state: "loading" } | { state: "up"; finalized: number } | { state: "down" };

const POLL_MS = 12_000;

/** Finalized block height from the live V3 node; the dot reflects real reachability, nothing else. */
export function NetworkStatus({ compact = false }: { compact?: boolean }) {
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

  const dot = status.state === "up" ? "bg-accent" : status.state === "down" ? "bg-critical" : "bg-muted";
  return (
    <span
      className="inline-flex items-center gap-2 rounded-full border border-line bg-canvas/60 px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted"
      aria-live="polite"
      title="Finalized block on the PortalDot V3 testnet"
    >
      <span className="relative flex size-1.5">
        {status.state === "up" && <span className={`live-ring absolute inset-0 rounded-full ${dot}`} aria-hidden />}
        <span className={`relative size-1.5 rounded-full ${dot}`} aria-hidden />
      </span>
      {!compact && <span className="hidden lg:inline">V3</span>}
      <span className="text-ink tabular-nums">
        {status.state === "up" ? `#${status.finalized.toLocaleString("en-US")}` : status.state === "down" ? "Offline" : "Syncing"}
      </span>
      <span className="sr-only">finalized block</span>
    </span>
  );
}
