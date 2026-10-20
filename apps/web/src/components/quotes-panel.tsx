"use client";

import { ArrowsClockwise } from "@phosphor-icons/react";
import { useState } from "react";
import { ApiRequestError, apiFetch, type Wire } from "@/lib/api";
import { formatAmount, formatDuration } from "@/lib/format";
import { convertDecimals, getAsset, type Quote } from "@relaymesh/core";
import type { WireView } from "./intent-workspace";
import { Badge, Button, Mono, Panel, Skeleton } from "./ui";

export interface Rejection {
  provider: string;
  code: string;
  reason: string;
}

const PROVIDER_NAMES: Record<string, string> = {
  "portaldot-v3-native": "PortalDot V3 native transfer",
  "portaldot-ibridge": "PortalDot iBridge",
};

const REJECTION_TEXT: Record<string, string> = {
  INSUFFICIENT_BALANCE: "Not enough balance",
  AMOUNT_TOO_SMALL: "Amount too small",
  INVALID_RECIPIENT: "Recipient not allowed",
  UNSUPPORTED_ROUTE: "Route not supported",
  PROVIDER_UNAVAILABLE: "Unavailable",
  PROVIDER_ERROR: "Provider error",
};

export function QuotesPanel({
  view,
  now,
  rejections,
  unavailableProviders,
  onQuoted,
  onSelected,
}: {
  view: WireView;
  now: number;
  rejections: Rejection[] | null;
  unavailableProviders: { name: string; reason: string }[];
  onQuoted: (rejections: Rejection[]) => void;
  onSelected: () => void;
}) {
  const [quoting, setQuoting] = useState(false);
  const [selecting, setSelecting] = useState<string>();
  const [error, setError] = useState<string>();

  const live = view.quotes.filter((q) => q.expiresAt > now);
  const expiredCount = view.quotes.length - live.length;
  const canSelect = view.status === "QUOTED";

  async function refresh() {
    setQuoting(true);
    setError(undefined);
    try {
      const result = await apiFetch<{ quotes: Wire<Quote>[]; rejections: Rejection[] }>(`/api/intents/${view.intent.intentId}/quotes`, { method: "POST" });
      onQuoted(result.rejections);
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not fetch quotes.");
    } finally {
      setQuoting(false);
    }
  }

  async function select(quoteId: string) {
    setSelecting(quoteId);
    setError(undefined);
    try {
      await apiFetch(`/api/intents/${view.intent.intentId}/execution`, { method: "POST", body: JSON.stringify({ quoteId }) });
      onSelected();
    } catch (e) {
      setError(e instanceof ApiRequestError ? e.message : "Could not prepare this route.");
    } finally {
      setSelecting(undefined);
    }
  }

  const shownRejections = rejections ?? unavailableProviders.map((p) => ({ provider: p.name, code: "PROVIDER_UNAVAILABLE", reason: p.reason }));

  return (
    <Panel
      title="Routes"
      action={
        <Button variant="ghost" onClick={refresh} disabled={quoting} className="-my-1 px-2.5 py-1">
          <ArrowsClockwise size={15} className={quoting ? "animate-spin" : ""} />
          {quoting ? "Quoting" : "Refresh quotes"}
        </Button>
      }
    >
      <div className="grid gap-5">
        {quoting && live.length === 0 && (
          <div className="grid gap-3" aria-label="Loading quotes">
            <Skeleton className="h-[88px]" />
          </div>
        )}

        {!quoting && live.length === 0 && (
          <div className="grid gap-2 rounded-lg border border-dashed border-line-strong p-5 text-sm">
            <p className="font-medium">{view.quotes.length === 0 ? "No quotes yet" : "Quotes expired"}</p>
            <p className="text-muted">
              {view.quotes.length === 0
                ? "Ask the configured providers for a route. Any provider that cannot quote is listed below with its reason."
                : "Quotes are valid for 60 seconds so fees and balances stay current. Refresh to get new ones."}
            </p>
          </div>
        )}

        {live.length > 0 && (
          <ol className="grid gap-3">
            {live.map((q, index) => {
              const fee = q.fees.find((f) => f.chain === view.intent.source.chain);
              const selected = view.selectedQuoteId === q.quoteId;
              return (
                <li key={q.quoteId} className={`grid gap-4 rounded-lg border p-4 ${selected ? "border-accent" : "border-line"}`}>
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{PROVIDER_NAMES[q.provider] ?? q.provider}</span>
                      {index === 0 && live.length > 1 && <Badge tone="accent">Best</Badge>}
                      {selected && <Badge tone="accent">Selected</Badge>}
                    </div>
                    <span className={`text-sm ${q.expiresAt - now <= 15 ? "text-critical" : "text-muted"}`}>Expires in {formatDuration(q.expiresAt - now)}</span>
                  </div>
                  <dl className="grid grid-cols-2 gap-4 text-sm sm:grid-cols-3">
                    <div className="grid gap-1">
                      <dt className="text-muted">You receive</dt>
                      <dd>
                        <Mono>{formatAmount(q.expectedOutput, view.intent.destination.chain)}</Mono>
                      </dd>
                    </div>
                    <div className="grid gap-1">
                      <dt className="text-muted">Network fee</dt>
                      <dd>
                        <Mono>{fee ? formatAmount(fee.amount, fee.chain) : "None reported"}</Mono>
                        {fee?.basis === "estimate" && <span className="ml-1 text-muted">est.</span>}
                      </dd>
                    </div>
                    <div className="grid gap-1">
                      <dt className="text-muted">Time to finality</dt>
                      <dd>{q.estimatedSeconds ? `about ${q.estimatedSeconds}s` : "Not reported"}</dd>
                    </div>
                  </dl>
                  <HeldBack view={view} expectedOutput={q.expectedOutput} />
                  {canSelect && (
                    <Button onClick={() => select(q.quoteId)} disabled={!!selecting} className="justify-self-start">
                      {selecting === q.quoteId ? "Checking chain state" : "Review this route"}
                    </Button>
                  )}
                </li>
              );
            })}
          </ol>
        )}

        {expiredCount > 0 && live.length > 0 && <p className="text-sm text-muted">{expiredCount} earlier quote(s) expired and are kept only in the record.</p>}

        {shownRejections.length > 0 && (
          <div className="grid gap-2">
            <h3 className="text-sm font-medium">Not quoting</h3>
            <ul className="grid gap-2">
              {shownRejections.map((r) => (
                <li key={r.provider + r.code} className="grid gap-1 rounded-lg bg-raised px-4 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{PROVIDER_NAMES[r.provider] ?? r.provider}</span>
                    <Badge tone={r.code === "PROVIDER_UNAVAILABLE" ? "neutral" : "caution"}>{REJECTION_TEXT[r.code] ?? r.code}</Badge>
                  </div>
                  <p className="leading-relaxed text-muted">{r.reason}</p>
                </li>
              ))}
            </ul>
          </div>
        )}

        {error && (
          <p role="alert" className="rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">
            {error}
          </p>
        )}
      </div>
    </Panel>
  );
}

/** Explains any gap between what is sent and what the EVM side will show, without hardcoding chain constants. */
function HeldBack({ view, expectedOutput }: { view: WireView; expectedOutput: string }) {
  const { source, destination } = view.intent;
  const sentInDestinationUnits = convertDecimals(
    BigInt(source.amount),
    getAsset(source.chain, source.asset).decimals,
    getAsset(destination.chain, destination.asset).decimals,
  ).value;
  const gap = sentInDestinationUnits - BigInt(expectedOutput);
  if (gap <= 0n) return null;
  return (
    <p className="text-sm leading-relaxed text-muted">
      {formatAmount(gap, destination.chain)} of what you send will not show as spendable on the EVM side. It stays locked as the account&apos;s existential deposit or
      behind existing freezes.
    </p>
  );
}
