import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Hex } from "viem";
import { BRIDGE_CHECK_DOMAIN, hashCanonical, RelayMeshError } from "@relaymesh/core";
import { proofOf } from "./batch-store";
import type { Db } from "./client";
import { bridgeBatchLeaves, bridgeChecks, receiptBatchAnchors, receiptBatches } from "./schema";

export interface BridgeCheckRecord {
  checkHash: Hex;
  depositId: string;
  payoutTxHash: Hex;
  /** The deposit and payout exactly as hashed (see @relaymesh/core bridgeCheckFacts). */
  facts: Record<string, unknown>;
  checkedAt: number;
}

/**
 * Records a verified bridge transfer for anchoring. The facts must re-hash to the check hash, so what
 * is stored is exactly what the hash commits to. The first verification of a deposit is kept.
 */
export async function recordBridgeCheck(db: Db, check: BridgeCheckRecord): Promise<void> {
  if (hashCanonical(BRIDGE_CHECK_DOMAIN, check.facts) !== check.checkHash) {
    throw new RelayMeshError("INTEGRITY_ERROR", `Bridge check facts do not hash to ${check.checkHash}`);
  }
  await db.insert(bridgeChecks).values(check).onConflictDoNothing();
}

/** The check hash recorded for a deposit ("block-index"), or null if none is. */
export async function findBridgeCheckHash(db: Db, depositId: string): Promise<Hex | null> {
  const [row] = await db.select({ checkHash: bridgeChecks.checkHash }).from(bridgeChecks).where(eq(bridgeChecks.depositId, depositId));
  return (row?.checkHash as Hex | undefined) ?? null;
}

export interface PendingBridgeCheck {
  checkHash: Hex;
  checkedAt: number;
}

/** Verified bridge transfers neither in a mined batch of any batch contract nor planned for this contract, longest-waiting first. */
export async function listPendingBridgeChecks(db: Db, contractAddress: Hex, limit: number): Promise<PendingBridgeCheck[]> {
  const rows = await db
    .select({ checkHash: bridgeChecks.checkHash, checkedAt: bridgeChecks.checkedAt })
    .from(bridgeChecks)
    .where(
      and(
        sql`NOT EXISTS (SELECT 1 FROM ${bridgeBatchLeaves} WHERE ${bridgeBatchLeaves.checkHash} = ${bridgeChecks.checkHash} AND ${bridgeBatchLeaves.contractAddress} = ${contractAddress})`,
        sql`NOT EXISTS (SELECT 1 FROM ${bridgeBatchLeaves} JOIN ${receiptBatchAnchors} ON ${receiptBatchAnchors.contractAddress} = ${bridgeBatchLeaves.contractAddress} AND ${receiptBatchAnchors.root} = ${bridgeBatchLeaves.batchRoot} WHERE ${bridgeBatchLeaves.checkHash} = ${bridgeChecks.checkHash})`,
      ),
    )
    .orderBy(asc(bridgeChecks.checkedAt), asc(bridgeChecks.checkHash))
    .limit(limit);
  return rows.map((r) => ({ checkHash: r.checkHash as Hex, checkedAt: r.checkedAt }));
}

export type BridgeCheckAnchor =
  /** Recorded and waiting for the next batch. */
  | { status: "queued" }
  /** In a planned batch whose root is not confirmed on chain yet. */
  | { status: "batching"; contractAddress: Hex; root: Hex; leafHash: Hex; proof: Hex[] }
  /** In a batch whose root is recorded on chain. */
  | { status: "anchored"; contractAddress: Hex; root: Hex; leafHash: Hex; proof: Hex[]; leafCount: number; txHash: Hex; blockNumber: bigint };

/**
 * Where a bridge check stands on its way on chain, in any of these batch contracts (a mined batch
 * first), or null if RelayMesh has not recorded it.
 */
export async function getBridgeCheckAnchor(db: Db, checkHash: Hex, contracts: readonly Hex[]): Promise<BridgeCheckAnchor | null> {
  const [check] = await db.select({ checkHash: bridgeChecks.checkHash }).from(bridgeChecks).where(eq(bridgeChecks.checkHash, checkHash));
  if (!check) return null;
  if (contracts.length === 0) return { status: "queued" };
  const [row] = await db
    .select({ leaf: bridgeBatchLeaves, batch: receiptBatches, anchor: receiptBatchAnchors })
    .from(bridgeBatchLeaves)
    .innerJoin(receiptBatches, and(eq(receiptBatches.contractAddress, bridgeBatchLeaves.contractAddress), eq(receiptBatches.root, bridgeBatchLeaves.batchRoot)))
    .leftJoin(receiptBatchAnchors, and(eq(receiptBatchAnchors.contractAddress, receiptBatches.contractAddress), eq(receiptBatchAnchors.root, receiptBatches.root)))
    .where(and(eq(bridgeBatchLeaves.checkHash, checkHash), inArray(bridgeBatchLeaves.contractAddress, [...contracts])))
    .orderBy(sql`${receiptBatchAnchors.blockNumber} IS NULL`, asc(receiptBatchAnchors.blockNumber), desc(receiptBatches.createdAt))
    .limit(1);
  if (!row) return { status: "queued" };
  const leaf = { contractAddress: row.batch.contractAddress as Hex, root: row.batch.root as Hex, leafHash: row.leaf.leafHash as Hex, proof: proofOf(row.leaf.proof) };
  if (!row.anchor) return { status: "batching", ...leaf };
  return { status: "anchored", ...leaf, leafCount: row.batch.leafCount, txHash: row.anchor.txHash as Hex, blockNumber: row.anchor.blockNumber };
}
