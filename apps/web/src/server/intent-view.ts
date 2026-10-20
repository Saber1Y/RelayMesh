import "server-only";
import type { Hex } from "viem";
import { currentStatus, isTerminal, type Intent, type IntentStatus, type Quote, type StatusEvent } from "@relaymesh/core";
import { listExecutionPlans, listQuotes, loadIntent, type ExecutionPlanRecord } from "@relaymesh/db";
import { rankQuotes } from "@relaymesh/routes";
import { getDb } from "./services";

export interface IntentView {
  intent: Intent;
  intentHash: Hex;
  status: IntentStatus;
  terminal: boolean;
  history: StatusEvent[];
  /** All quotes ever fetched for this intent, best first. Expiry is judged by the client clock against expiresAt. */
  quotes: Quote[];
  selectedQuoteId: string | null;
  /** Latest plan for the selected quote, if any. */
  plan: ExecutionPlanRecord | null;
  serverTime: number;
}

export async function getIntentView(intentId: Hex, now: number): Promise<IntentView | undefined> {
  const db = getDb();
  const stored = await loadIntent(db, intentId);
  if (!stored) return undefined;
  const [quotes, plans] = await Promise.all([listQuotes(db, intentId), listExecutionPlans(db, intentId)]);
  const status = currentStatus(stored.history);
  const plan = plans.filter((p) => p.quoteId === stored.selectedQuoteId).at(-1) ?? null;
  return {
    intent: stored.intent,
    intentHash: stored.intentHash,
    status,
    terminal: isTerminal(status),
    history: stored.history,
    quotes: rankQuotes(quotes, stored.intent),
    selectedQuoteId: stored.selectedQuoteId,
    plan,
    serverTime: now,
  };
}
