import { ArrowLeft, ArrowRight, ArrowSquareOut, DownloadSimple } from "@phosphor-icons/react/dist/ssr";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Hex } from "viem";
import { buildReceipt, hashReceipt, type ReceiptLeg } from "@relaymesh/core";
import { listQuotes, loadIntent } from "@relaymesh/db";
import { CopyButton } from "@/components/copy-button";
import { Badge, Mono, Panel, stagger } from "@/components/ui";
import { explorerBlockUrl, formatAmount, formatTime, shortHash, STATUS_META } from "@/lib/format";
import { HEX16 } from "@/server/http";
import { getDb, v3Config } from "@/server/services";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Receipt | RelayMesh" };

const MODE_TEXT: Record<string, string> = {
  destination_rpc_state: "RelayMesh read the destination chain directly",
  provider_status_plus_destination_rpc: "Provider status, confirmed by reading the destination chain",
  provider_report_only: "Provider report only, not independently verified",
};

function LegRows({ leg, wsUrl }: { leg: ReceiptLeg; wsUrl: string }) {
  return (
    <>
      <Row label="Transaction" compact>
        {leg.txHash ? <Hash value={leg.txHash} label="Copy transaction hash" /> : <span className="text-muted">Not observed yet</span>}
      </Row>
      <Row label="Block" compact>
        {leg.blockHash ? (
          <span className="inline-flex items-center gap-1">
            <a href={explorerBlockUrl(wsUrl, leg.blockHash)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
              <Mono>{leg.blockNumber !== null ? `#${leg.blockNumber}` : shortHash(leg.blockHash)}</Mono>
              <ArrowSquareOut size={12} />
            </a>
            <CopyButton value={leg.blockHash} label="Copy block hash" />
          </span>
        ) : leg.blockNumber !== null ? (
          <Mono>#{leg.blockNumber}</Mono>
        ) : (
          <span className="text-muted">Not observed yet</span>
        )}
      </Row>
      <Row label="Finalized" compact>
        {leg.finalized ? <span className="text-positive">Yes</span> : <span className="text-muted">No</span>}
      </Row>
      <Row label="Verified by" compact>
        {leg.verifiedBy ? <Mono className="text-[12px]">{leg.verifiedBy}</Mono> : <span className="text-muted">Not verified yet</span>}
      </Row>
    </>
  );
}

function Hash({ value, label, full = false }: { value: string; label: string; full?: boolean }) {
  return (
    <span className="inline-flex max-w-full items-center gap-1">
      <Mono className={full ? "break-all" : ""} title={value}>
        {full ? value : shortHash(value, 10, 8)}
      </Mono>
      <CopyButton value={value} label={label} />
    </span>
  );
}

function Row({ label, children, compact = false }: { label: string; children: ReactNode; compact?: boolean }) {
  return (
    <div className={`grid gap-1 py-3 first:pt-0 last:pb-0 ${compact ? "grid-cols-[6.5rem_minmax(0,1fr)] gap-3" : "sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4"}`}>
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

export default async function ReceiptPage({ params }: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await params;
  if (!HEX16.test(intentId)) notFound();
  const db = getDb();
  const stored = await loadIntent(db, intentId as Hex);
  if (!stored) notFound();
  const quote = (await listQuotes(db, intentId as Hex)).find((q) => q.quoteId === stored.selectedQuoteId);

  if (!quote) {
    return (
      <div className="mx-auto grid max-w-2xl gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">No receipt yet</h1>
        <p className="text-muted">A receipt exists once a route has been selected for this intent.</p>
        <Link href={`/intents/${intentId}`} className="text-accent hover:underline">
          Back to the intent
        </Link>
      </div>
    );
  }

  const receipt = buildReceipt({ intent: stored.intent, intentHash: stored.intentHash, quote, history: stored.history });
  const receiptHash = hashReceipt(receipt);
  const meta = STATUS_META[receipt.status];
  const { source, destination } = receipt;

  const settled = receipt.status === "SETTLED";

  return (
    <div className="mx-auto grid max-w-3xl gap-6">
      <div className="enter grid gap-5" style={stagger(0)}>
        <Link href={`/intents/${intentId}`} className="press inline-flex w-fit items-center gap-1.5 rounded-md text-sm text-muted hover:text-ink">
          <ArrowLeft size={14} />
          Back to intent
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div className="grid gap-2">
            <Badge tone={meta.tone}>{meta.label}</Badge>
            <h1 className="text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Settlement receipt</h1>
            <p className="max-w-[56ch] text-sm text-muted">
              {receipt.verificationMode ? MODE_TEXT[receipt.verificationMode] : settled ? "" : "Not settled. This receipt shows what has been recorded so far."}
            </p>
          </div>
          <a
            href={`/api/intents/${intentId}/receipt?download=1`}
            className="press group inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2.5 text-sm font-medium text-accent-ink shadow-[0_1px_0_rgb(255_255_255/0.15)_inset] hover:bg-accent-hover"
          >
            <DownloadSimple size={16} className="transition-transform duration-200 group-hover:translate-y-px" />
            Download JSON
          </a>
        </div>
      </div>

      <Panel index={1}>
        <div className="grid items-center gap-5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
          <div className="grid gap-1">
            <span className="text-[13px] text-muted">Sent from PortalDot V3 Substrate</span>
            <span className="text-2xl font-semibold tracking-tight tabular-nums">{formatAmount(source.amount, source.chain, source.asset)}</span>
            <Hash value={source.requester} label="Copy sender address" />
          </div>
          <span className="flex size-9 items-center justify-center justify-self-start rounded-full border border-line bg-raised text-muted sm:justify-self-center" aria-hidden>
            <ArrowRight size={16} className="rotate-90 sm:rotate-0" />
          </span>
          <div className="grid gap-1 sm:text-right sm:justify-items-end">
            <span className="text-[13px] text-muted">{destination.observedAmount !== null ? "Observed on PortalDot V3 EVM" : "Expected on PortalDot V3 EVM"}</span>
            <span className={`text-2xl font-semibold tracking-tight tabular-nums ${destination.observedAmount !== null ? "" : "text-muted"}`}>
              {formatAmount(destination.observedAmount ?? destination.expectedOutput, destination.chain, destination.asset)}
            </span>
            <Hash value={destination.recipient} label="Copy recipient address" />
          </div>
        </div>
        <dl className={`mt-5 grid gap-x-6 gap-y-3 border-t border-line pt-4 text-sm ${destination.observedAmount !== null ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
          {destination.observedAmount !== null && (
            <div className="grid gap-0.5">
              <dt className="text-[13px] text-muted">Expected</dt>
              <dd className="tabular-nums">{formatAmount(destination.expectedOutput, destination.chain, destination.asset)}</dd>
            </div>
          )}
          <div className="grid gap-0.5">
            <dt className="text-[13px] text-muted">Route</dt>
            <dd>
              {receipt.route.provider} <span className="text-muted">({receipt.route.routeId})</span>
            </dd>
          </div>
          <div className="grid gap-0.5">
            <dt className="text-[13px] text-muted">Verification</dt>
            <dd>{receipt.verificationMode ?? <span className="text-muted">Pending</span>}</dd>
          </div>
        </dl>
      </Panel>

      <div className="grid gap-6 md:grid-cols-2">
        <Panel title="Source leg" description="PortalDot V3 Substrate" index={2}>
          <dl className="divide-y divide-line">
            <LegRows leg={source} wsUrl={v3Config.wsUrl} />
          </dl>
        </Panel>
        <Panel title="Destination leg" description="PortalDot V3 EVM" index={3}>
          <dl className="divide-y divide-line">
            <LegRows leg={destination} wsUrl={v3Config.wsUrl} />
          </dl>
        </Panel>
      </div>

      <Panel title="Integrity" description="Recompute these from the downloaded file to check this receipt independently." index={4}>
        <dl className="divide-y divide-line">
          <Row label="Intent hash">
            <Hash value={receipt.intentHash} label="Copy intent hash" full />
          </Row>
          <Row label="Receipt hash">
            <Hash value={receiptHash} label="Copy receipt hash" full />
          </Row>
        </dl>
        <p className="mt-4 rounded-lg bg-raised/70 px-3 py-2.5 text-[13px] leading-relaxed text-muted">
          Receipt hash = keccak256 of <Mono className="text-[12px] text-ink">relaymesh.receipt.v1</Mono>, a newline, and the downloaded JSON.
        </p>
      </Panel>

      <Panel title="Timeline" index={5}>
        <ol className="grid gap-3">
          {receipt.timeline.map((t) => (
            <li key={t.seq} className="grid gap-0.5 sm:grid-cols-[7.5rem_9.5rem_minmax(0,1fr)] sm:gap-4">
              <time className="font-mono text-xs text-muted tabular-nums">{formatTime(t.at)}</time>
              <span className="text-sm font-medium">{STATUS_META[t.status].label}</span>
              <span className="text-sm break-words text-muted">{t.reason}</span>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}
