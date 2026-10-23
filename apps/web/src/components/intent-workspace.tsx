"use client";

import { ArrowLeft, ArrowRight, Receipt } from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, apiFetch, type Wire } from "@/lib/api";
import { formatAmount, formatDuration, shortHash, STATUS_META } from "@/lib/format";
import { useClock } from "@/lib/use-clock";
import { getBrowserApi } from "@/lib/wallet";
import type { IntentView } from "@/server/intent-view";
import { QuotesPanel, type Rejection } from "./quotes-panel";
import { SettlementPanel } from "./settlement-panel";
import { SignPanel } from "./sign-panel";
import { Timeline } from "./timeline";
import { CopyButton } from "./copy-button";
import { Lifecycle } from "./lifecycle";
import { Badge, Mono, stagger } from "./ui";

export type WireView = Wire<IntentView>;

const POLL_MS = 4_000;
const PRE_SOURCE = new Set(["DRAFT", "QUOTED", "AWAITING_SIGNATURE"]);

export function IntentWorkspace({
  initial,
  wsUrl,
  explorerUrl,
  unavailableProviders,
}: {
  initial: WireView;
  wsUrl: string;
  explorerUrl: string;
  unavailableProviders: { name: string; reason: string }[];
}) {
  const [view, setView] = useState(initial);
  const [rejections, setRejections] = useState<Rejection[] | null>(null);
  const [refreshError, setRefreshError] = useState<string>();
  const now = useClock(initial.serverTime);

  const reload = useCallback(async () => {
    try {
      setView(await apiFetch<WireView>(`/api/intents/${initial.intent.intentId}`));
      setRefreshError(undefined);
    } catch (error) {
      setRefreshError(error instanceof ApiRequestError ? error.message : "Could not refresh this intent.");
    }
  }, [initial.intent.intentId]);

  // Start the browser's own V3 connection while the user reads the quote, so the call can be decoded
  // (and later signed) without waiting. Failures surface in the sign panel, which retries.
  const preSourceAtLoad = PRE_SOURCE.has(initial.status);
  useEffect(() => {
    if (preSourceAtLoad) getBrowserApi(wsUrl).catch(() => undefined);
  }, [preSourceAtLoad, wsUrl]);

  // Poll while the intent can still change on its own (after signing, the chain and watcher move it).
  useEffect(() => {
    if (view.terminal) return;
    const timer = setInterval(() => void reload(), POLL_MS);
    return () => clearInterval(timer);
  }, [view.terminal, reload]);

  const { intent, status } = view;
  const meta = STATUS_META[status];
  const deadlineLeft = intent.constraints.deadline - now;
  const preSource = PRE_SOURCE.has(status);

  return (
    <div className="grid gap-8">
      <div className="enter grid gap-6" style={stagger(0)}>
        <Link href="/desk" className="press inline-flex w-fit items-center gap-1.5 rounded-md text-sm text-muted hover:text-ink">
          <ArrowLeft size={14} />
          New intent
        </Link>
        <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
          <div className="grid gap-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <Badge tone={meta.tone}>{meta.label}</Badge>
              <span className="text-sm text-muted">{meta.description}</span>
            </div>
            <h1 className="text-4xl font-semibold tracking-[-0.035em] tabular-nums sm:text-5xl">{formatAmount(intent.source.amount, intent.source.chain)}</h1>
            <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted">
              <span>From</span>
              <span className="inline-flex items-center gap-0.5 text-ink">
                <Mono title={intent.requester}>{shortHash(intent.requester, 8, 6)}</Mono>
                <CopyButton value={intent.requester} label="Copy source address" />
              </span>
              <ArrowRight size={14} aria-label="to" />
              <span className="inline-flex items-center gap-0.5 text-ink">
                <Mono title={intent.destination.recipient}>{shortHash(intent.destination.recipient, 8, 6)}</Mono>
                <CopyButton value={intent.destination.recipient} label="Copy recipient address" />
              </span>
              <span>on PortalDot V3</span>
            </p>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1 text-[13px]">
            <dt className="text-muted">Intent</dt>
            <dd className="flex items-center gap-1">
              <Mono className="text-[12px]" title={intent.intentId}>
                {shortHash(intent.intentId, 10, 6)}
              </Mono>
              <CopyButton value={intent.intentId} label="Copy intent ID" />
            </dd>
            <dt className="text-muted">Hash</dt>
            <dd className="flex items-center gap-1">
              <Mono className="text-[12px]" title={view.intentHash}>
                {shortHash(view.intentHash, 10, 6)}
              </Mono>
              <CopyButton value={view.intentHash} label="Copy intent hash" />
            </dd>
            {preSource && (
              <>
                <dt className="text-muted">Deadline</dt>
                <dd className={`tabular-nums ${deadlineLeft <= 60 ? "text-critical" : ""}`}>{deadlineLeft > 0 ? `${formatDuration(deadlineLeft)} left` : "passed"}</dd>
              </>
            )}
          </dl>
        </div>
        <Lifecycle statuses={view.history.map((e) => e.status)} />
        {refreshError && (
          <p role="status" className="rounded-lg bg-caution-soft px-3 py-2 text-sm text-caution">
            {refreshError} Retrying automatically.
          </p>
        )}
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="grid content-start gap-6">
          {preSource && (
            <QuotesPanel
              view={view}
              now={now}
              rejections={rejections}
              unavailableProviders={unavailableProviders}
              onQuoted={(r) => {
                setRejections(r);
                void reload();
              }}
              onSelected={() => void reload()}
            />
          )}
          {status === "AWAITING_SIGNATURE" && view.plan && <SignPanel view={view} plan={view.plan} now={now} wsUrl={wsUrl} onSubmitted={() => void reload()} />}
          {!preSource && <SettlementPanel view={view} />}
        </div>

        <aside className="grid content-start gap-4">
          <Timeline history={view.history} explorerUrl={explorerUrl} />
          {view.selectedQuoteId && (
            <Link
              href={`/intents/${intent.intentId}/receipt`}
              className="press enter inline-flex items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-4 py-2.5 text-sm font-medium shadow-panel hover:bg-raised"
              style={stagger(3)}
            >
              <Receipt size={16} />
              {status === "SETTLED" ? "View receipt" : "View receipt so far"}
            </Link>
          )}
        </aside>
      </div>
    </div>
  );
}
