"use client";

import { formatDuration } from "@/lib/format";
import { useChainStatus } from "@/lib/use-chain-status";

/** Finalized block height from the live V3 node; the dot reflects real reachability and block progress, nothing else. */
export function NetworkStatus({ compact = false }: { compact?: boolean }) {
  const status = useChainStatus();

  const dot = { up: "bg-accent", stalled: "bg-caution", down: "bg-critical", loading: "bg-muted" }[status.state];
  const title =
    status.state === "stalled"
      ? `PortalDot V3 has not finalized a block for ${formatDuration(status.ageSeconds)}. Transfers wait until it resumes.`
      : "Finalized block on the PortalDot V3 testnet";
  return (
    <span
      className={`inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs ${status.state === "stalled" ? "border-caution/30 bg-caution-soft text-caution" : "border-line bg-surface text-muted"}`}
      aria-live="polite"
      title={title}
    >
      <span className="relative flex size-1.5">
        {status.state === "up" && <span className={`live-ring absolute inset-0 rounded-full ${dot}`} aria-hidden />}
        <span className={`relative size-1.5 rounded-full ${dot}`} aria-hidden />
      </span>
      {!compact && <span className="hidden lg:inline">V3 testnet</span>}
      <span className={`font-mono tabular-nums ${status.state === "stalled" ? "" : "text-ink"}`}>
        {status.state === "up"
          ? `#${status.finalized.toLocaleString("en-US")}`
          : status.state === "stalled"
            ? `Paused ${formatDuration(status.ageSeconds)}`
            : status.state === "down"
              ? "Offline"
              : "Syncing"}
      </span>
      <span className="sr-only">{status.state === "stalled" ? "no new finalized blocks" : "finalized block"}</span>
    </span>
  );
}
