import { desc, sql } from "drizzle-orm";
import type { Hex } from "viem";
import { INTENT_STATUSES, isChainId, type ChainId, type IntentStatus } from "@relaymesh/core";
import type { Db } from "./client";
import { intents, receiptBatchAnchors, receiptBatchLeaves, registryAnchors } from "./schema";

// Read-only summaries for dashboards. They read the status projection for speed; anything shown as
// evidence must still come from loadIntent, which replays and verifies the full history.

export async function countIntentsByStatus(db: Db): Promise<Record<IntentStatus, number>> {
  const rows = await db
    .select({ status: intents.currentStatus, count: sql<number>`count(*)::int` })
    .from(intents)
    .groupBy(intents.currentStatus);
  const counts = Object.fromEntries(INTENT_STATUSES.map((s) => [s, 0])) as Record<IntentStatus, number>;
  for (const row of rows) counts[row.status as IntentStatus] = row.count;
  return counts;
}

export interface IntentSummary {
  intentId: Hex;
  status: IntentStatus;
  sourceChain: ChainId;
  sourceAmount: bigint;
  destinationChain: ChainId;
  recipient: string;
  createdAt: number;
}

export async function listRecentIntents(db: Db, limit = 8): Promise<IntentSummary[]> {
  const rows = await db.select().from(intents).orderBy(desc(intents.insertedAt)).limit(limit);
  return rows.flatMap((r) =>
    isChainId(r.sourceChain) && isChainId(r.destinationChain)
      ? [
          {
            intentId: r.intentId as Hex,
            status: r.currentStatus as IntentStatus,
            sourceChain: r.sourceChain,
            sourceAmount: r.sourceAmount,
            destinationChain: r.destinationChain,
            recipient: r.recipient,
            createdAt: r.createdAt,
          },
        ]
      : [],
  );
}

/**
 * Seconds from the source transaction being seen on chain to SETTLED, for the most recent settled
 * intents. Measured from recorded status event times, newest first.
 */
export async function recentSettlementSeconds(db: Db, limit = 20): Promise<number[]> {
  const result = await db.execute<{ seconds: number }>(sql`
    SELECT (settled.at - submitted.at)::int AS seconds
    FROM status_events settled
    JOIN LATERAL (
      SELECT min(at) AS at FROM status_events s
      WHERE s.intent_id = settled.intent_id AND s.status = 'SOURCE_SUBMITTED'
    ) submitted ON submitted.at IS NOT NULL
    WHERE settled.status = 'SETTLED'
    ORDER BY settled.at DESC
    LIMIT ${limit}
  `);
  return [...result].map((r) => Number(r.seconds));
}

/**
 * Intents whose receipt is anchored on chain, as recorded after each write was mined: one by one in
 * IntentRegistry (before batching), or as a leaf of a mined ReceiptBatchRegistry batch.
 */
export async function countAnchoredReceipts(db: Db): Promise<number> {
  const [row] = await db.execute<{ count: number }>(sql`
    SELECT count(*)::int AS count FROM (
      SELECT ${registryAnchors.intentId} AS intent_id FROM ${registryAnchors} WHERE ${registryAnchors.step} = 'receipt'
      UNION
      SELECT ${receiptBatchLeaves.intentId} FROM ${receiptBatchLeaves}
      JOIN ${receiptBatchAnchors} ON ${receiptBatchAnchors.contractAddress} = ${receiptBatchLeaves.contractAddress} AND ${receiptBatchAnchors.root} = ${receiptBatchLeaves.batchRoot}
    ) anchored
  `);
  return Number(row?.count ?? 0);
}
