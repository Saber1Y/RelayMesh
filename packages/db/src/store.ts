import { asc, eq, inArray } from "drizzle-orm";
import type { Hex } from "viem";
import {
  appendStatus,
  assertIdempotencyKey,
  assertQuoteUsable,
  createHistory,
  currentStatus,
  hashIntent,
  isChainId,
  RelayMeshError,
  resolveIdempotency,
  type Intent,
  type IntentStatus,
  type NewStatusEvent,
  type Quote,
  type StatusEvent,
  type VerificationMode,
} from "@relaymesh/core";
import type { Db } from "./client.js";
import { evidenceFromJson, evidenceToJson, feesFromJson, feesToJson } from "./codec.js";
import { idempotencyRecords, intents, quotes, statusEvents } from "./schema.js";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Executor = Db | Tx;

export interface StoredIntent {
  intent: Intent;
  intentHash: Hex;
  history: StatusEvent[];
  selectedQuoteId: string | null;
}

export type InsertIntentResult = { kind: "created"; intentId: Hex } | { kind: "replayed"; intentId: Hex };

// Thrown inside the transaction to roll it back when the idempotency key already exists.
class IdempotencyKeyTaken extends Error {}

/**
 * Persists a new intent with its DRAFT event and idempotency record in one transaction.
 * A concurrent or repeated request with the same key and body returns the original intent;
 * the same key with a different body throws IDEMPOTENCY_CONFLICT.
 */
export async function insertIntent(
  db: Db,
  input: { intent: Intent; intentHash: Hex; idempotencyKey: string; requestHash: Hex },
): Promise<InsertIntentResult> {
  const { intent, intentHash, idempotencyKey, requestHash } = input;
  assertIdempotencyKey(idempotencyKey);
  if (hashIntent(intent) !== intentHash) throw new RelayMeshError("INTEGRITY_ERROR", "intentHash does not match the intent");

  const existing = await findIdempotencyRecord(db, idempotencyKey);
  if (existing) return { kind: "replayed", ...replayOf(resolveIdempotency(existing, idempotencyKey, requestHash)) };

  const [draft] = createHistory(intent.createdAt);
  try {
    await db.transaction(async (tx) => {
      await tx.insert(intents).values({
        intentId: intent.intentId,
        intentHash,
        version: intent.version,
        requester: intent.requester,
        sourceChain: intent.source.chain,
        sourceAsset: intent.source.asset,
        sourceAmount: intent.source.amount,
        destinationChain: intent.destination.chain,
        destinationAsset: intent.destination.asset,
        recipient: intent.destination.recipient,
        minOutput: intent.constraints.minOutput ?? null,
        maxFee: intent.constraints.maxFee ?? null,
        deadline: intent.constraints.deadline,
        createdAt: intent.createdAt,
        currentStatus: "DRAFT",
      });
      await tx.insert(statusEvents).values(eventRow(intent.intentId, draft as StatusEvent));
      // A unique-key race with another request blocks here until that transaction finishes.
      const inserted = await tx
        .insert(idempotencyRecords)
        .values({ key: idempotencyKey, requestHash, intentId: intent.intentId })
        .onConflictDoNothing({ target: idempotencyRecords.key })
        .returning({ key: idempotencyRecords.key });
      if (inserted.length === 0) throw new IdempotencyKeyTaken();
    });
  } catch (error) {
    if (!(error instanceof IdempotencyKeyTaken)) throw error;
    const winner = await findIdempotencyRecord(db, idempotencyKey);
    if (!winner) throw new RelayMeshError("INTEGRITY_ERROR", "Idempotency key conflict but no record found");
    return { kind: "replayed", ...replayOf(resolveIdempotency(winner, idempotencyKey, requestHash)) };
  }
  return { kind: "created", intentId: intent.intentId };
}

function replayOf(resolution: ReturnType<typeof resolveIdempotency>): { intentId: Hex } {
  if (resolution.kind !== "replay") throw new RelayMeshError("INTEGRITY_ERROR", "Expected an idempotent replay");
  return { intentId: resolution.intentId };
}

