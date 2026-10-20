"use client";

import { ArrowLeft, Receipt } from "@phosphor-icons/react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { ApiRequestError, apiFetch, type Wire } from "@/lib/api";
import { formatAmount, formatDuration, shortHash, STATUS_META } from "@/lib/format";
import { useClock } from "@/lib/use-clock";
import type { IntentView } from "@/server/intent-view";
import { QuotesPanel, type Rejection } from "./quotes-panel";
import { SettlementPanel } from "./settlement-panel";
import { SignPanel } from "./sign-panel";
import { Timeline } from "./timeline";
import { Badge, Mono } from "./ui";

export type WireView = Wire<IntentView>;

const POLL_MS = 4_000;
const PRE_SOURCE = new Set(["DRAFT", "QUOTED", "AWAITING_SIGNATURE"]);

export function IntentWorkspace({
  initial,
  wsUrl,
  unavailableProviders,
}: {
  initial: WireView;
  wsUrl: string;
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
      <div className="grid gap-4">
        <Link href="/" className="inline-flex w-fit items-center gap-1.5 text-sm text-muted hover:text-ink">
          <ArrowLeft size={14} />
          New intent
        </Link>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="grid gap-2">
            <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
              {formatAmount(intent.source.amount, intent.source.chain)} to <Mono className="text-[0.9em]">{shortHash(intent.destination.recipient)}</Mono>
            </h1>
            <p className="text-sm text-muted">
              From <Mono title={intent.requester}>{shortHash(intent.requester, 8, 6)}</Mono> on PortalDot V3
            </p>
          </div>
          <div className="grid justify-items-start gap-1.5 sm:justify-items-end">
            <Badge tone={meta.tone}>{meta.label}</Badge>
            <p className="text-sm text-muted">{meta.description}</p>
          </div>
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <div className="flex gap-2">
            <dt className="text-muted">Intent</dt>
            <dd>
              <Mono title={view.intent.intentId}>{shortHash(view.intent.intentId, 10, 6)}</Mono>
            </dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-muted">Hash</dt>
            <dd>
              <Mono title={view.intentHash}>{shortHash(view.intentHash, 10, 6)}</Mono>
            </dd>
          </div>
          {preSource && (
            <div className="flex gap-2">
              <dt className="text-muted">Deadline</dt>
              <dd className={deadlineLeft <= 60 ? "text-critical" : ""}>{deadlineLeft > 0 ? `${formatDuration(deadlineLeft)} left` : "passed"}</dd>
            </div>
          )}
        </dl>
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

        <aside className="grid content-start gap-6">
          <Timeline history={view.history} wsUrl={wsUrl} />
          {view.selectedQuoteId && (
            <Link
              href={`/intents/${intent.intentId}/receipt`}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface px-4 py-2 text-sm font-medium transition-colors hover:bg-raised"
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
