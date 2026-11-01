import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Hex } from "viem";
import { batchLeaf, bridgeCheckLeaf, RelayMeshError, verifyMerkleProof } from "@relaymesh/core";
import type { Db } from "./client";
import { bridgeBatchLeaves, intents, receiptBatchAnchors, receiptBatches, receiptBatchLeaves, registryAnchors, statusEvents } from "./schema";

const HEX32 = /^0x[0-9a-f]{64}$/;

export interface PendingReceiptAnchor {
  intentId: Hex;
  /** When the intent settled, in unix seconds. */
  settledAt: number;
}

/**
 * Settled intents whose receipt is anchored neither in IntentRegistry (the per-intent registry used
 * before batching), nor in a mined batch of any batch contract, nor planned for this contract,
 * longest-waiting first. A receipt anchored in an earlier contract is never anchored again.
 */
export async function listPendingReceiptAnchors(db: Db, contractAddress: Hex, limit: number): Promise<PendingReceiptAnchor[]> {
  const settledAt = sql<number>`(SELECT max(${statusEvents.at}) FROM ${statusEvents} WHERE ${statusEvents.intentId} = ${intents.intentId} AND ${statusEvents.status} = 'SETTLED')`.mapWith(Number);
  const rows = await db
    .select({ intentId: intents.intentId, settledAt })
    .from(intents)
    .where(
      and(
        eq(intents.currentStatus, "SETTLED"),
        sql`NOT EXISTS (SELECT 1 FROM ${registryAnchors} WHERE ${registryAnchors.intentId} = ${intents.intentId} AND ${registryAnchors.step} = 'receipt')`,
        sql`NOT EXISTS (SELECT 1 FROM ${receiptBatchLeaves} WHERE ${receiptBatchLeaves.intentId} = ${intents.intentId} AND ${receiptBatchLeaves.contractAddress} = ${contractAddress})`,
        sql`NOT EXISTS (SELECT 1 FROM ${receiptBatchLeaves} JOIN ${receiptBatchAnchors} ON ${receiptBatchAnchors.contractAddress} = ${receiptBatchLeaves.contractAddress} AND ${receiptBatchAnchors.root} = ${receiptBatchLeaves.batchRoot} WHERE ${receiptBatchLeaves.intentId} = ${intents.intentId})`,
      ),
    )
    .orderBy(asc(settledAt), asc(intents.createdAt))
    .limit(limit);
  return rows.map((r) => ({ intentId: r.intentId as Hex, settledAt: r.settledAt }));
}

export interface ReceiptBatchLeaf {
  intentId: Hex;
  intentHash: Hex;
  receiptHash: Hex;
  leafHash: Hex;
  /** Sibling hashes from the leaf up to the root. */
  proof: Hex[];
}

export interface BridgeBatchLeaf {
  checkHash: Hex;
  leafHash: Hex;
  /** Sibling hashes from the leaf up to the root. */
  proof: Hex[];
}

export interface ReceiptBatchPlan {
  contractAddress: Hex;
  chainId: number;
  root: Hex;
  createdAt: number;
  leaves: ReceiptBatchLeaf[];
  /** Verified bridge transfers anchored in the same batch, alongside the receipts. */
  bridgeLeaves?: BridgeBatchLeaf[];
}

/**
 * Stores a batch before its root is sent, so the exact root can be recovered after a crash. Every leaf
 * is recomputed and its proof checked against the root first: a batch that does not hold together is
 * an integrity error and is never stored. Re-planning the identical batch is a no-op.
 */
export async function planReceiptBatch(db: Db, plan: ReceiptBatchPlan): Promise<void> {
  const bridgeLeaves = plan.bridgeLeaves ?? [];
  if (plan.leaves.length + bridgeLeaves.length === 0) throw new RelayMeshError("INVALID_BATCH", "A batch needs at least one leaf");
  for (const leaf of bridgeLeaves) {
    if (bridgeCheckLeaf(leaf.checkHash) !== leaf.leafHash) {
      throw new RelayMeshError("INTEGRITY_ERROR", `Leaf of bridge check ${leaf.checkHash} does not commit to its check hash`);
    }
    if (!verifyMerkleProof(leaf.leafHash, leaf.proof, plan.root)) {
      throw new RelayMeshError("INTEGRITY_ERROR", `Proof of bridge check ${leaf.checkHash} does not lead to root ${plan.root}`);
    }
  }
  for (const leaf of plan.leaves) {
    if (batchLeaf(leaf.intentHash, leaf.receiptHash) !== leaf.leafHash) {
      throw new RelayMeshError("INTEGRITY_ERROR", `Leaf of ${leaf.intentId} does not commit to its intent and receipt hashes`);
    }
    if (!verifyMerkleProof(leaf.leafHash, leaf.proof, plan.root)) {
      throw new RelayMeshError("INTEGRITY_ERROR", `Proof of ${leaf.intentId} does not lead to root ${plan.root}`);
    }
  }
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(receiptBatches)
      .values({ contractAddress: plan.contractAddress, chainId: plan.chainId, root: plan.root, leafCount: plan.leaves.length + bridgeLeaves.length, createdAt: plan.createdAt })
      .onConflictDoNothing()
      .returning({ root: receiptBatches.root });
    if (inserted.length === 0) return;
    if (plan.leaves.length > 0) {
      await tx.insert(receiptBatchLeaves).values(plan.leaves.map((leaf) => ({ ...leaf, contractAddress: plan.contractAddress, batchRoot: plan.root })));
    }
    if (bridgeLeaves.length > 0) {
      await tx.insert(bridgeBatchLeaves).values(bridgeLeaves.map((leaf) => ({ ...leaf, contractAddress: plan.contractAddress, batchRoot: plan.root })));
    }
  });
}