async function findIdempotencyRecord(db: Executor, key: string) {
  const [row] = await db.select().from(idempotencyRecords).where(eq(idempotencyRecords.key, key));
  return row && { key: row.key, requestHash: row.requestHash as Hex, intentId: row.intentId as Hex };
}

/** Loads an intent and its full history, re-verifying the stored hash and every transition. */
export async function loadIntent(db: Executor, intentId: Hex): Promise<StoredIntent | undefined> {
  const [row] = await db.select().from(intents).where(eq(intents.intentId, intentId));
  if (!row) return undefined;
  return toStoredIntent(row, await loadHistory(db, intentId));
}

async function loadHistory(db: Executor, intentId: Hex): Promise<StatusEvent[]> {
  const rows = await db.select().from(statusEvents).where(eq(statusEvents.intentId, intentId)).orderBy(asc(statusEvents.seq));
  return rows.map((r) => ({
    seq: r.seq,
    status: r.status as IntentStatus,
    at: r.at,
    reason: r.reason,
    ...(r.evidence !== null && { evidence: evidenceFromJson(r.evidence) }),
    ...(r.verificationMode !== null && { verificationMode: r.verificationMode as VerificationMode }),
  }));
}

function toStoredIntent(row: typeof intents.$inferSelect, history: StatusEvent[]): StoredIntent {
  if (row.version !== 1 || !isChainId(row.sourceChain) || !isChainId(row.destinationChain)) {
    throw new RelayMeshError("INTEGRITY_ERROR", `Stored intent ${row.intentId} has an unsupported version or chain`);
  }
  const intent: Intent = {
    version: 1,
    intentId: row.intentId as Hex,
    createdAt: row.createdAt,
    requester: row.requester,
    source: { chain: row.sourceChain, asset: row.sourceAsset, amount: row.sourceAmount },
    destination: { chain: row.destinationChain, asset: row.destinationAsset, recipient: row.recipient },
    constraints: {
      deadline: row.deadline,
      ...(row.minOutput !== null && { minOutput: row.minOutput }),
      ...(row.maxFee !== null && { maxFee: row.maxFee }),
    },
  };
  if (hashIntent(intent) !== row.intentHash) {
    throw new RelayMeshError("INTEGRITY_ERROR", `Stored intent ${row.intentId} does not match its hash`);
  }
  const status = currentStatus(history);
  if (status !== row.currentStatus) {
    throw new RelayMeshError("INTEGRITY_ERROR", `Stored intent ${row.intentId} status projection is out of sync`);
  }
  return { intent, intentHash: row.intentHash as Hex, history, selectedQuoteId: row.selectedQuoteId };
}

function eventRow(intentId: Hex, event: StatusEvent): typeof statusEvents.$inferInsert {
  return {
    intentId,
    seq: event.seq,
    status: event.status,
    at: event.at,
    reason: event.reason,
    evidence: event.evidence ? evidenceToJson(event.evidence) : null,
    verificationMode: event.verificationMode ?? null,
  };
}

/** Locks the intent row so status changes for one intent are serialized. */
async function lockIntent(tx: Tx, intentId: Hex): Promise<StoredIntent> {
  const [row] = await tx.select().from(intents).where(eq(intents.intentId, intentId)).for("update");
  if (!row) throw new RelayMeshError("INVALID_INTENT", `Unknown intent ${intentId}`);
  return toStoredIntent(row, await loadHistory(tx, intentId));
}

async function appendLocked(
  tx: Tx,
  stored: StoredIntent,
  next: NewStatusEvent,
  selectedQuoteId?: string | null,
): Promise<StatusEvent> {
  const history = appendStatus(stored.history, next);
  const event = history[history.length - 1] as StatusEvent;
  await tx.insert(statusEvents).values(eventRow(stored.intent.intentId, event));
  await tx
    .update(intents)
    .set({ currentStatus: event.status, ...(selectedQuoteId !== undefined && { selectedQuoteId }) })
    .where(eq(intents.intentId, stored.intent.intentId));
  return event;
}

