import { ArrowSquareOut } from "@phosphor-icons/react/dist/ssr";
import type { StatusEvent } from "@relaymesh/core";
import type { Wire } from "@/lib/api";
import { explorerBlockUrl, formatTime, shortHash, STATUS_META } from "@/lib/format";
import { Mono, Panel } from "./ui";

const TONE_RING: Record<string, string> = {
  neutral: "border-line-strong bg-surface",
  accent: "border-accent bg-accent-soft",
  positive: "border-positive bg-positive-soft",
  caution: "border-caution bg-caution-soft",
  critical: "border-critical bg-critical-soft",
};

/** Append-only status history, oldest first, with the evidence recorded at each step. */
export function Timeline({ history, wsUrl }: { history: Wire<StatusEvent>[]; wsUrl: string }) {
  return (
    <Panel title="Timeline">
      <ol className="grid">
        {history.map((event, i) => {
          const meta = STATUS_META[event.status];
          const last = i === history.length - 1;
          const e = event.evidence;
          return (
            <li key={event.seq} className="relative grid grid-cols-[1rem_minmax(0,1fr)] gap-3 pb-5 last:pb-0">
              {!last && <span className="absolute top-4 bottom-0 left-[7px] w-px bg-line" aria-hidden />}
              <span className={`mt-1 h-[15px] w-[15px] rounded-full border-2 ${TONE_RING[meta.tone]}`} aria-hidden />
              <div className="grid gap-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                  <span className="text-sm font-medium">{meta.label}</span>
                  <time className="font-mono text-xs text-muted" dateTime={new Date(event.at * 1000).toISOString()}>
                    {formatTime(event.at)}
                  </time>
                </div>
                <p className="text-sm leading-relaxed text-muted">{event.reason}</p>
                {e && (
                  <dl className="mt-1 grid gap-1 text-xs">
                    {e.txHash && (
                      <div className="flex gap-2">
                        <dt className="text-muted">Tx</dt>
                        <dd>
                          <Mono className="text-xs" title={e.txHash}>
                            {shortHash(e.txHash, 10, 6)}
                          </Mono>
                        </dd>
                      </div>
                    )}
                    {e.blockHash && (
                      <div className="flex gap-2">
                        <dt className="text-muted">Block</dt>
                        <dd>
                          <a href={explorerBlockUrl(wsUrl, e.blockHash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                            <Mono className="text-xs">{e.blockNumber ? `#${e.blockNumber}` : shortHash(e.blockHash)}</Mono>
                            <ArrowSquareOut size={12} />
                          </a>
                        </dd>
                      </div>
                    )}
                    <div className="flex gap-2">
                      <dt className="text-muted">Checked by</dt>
                      <dd>{e.finalized ? `${e.method}, finalized` : `${e.method}, not final yet`}</dd>
                    </div>
                  </dl>
                )}
              </div>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}
