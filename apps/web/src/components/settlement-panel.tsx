import type { ReactNode } from "react";
import { formatAmount, shortHash } from "@/lib/format";
import type { WireView } from "./intent-workspace";
import { Mono, Panel } from "./ui";

type CheckState = "done" | "pending" | "failed" | "skipped";

const STATE_TEXT: Record<CheckState, { label: string; className: string }> = {
  done: { label: "Verified", className: "text-positive" },
  pending: { label: "Pending", className: "text-caution" },
  failed: { label: "Failed", className: "text-critical" },
  skipped: { label: "Not reached", className: "text-muted" },
};

/** What has been proven so far, step by step, after the user signed. */
export function SettlementPanel({ view }: { view: WireView }) {
  const reached = new Set(view.history.map((e) => e.status));
  const failed = view.status === "FAILED_BEFORE_SOURCE";
  const review = view.status === "NEEDS_REVIEW";
  const quote = view.quotes.find((q) => q.quoteId === view.selectedQuoteId);
  const destination = [...view.history].reverse().find((e) => e.evidence?.kind === "destination_state")?.evidence;

  const checks: { title: string; detail: ReactNode; state: CheckState }[] = [
    {
      title: "Included on PortalDot V3",
      detail: "RelayMesh read the block itself and matched the extrinsic to the call you signed and the signer.",
      state: reached.has("SOURCE_SUBMITTED") ? "done" : failed ? "failed" : "pending",
    },
    {
      title: "Source finalized",
      detail: "The block is final under GRANDPA and still canonical at its height.",
      state: reached.has("SOURCE_CONFIRMED") ? "done" : failed ? "skipped" : review ? "failed" : "pending",
    },
    {
      title: "Funds observed on the EVM side",
      detail: destination?.amount ? (
        <>
          Observed <Mono>{formatAmount(destination.amount, view.intent.destination.chain)}</Mono>
          {quote && (
            <>
              {" "}
              against an expected <Mono>{formatAmount(quote.expectedOutput, view.intent.destination.chain)}</Mono>
            </>
          )}
          .
        </>
      ) : (
        <>
          The balance change for <Mono>{shortHash(view.intent.destination.recipient)}</Mono> is measured from the chain, not taken from any provider.
        </>
      ),
      state: reached.has("SETTLED") ? "done" : failed ? "skipped" : review ? "failed" : "pending",
    },
  ];

  return (
    <Panel title="Settlement">
      <div className="grid gap-5">
        {failed && (
          <p className="rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">{view.history.at(-1)?.reason ?? "The source transaction failed."}</p>
        )}
        {review && (
          <p className="rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">
            {view.history.at(-1)?.reason} Both observations are kept in the timeline. Nothing is marked settled.
          </p>
        )}
        <ol className="grid gap-4">
          {checks.map((c) => (
            <li key={c.title} className="grid gap-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="text-sm font-medium">{c.title}</span>
                <span className={`text-sm ${STATE_TEXT[c.state].className}`}>{STATE_TEXT[c.state].label}</span>
              </div>
              <p className="text-sm leading-relaxed text-muted">{c.detail}</p>
            </li>
          ))}
        </ol>
      </div>
    </Panel>
  );
}
