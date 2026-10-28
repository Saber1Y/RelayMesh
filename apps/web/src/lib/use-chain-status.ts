"use client";

import { useEffect, useState } from "react";

/**
 * Finality normally trails the newest block by two or three blocks (about 18 s on V3). Past this,
 * the chain has stopped producing or finalizing blocks.
 */
export const STALL_SECONDS = 90;
const POLL_MS = 12_000;

export type ChainStatus =
  | { state: "loading" }
  | { state: "up"; finalized: number }
  | { state: "stalled"; finalized: number; ageSeconds: number }
  | { state: "down" };

/** Polls the server's view of the V3 chain: reachable, finalizing normally, or stalled. */
export function useChainStatus(): ChainStatus {
  const [status, setStatus] = useState<ChainStatus>({ state: "loading" });

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      fetch("/api/network")
        .then((r) => r.json() as Promise<{ reachable: boolean; finalized?: number; finalizedAgeSeconds?: number }>)
        .then((d) => {
          if (cancelled) return;
          if (!d.reachable || d.finalized === undefined) return setStatus({ state: "down" });
          const age = d.finalizedAgeSeconds ?? 0;
          setStatus(age > STALL_SECONDS ? { state: "stalled", finalized: d.finalized, ageSeconds: age } : { state: "up", finalized: d.finalized });
        })
        .catch(() => !cancelled && setStatus({ state: "down" }));
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  return status;
}
