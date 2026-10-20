import { ArrowUpRight, ClockCounterClockwise, Path, Pulse } from "@phosphor-icons/react/dist/ssr";
import type { Metadata } from "next";
import Link from "next/link";
import { countIntentsByStatus, listRecentIntents } from "@relaymesh/db";
import { IntentForm } from "@/components/intent-form";
import { PageShell } from "@/components/page-shell";
import { Badge, Panel, stagger } from "@/components/ui";
import { formatAmount, shortHash, STATUS_META } from "@/lib/format";
import { describeProviders, getDb, v3Config } from "@/server/services";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Desk | RelayMesh" };

const LIVE_STATUSES = new Set(["SOURCE_SUBMITTED", "SOURCE_CONFIRMED", "DESTINATION_PENDING"]);

export default async function DeskPage() {
  const db = getDb();
  const [counts, recent] = await Promise.all([countIntentsByStatus(db), listRecentIntents(db, 6)]);
  const providers = describeProviders();
  const inFlight = counts.SOURCE_SUBMITTED + counts.SOURCE_CONFIRMED + counts.DESTINATION_PENDING;

  return (
    <PageShell>
      <div className="enter mb-8 grid gap-3" style={stagger(0)}>
        <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">Routing desk</p>
        <h1 className="text-4xl font-semibold leading-[0.98] tracking-[-0.05em] md:text-5xl">Start a transfer</h1>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <IntentForm />

        <aside className="grid content-start gap-6">
          <Panel title="Ledger" icon={<Pulse />} tag={<span className="font-mono text-[9px] text-accent">REAL / LIVE</span>} index={2}>
            <dl className="grid grid-cols-3 gap-4">
              <div className="grid gap-2 border-t border-line pt-3">
                <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Settled</dt>
                <dd className="text-2xl font-semibold tracking-[-0.04em] text-accent tabular-nums">{counts.SETTLED}</dd>
              </div>
              <div className="grid gap-2 border-t border-line pt-3">
                <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">In flight</dt>
                <dd className="text-2xl font-semibold tracking-[-0.04em] tabular-nums">{inFlight}</dd>
              </div>
              <div className="grid gap-2 border-t border-line pt-3">
                <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Review</dt>
                <dd className={`text-2xl font-semibold tracking-[-0.04em] tabular-nums ${counts.NEEDS_REVIEW > 0 ? "text-critical" : ""}`}>{counts.NEEDS_REVIEW}</dd>
              </div>
            </dl>
            <p className="mt-4 font-mono text-[11px] text-muted">
              Chain {v3Config.evmChainId} · PortalDot V3 testnet
            </p>
          </Panel>

          <Panel title="Routes" icon={<Path />} index={3}>
            <ul className="grid gap-3">
              {providers.map((p) => (
                <li key={p.id} className="grid gap-1.5 rounded-[10px] border border-line bg-canvas/40 p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm font-medium">{p.name}</span>
                    {p.status.available ? (
                      <Badge tone="accent" live>
                        Live
                      </Badge>
                    ) : (
                      <Badge tone="neutral">Unavailable</Badge>
                    )}
                  </div>
                  <p className="text-[13px] leading-relaxed text-muted">{p.status.available ? p.description : p.status.reason}</p>
                </li>
              ))}
            </ul>
          </Panel>

          <Panel title="Recent intents" icon={<ClockCounterClockwise />} index={4}>
            {recent.length === 0 ? (
              <p className="text-sm text-muted">No intents yet. Your first quote will appear here.</p>
            ) : (
              <ul className="-mx-2 grid">
                {recent.map((r) => {
                  const meta = STATUS_META[r.status];
                  return (
                    <li key={r.intentId}>
                      <Link
                        href={`/intents/${r.intentId}`}
                        className="group grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-[10px] px-2 py-2.5 transition-colors hover:bg-white/[0.04]"
                      >
                        <span className="text-sm font-medium tabular-nums">{formatAmount(r.sourceAmount, r.sourceChain)}</span>
                        <Badge tone={meta.tone} live={LIVE_STATUSES.has(r.status)}>
                          {meta.label}
                        </Badge>
                        <span className="flex items-center gap-1 font-mono text-[11px] text-muted">
                          to {shortHash(r.recipient)}
                          <ArrowUpRight size={11} className="opacity-0 transition-opacity group-hover:opacity-100" />
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </aside>
      </div>
    </PageShell>
  );
}
