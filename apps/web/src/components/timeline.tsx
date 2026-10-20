import { ArrowSquareOut } from "@phosphor-icons/react/dist/ssr";
import type { IntentStatus, StatusEvent } from "@relaymesh/core";
import type { Wire } from "@/lib/api";
import { explorerBlockUrl, formatTime, shortHash } from "@/lib/format";
import { CopyButton } from "./copy-button";
import { stagger } from "./ui";

// Event color grammar: system blue, waiting amber, success green, failure red.
const EVENT_STYLE: Record<IntentStatus, { tag: string; className: string }> = {
  DRAFT: { tag: "INTENT_CREATED", className: "text-info" },
  QUOTED: { tag: "QUOTED", className: "text-info" },
  AWAITING_SIGNATURE: { tag: "AWAITING_SIGNATURE", className: "text-caution" },
  SOURCE_SUBMITTED: { tag: "IN_BLOCK", className: "text-caution" },
  SOURCE_CONFIRMED: { tag: "SOURCE_FINAL", className: "text-positive" },
  DESTINATION_PENDING: { tag: "CHECKING_DESTINATION", className: "text-caution" },
  SETTLED: { tag: "SETTLED", className: "text-positive" },
  EXPIRED: { tag: "EXPIRED", className: "text-muted" },
  FAILED_BEFORE_SOURCE: { tag: "FAILED", className: "text-critical" },
  NEEDS_REVIEW: { tag: "NEEDS_REVIEW", className: "text-critical" },
};

/** Append-only status history rendered as a settlement log, with the evidence recorded at each step. */
export function Timeline({ history, wsUrl, file = "settlement.log" }: { history: Wire<StatusEvent>[]; wsUrl: string; file?: string }) {
  return (
    <section className="enter overflow-hidden rounded-2xl border border-line bg-canvas shadow-lift" style={stagger(2)} aria-label="Timeline">
      <div className="flex items-center gap-2 border-b border-line bg-[#121214] px-4 py-3">
        <span className="size-2.5 rounded-full bg-critical/70" aria-hidden />
        <span className="size-2.5 rounded-full bg-caution/70" aria-hidden />
        <span className="size-2.5 rounded-full bg-positive/70" aria-hidden />
        <span className="ml-2 font-mono text-[10px] text-muted">{file}</span>
        <span className="ml-auto font-mono text-[9px] tracking-[0.14em] text-muted">APPEND-ONLY</span>
      </div>
      <ol className="grid gap-3.5 p-5 font-mono text-[12.5px] leading-relaxed">
        {history.map((event) => {
          const style = EVENT_STYLE[event.status];
          const e = event.evidence;
          return (
            <li key={event.seq} className="enter grid gap-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <time className="text-muted/70 tabular-nums" dateTime={new Date(event.at * 1000).toISOString()}>
                  {formatTime(event.at).replace(" UTC", "")}
                </time>
                <span className={`font-semibold ${style.className}`}>{style.tag}</span>
              </div>
              <p className="break-words text-ink/75">{event.reason}</p>
              {e && (
                <dl className="grid gap-0.5 border-l border-line pl-3 text-[11.5px] text-muted">
                  {e.txHash && (
                    <div className="flex items-center gap-2">
                      <dt>tx</dt>
                      <dd className="flex items-center gap-0.5 text-ink/80">
                        <span title={e.txHash}>{shortHash(e.txHash, 10, 6)}</span>
                        <CopyButton value={e.txHash} label="Copy transaction hash" />
                      </dd>
                    </div>
                  )}
                  {(e.blockNumber || e.blockHash) && (
                    <div className="flex items-center gap-2">
                      <dt>block</dt>
                      <dd>
                        <a
                          href={explorerBlockUrl(wsUrl, e.blockNumber ?? e.blockHash ?? "")}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-accent hover:underline"
                        >
                          {e.blockNumber ? `#${e.blockNumber}` : shortHash(e.blockHash ?? "")}
                          <ArrowSquareOut size={11} />
                        </a>
                      </dd>
                    </div>
                  )}
                  <div className="flex items-center gap-2">
                    <dt>via</dt>
                    <dd className="text-ink/80">
                      {e.method}
                      <span className={e.finalized ? "text-positive" : "text-caution"}>{e.finalized ? " / final" : " / not final"}</span>
                    </dd>
                  </div>
                </dl>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