/** Appends a status event after validating it against the full stored history (core state machine rules). */
export async function appendStatusEvent(db: Db, intentId: Hex, next: NewStatusEvent): Promise<StatusEvent> {
  return db.transaction(async (tx) => appendLocked(tx, await lockIntent(tx, intentId), next));
}

/** Stores a fresh set of quotes and moves the intent to QUOTED, clearing any previous selection. */
export async function recordQuotes(db: Db, intentId: Hex, newQuotes: readonly Quote[], at: number): Promise<StatusEvent> {
  if (newQuotes.length === 0) throw new RelayMeshError("INVALID_INTENT", "recordQuotes needs at least one quote");
  if (newQuotes.some((q) => q.intentId !== intentId)) throw new RelayMeshError("QUOTE_MISMATCH", "Quote belongs to a different intent");

  return db.transaction(async (tx) => {
    const stored = await lockIntent(tx, intentId);
    await tx.insert(quotes).values(
      newQuotes.map((q) => ({
        quoteId: q.quoteId,
        intentId,
        provider: q.provider,
        routeId: q.routeId,
        expectedOutput: q.expectedOutput,
        fees: feesToJson(q.fees),
        retrievedAt: q.retrievedAt,
        expiresAt: q.expiresAt,
        estimatedSeconds: q.estimatedSeconds ?? null,
      })),
    );
    const providers = [...new Set(newQuotes.map((q) => q.provider))].join(", ");
    return appendLocked(tx, stored, { status: "QUOTED", at, reason: `${newQuotes.length} quote(s) from ${providers}` }, null);
  });
}

export async function listQuotes(db: Executor, intentId: Hex): Promise<Quote[]> {
  const rows = await db.select().from(quotes).where(eq(quotes.intentId, intentId)).orderBy(asc(quotes.insertedAt), asc(quotes.quoteId));
  return rows.map(toQuote);
}

function toQuote(row: typeof quotes.$inferSelect): Quote {
  return {
    quoteId: row.quoteId,
    intentId: row.intentId as Hex,
    provider: row.provider,
    routeId: row.routeId,
    expectedOutput: row.expectedOutput,
    fees: feesFromJson(row.fees),
    retrievedAt: row.retrievedAt,
    expiresAt: row.expiresAt,
    ...(row.estimatedSeconds !== null && { estimatedSeconds: row.estimatedSeconds }),
  };
}

/**
 * Selects a stored quote for signing: re-checks expiry and constraints at `now`, records the
 * selection and moves the intent to AWAITING_SIGNATURE atomically.
 */
export async function selectQuote(db: Db, intentId: Hex, quoteId: string, now: number): Promise<{ quote: Quote; event: StatusEvent }> {
  return db.transaction(async (tx) => {
    const stored = await lockIntent(tx, intentId);
    const [row] = await tx.select().from(quotes).where(eq(quotes.quoteId, quoteId));
    if (!row || row.intentId !== intentId) throw new RelayMeshError("QUOTE_MISMATCH", "Quote not found for this intent");
    const quote = toQuote(row);
    assertQuoteUsable(quote, stored.intent, now);
    const event = await appendLocked(tx, stored, { status: "AWAITING_SIGNATURE", at: now, reason: `selected ${quote.provider} quote ${quoteId}` }, quoteId);
    return { quote, event };
  });
}

/** Intent IDs whose current status is one of `statuses`, oldest first. Used by the watcher. */
export async function listIntentIdsByStatus(db: Executor, statuses: readonly IntentStatus[], limit = 100): Promise<Hex[]> {
  const rows = await db
    .select({ intentId: intents.intentId })
    .from(intents)
    .where(inArray(intents.currentStatus, [...statuses]))
    .orderBy(asc(intents.createdAt))
    .limit(limit);
  return rows.map((r) => r.intentId as Hex);
}
