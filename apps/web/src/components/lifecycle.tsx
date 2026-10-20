import { Check, X } from "@phosphor-icons/react/dist/ssr";
import type { IntentStatus } from "@relaymesh/core";

const STAGES = ["Quote", "Sign", "Include", "Finalize", "Settle"] as const;

/** Index of the stage currently being worked on; STAGES.length means all done. */
const ACTIVE_STAGE: Partial<Record<IntentStatus, number>> = {
  DRAFT: 0,
  QUOTED: 1,
  AWAITING_SIGNATURE: 1,
  SOURCE_SUBMITTED: 3,
  SOURCE_CONFIRMED: 4,
  DESTINATION_PENDING: 4,
  SETTLED: STAGES.length,
};

const TERMINAL_STOPS = new Set<IntentStatus>(["EXPIRED", "FAILED_BEFORE_SOURCE", "NEEDS_REVIEW"]);

/**
 * Five-stage progress for an intent. For terminal stops (expired, failed, needs review) the stage
 * reached before the stop is marked, so the user sees where it ended, not just that it ended.
 */
export function Lifecycle({ statuses }: { statuses: IntentStatus[] }) {
  const current = statuses.at(-1) ?? "DRAFT";
  const stopped = TERMINAL_STOPS.has(current);
  const lastProgress = [...statuses].reverse().find((s) => ACTIVE_STAGE[s] !== undefined) ?? "DRAFT";
  // A failed extrinsic was included, so it stopped at Include, not Sign.
  const active = current === "FAILED_BEFORE_SOURCE" ? 2 : (ACTIVE_STAGE[stopped ? lastProgress : current] ?? 0);
  const waitingOnChain = !stopped && active >= 2 && active < STAGES.length;

  return (
    <ol className="grid grid-cols-5 gap-1.5" aria-label="Progress">
      {STAGES.map((label, i) => {
        const done = i < active;
        const isActive = i === active && active < STAGES.length;
        const failed = isActive && stopped && current !== "EXPIRED";
        const halted = isActive && current === "EXPIRED";
        const bar = done ? "bg-accent" : failed ? "bg-critical" : isActive && !halted ? "bg-accent/40" : "bg-line";
        return (
          <li key={label} className="grid gap-2" aria-current={isActive ? "step" : undefined}>
            <span className={`h-1 rounded-full transition-colors duration-300 ${bar}`} aria-hidden />
            <span className={`flex items-center gap-1.5 text-xs ${done || isActive ? "text-ink" : "text-muted"}`}>
              {done && <Check size={12} weight="bold" className="text-accent" />}
              {failed && <X size={12} weight="bold" className="text-critical" />}
              {isActive && !failed && waitingOnChain && (
                <span className="relative flex size-1.5" aria-hidden>
                  <span className="live-ring absolute inset-0 rounded-full bg-accent" />
                  <span className="relative size-1.5 rounded-full bg-accent" />
                </span>
              )}
              <span className={isActive ? "font-medium" : ""}>{label}</span>
              <span className="sr-only">{done ? "done" : failed ? "stopped here" : halted ? "expired here" : isActive ? "in progress" : "not started"}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