export interface StoredReceiptBatch {
  contractAddress: Hex;
  chainId: number;
  root: Hex;
  leafCount: number;
  createdAt: number;
}

/** Planned batches of this contract with no recorded transaction yet, oldest first. */
export async function listUnconfirmedReceiptBatches(db: Db, contractAddress: Hex): Promise<StoredReceiptBatch[]> {
  const rows = await db
    .select()
    .from(receiptBatches)
    .where(
      and(
        eq(receiptBatches.contractAddress, contractAddress),
        sql`NOT EXISTS (SELECT 1 FROM ${receiptBatchAnchors} WHERE ${receiptBatchAnchors.contractAddress} = ${receiptBatches.contractAddress} AND ${receiptBatchAnchors.root} = ${receiptBatches.root})`,
      ),
    )
    .orderBy(asc(receiptBatches.createdAt), asc(receiptBatches.insertedAt));
  return rows.map((r) => ({ contractAddress: r.contractAddress as Hex, chainId: r.chainId, root: r.root as Hex, leafCount: r.leafCount, createdAt: r.createdAt }));
}

export interface ReceiptBatchAnchor {
  contractAddress: Hex;
  root: Hex;
  txHash: Hex;
  blockNumber: bigint;
}

/** Records a batch's mined transaction. Re-recording the same transaction is a no-op; a different one is an integrity error. */
export async function recordReceiptBatchAnchor(db: Db, anchor: ReceiptBatchAnchor): Promise<void> {
  const inserted = await db.insert(receiptBatchAnchors).values(anchor).onConflictDoNothing().returning({ root: receiptBatchAnchors.root });
  if (inserted.length > 0) return;
  const [existing] = await db
    .select()
    .from(receiptBatchAnchors)
    .where(and(eq(receiptBatchAnchors.contractAddress, anchor.contractAddress), eq(receiptBatchAnchors.root, anchor.root)));
  if (!existing || existing.txHash !== anchor.txHash) {
    throw new RelayMeshError("INTEGRITY_ERROR", `A different transaction is already recorded for batch ${anchor.root}`);
  }
}

export interface ReceiptBatchProof {
  contractAddress: Hex;
  chainId: number;
  root: Hex;
  leafCount: number;
  intentHash: Hex;
  receiptHash: Hex;
  leafHash: Hex;
  proof: Hex[];
  txHash: Hex;
  blockNumber: bigint;
}

export function proofOf(value: unknown): Hex[] {
  if (!Array.isArray(value) || !value.every((v): v is Hex => typeof v === "string" && HEX32.test(v))) {
    throw new RelayMeshError("INTEGRITY_ERROR", "Stored batch proof is malformed");
  }
  return value;
}

/** An intent's leaf and proof in a confirmed batch of one of these contracts (the earliest mined), or null if it is not anchored in one. */
export async function getReceiptBatchProof(db: Db, intentId: Hex, contracts: readonly Hex[]): Promise<ReceiptBatchProof | null> {
  if (contracts.length === 0) return null;
  const [row] = await db
    .select({ leaf: receiptBatchLeaves, batch: receiptBatches, anchor: receiptBatchAnchors })
    .from(receiptBatchLeaves)
    .innerJoin(receiptBatches, and(eq(receiptBatches.contractAddress, receiptBatchLeaves.contractAddress), eq(receiptBatches.root, receiptBatchLeaves.batchRoot)))
    .innerJoin(receiptBatchAnchors, and(eq(receiptBatchAnchors.contractAddress, receiptBatches.contractAddress), eq(receiptBatchAnchors.root, receiptBatches.root)))
    .where(and(eq(receiptBatchLeaves.intentId, intentId), inArray(receiptBatchLeaves.contractAddress, [...contracts])))
    .orderBy(asc(receiptBatchAnchors.blockNumber))
    .limit(1);
  if (!row) return null;
  return {
    contractAddress: row.batch.contractAddress as Hex,
    chainId: row.batch.chainId,
    root: row.batch.root as Hex,
    leafCount: row.batch.leafCount,
    intentHash: row.leaf.intentHash as Hex,
    receiptHash: row.leaf.receiptHash as Hex,
    leafHash: row.leaf.leafHash as Hex,
    proof: proofOf(row.leaf.proof),
    txHash: row.anchor.txHash as Hex,
    blockNumber: row.anchor.blockNumber,
  };
}
