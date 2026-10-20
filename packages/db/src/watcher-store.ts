import { and, asc, eq, sql } from "drizzle-orm";
import type { Hex } from "viem";
import { RelayMeshError } from "@relaymesh/core";
import type { Db } from "./client";
import { intents, registryAnchors, watcherCursors } from "./schema";

export async function getCursor(db: Db, name: string): Promise<bigint | undefined> {
  const [row] = await db.select().from(watcherCursors).where(eq(watcherCursors.name, name));
  return row?.blockNumber;
}

/** Moves a cursor forward. It never moves backwards, so a slow or stale worker cannot rewind progress. */
export async function advanceCursor(db: Db, name: string, blockNumber: bigint): Promise<void> {
  await db
    .insert(watcherCursors)
    .values({ name, blockNumber })
    .onConflictDoUpdate({
      target: watcherCursors.name,
      set: { blockNumber: sql`GREATEST(${watcherCursors.blockNumber}, excluded.block_number)`, updatedAt: sql`now()` },
    });
}

export type AnchorStep = "intent" | "receipt";

export interface RegistryAnchor {
  intentId: Hex;
  step: AnchorStep;
  valueHash: Hex;
  contractAddress: Hex;
  chainId: number;
  txHash: Hex;
  blockNumber: bigint;
}

export async function listAnchors(db: Db, intentId: Hex): Promise<RegistryAnchor[]> {
  const rows = await db.select().from(registryAnchors).where(eq(registryAnchors.intentId, intentId)).orderBy(asc(registryAnchors.insertedAt));
  return rows.map((r) => ({
    intentId: r.intentId as Hex,
    step: r.step as AnchorStep,
    valueHash: r.valueHash as Hex,
    contractAddress: r.contractAddress as Hex,
    chainId: r.chainId,
    txHash: r.txHash as Hex,
    blockNumber: r.blockNumber,
  }));
}

/** Records a confirmed anchor. Re-recording the same facts is a no-op; different facts for the same step are an integrity error. */
export async function recordAnchor(db: Db, anchor: RegistryAnchor): Promise<void> {
  const inserted = await db.insert(registryAnchors).values(anchor).onConflictDoNothing().returning({ step: registryAnchors.step });
  if (inserted.length > 0) return;
  const [existing] = await db
    .select()
    .from(registryAnchors)
    .where(and(eq(registryAnchors.intentId, anchor.intentId), eq(registryAnchors.step, anchor.step)));
  if (!existing || existing.valueHash !== anchor.valueHash || existing.contractAddress !== anchor.contractAddress) {
    throw new RelayMeshError("INTEGRITY_ERROR", `A different ${anchor.step} anchor is already recorded for ${anchor.intentId}`);
  }
}

/** Settled intents whose receipt hash is not yet anchored in the registry, oldest first. */
export async function listSettledWithoutReceiptAnchor(db: Db, limit = 20): Promise<Hex[]> {
  const rows = await db
    .select({ intentId: intents.intentId })
    .from(intents)
    .where(
      and(
        eq(intents.currentStatus, "SETTLED"),
        sql`NOT EXISTS (SELECT 1 FROM ${registryAnchors} WHERE ${registryAnchors.intentId} = ${intents.intentId} AND ${registryAnchors.step} = 'receipt')`,
      ),
    )
    .orderBy(asc(intents.createdAt))
    .limit(limit);
  return rows.map((r) => r.intentId as Hex);
}
