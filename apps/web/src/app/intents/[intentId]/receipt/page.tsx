import { ArrowLeft, DownloadSimple } from "@phosphor-icons/react/dist/ssr";
import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { Hex } from "viem";
import { buildReceipt, hashReceipt, type ReceiptLeg } from "@relaymesh/core";
import { listQuotes, loadIntent } from "@relaymesh/db";
import { Badge, Mono, Panel } from "@/components/ui";
import { explorerBlockUrl, formatAmount, formatTime, STATUS_META } from "@/lib/format";
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
      <Row label="Transaction">{leg.txHash ? <Mono className="break-all">{leg.txHash}</Mono> : <span className="text-muted">Not observed yet</span>}</Row>
      <Row label="Block">
        {leg.blockHash ? (
          <a href={explorerBlockUrl(wsUrl, leg.blockHash)} target="_blank" rel="noreferrer" className="text-accent hover:underline">
            <Mono className="break-all">{leg.blockNumber !== null ? `#${leg.blockNumber} ` : ""}{leg.blockHash}</Mono>
          </a>
        ) : leg.blockNumber !== null ? (
          <Mono>#{leg.blockNumber}</Mono>
        ) : (
          <span className="text-muted">Not observed yet</span>
        )}
      </Row>
      <Row label="Finalized">{leg.finalized ? "Yes" : "No"}</Row>
      <Row label="Verified by">{leg.verifiedBy ?? <span className="text-muted">Not verified yet</span>}</Row>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-sm">{children}</dd>
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

  return (
    <div className="mx-auto grid max-w-3xl gap-8">
      <div className="grid gap-4">
        <Link href={`/intents/${intentId}`} className="inline-flex w-fit items-center gap-1.5 text-sm text-muted hover:text-ink">
          <ArrowLeft size={14} />
          Back to intent
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Settlement receipt</h1>
            <p className="text-sm text-muted">
              {receipt.verificationMode ? MODE_TEXT[receipt.verificationMode] : receipt.status === "SETTLED" ? "" : "Not settled. This receipt shows what has been recorded so far."}
            </p>
          </div>
          <div className="flex items-center gap-3">
            <Badge tone={meta.tone}>{meta.label}</Badge>
            <a
              href={`/api/intents/${intentId}/receipt?download=1`}
              className="inline-flex items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-ink transition-colors hover:bg-accent-hover active:translate-y-px"
            >
              <DownloadSimple size={16} />
              Download JSON
            </a>
          </div>
        </div>
      </div>

      <Panel title="Summary">
        <dl className="divide-y divide-line">
          <Row label="Sent">
            <Mono>{formatAmount(source.amount, source.chain, source.asset)}</Mono> from <Mono className="break-all">{source.requester}</Mono>
          </Row>
          <Row label="Expected">
            <Mono>{formatAmount(destination.expectedOutput, destination.chain, destination.asset)}</Mono> to <Mono className="break-all">{destination.recipient}</Mono>
          </Row>
          <Row label="Observed">
            {destination.observedAmount !== null ? (
              <Mono>{formatAmount(destination.observedAmount, destination.chain, destination.asset)}</Mono>
            ) : (
              <span className="text-muted">Not observed yet</span>
            )}
          </Row>
          <Row label="Route">
            {receipt.route.provider} <span className="text-muted">({receipt.route.routeId})</span>
          </Row>
        </dl>
      </Panel>

      <div className="grid gap-6 md:grid-cols-2">
        <Panel title="Source, PortalDot V3 Substrate">
          <dl className="divide-y divide-line">
            <LegRows leg={source} wsUrl={v3Config.wsUrl} />
          </dl>
        </Panel>
        <Panel title="Destination, PortalDot V3 EVM">
          <dl className="divide-y divide-line">
            <LegRows leg={destination} wsUrl={v3Config.wsUrl} />
          </dl>
        </Panel>
      </div>

      <Panel title="Integrity">
        <dl className="divide-y divide-line">
          <Row label="Intent hash">
            <Mono className="break-all">{receipt.intentHash}</Mono>
          </Row>
          <Row label="Receipt hash">
            <Mono className="break-all">{receiptHash}</Mono>
          </Row>
        </dl>
        <p className="mt-3 text-sm leading-relaxed text-muted">
          The receipt hash is keccak256 of <Mono>relaymesh.receipt.v1</Mono>, a newline, and the downloaded JSON. Anyone can recompute it from the file.
        </p>
      </Panel>

      <Panel title="Timeline">
        <ol className="grid gap-3">
          {receipt.timeline.map((t) => (
            <li key={t.seq} className="grid gap-0.5 sm:grid-cols-[7rem_10rem_minmax(0,1fr)] sm:gap-4">
              <time className="font-mono text-xs text-muted">{formatTime(t.at)}</time>
              <span className="text-sm font-medium">{STATUS_META[t.status].label}</span>
              <span className="text-sm text-muted">{t.reason}</span>
            </li>
          ))}
        </ol>
      </Panel>
    </div>
  );
}
