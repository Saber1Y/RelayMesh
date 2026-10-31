import { sql } from "drizzle-orm";
import { keccak256, stringToBytes, type Hex } from "viem";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { batchLeaf, buildMerkleTree, createIntent, hashRequest, isRelayMeshError, merkleProof, type RelayMeshErrorCode } from "@relaymesh/core";
import {
  getReceiptBatchProof,
  listUnconfirmedReceiptBatches,
  planReceiptBatch,
  recordReceiptBatchAnchor,
  type ReceiptBatchLeaf,
  type ReceiptBatchPlan,
} from "./batch-store";
import { countAnchoredReceipts } from "./activity-store";
import { connectDb } from "./client";
import { insertIntent } from "./store";
import { recordAnchor } from "./watcher-store";

const { db, close } = connectDb(process.env.TEST_DATABASE_URL as string, { max: 4 });
afterAll(() => close());
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE bridge_batch_leaves, bridge_checks, receipt_batch_anchors, receipt_batch_leaves, receipt_batches, watcher_cursors, registry_anchors, execution_plans, status_events, idempotency_records, quotes, intents`,
  );
});

const NOW = 1_792_500_000;
const CONTRACT = "0x00000000000000000000000000000000000000ab" as Hex;
const OTHER_CONTRACT = "0x00000000000000000000000000000000000000cd" as Hex;
const TX = `0x${"77".repeat(32)}` as Hex;

async function newIntent(n: number) {
  const body = {
    requester: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    source: { chain: "portaldot-v3-substrate", asset: "native", amount: String(1_000 + n) },
    destination: { chain: "portaldot-v3-evm", asset: "native", recipient: "0xB4A81005669984dBBF9dE26aF42e82Bc9A3C4a27" },
    constraints: { deadline: NOW + 600 },
  };
  const created = createIntent(body, { now: NOW });
  await insertIntent(db, { ...created, idempotencyKey: `key-${crypto.randomUUID()}`, requestHash: hashRequest(body) });
  return created;
}

/** A consistent batch over n fresh intents, built with the real Merkle code. */
async function batchOf(n: number, contractAddress = CONTRACT): Promise<ReceiptBatchPlan> {
  const entries = await Promise.all(
    Array.from({ length: n }, async (_, i) => {
      const { intent, intentHash } = await newIntent(i);
      const receiptHash = keccak256(stringToBytes(`receipt-${intent.intentId}`));
      return { intentId: intent.intentId, intentHash, receiptHash, leafHash: batchLeaf(intentHash, receiptHash) };
    }),
  );
  const tree = buildMerkleTree(entries.map((e) => e.leafHash));
  const leaves: ReceiptBatchLeaf[] = entries.map((e) => ({ ...e, proof: merkleProof(tree, e.leafHash) }));
  return { contractAddress, chainId: 420420777, root: tree.root, createdAt: NOW, leaves };
}

async function expectCode(promise: Promise<unknown>, code: RelayMeshErrorCode): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isRelayMeshError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
}

async function expectDbRejection(promise: Promise<unknown>, message: RegExp): Promise<void> {
  const error = (await promise.then(
    () => undefined,
    (e: unknown) => e,
  )) as { message?: string; cause?: { message?: string } } | undefined;
  expect(error, "expected the database to reject the statement").toBeDefined();
  expect(`${error?.message} ${error?.cause?.message ?? ""}`).toMatch(message);
}

describe("receipt batches", () => {
  it("stores a planned batch, then serves each proof only once its transaction is recorded", async () => {
    const plan = await batchOf(5);
    await planReceiptBatch(db, plan);
    await planReceiptBatch(db, plan); // identical re-plan is a no-op
    expect(await listUnconfirmedReceiptBatches(db, CONTRACT)).toEqual([{ contractAddress: CONTRACT, chainId: 420420777, root: plan.root, leafCount: 5, createdAt: NOW }]);
    const leaf = plan.leaves[2] as ReceiptBatchLeaf;
    expect(await getReceiptBatchProof(db, leaf.intentId, [CONTRACT])).toBeNull();

    await recordReceiptBatchAnchor(db, { contractAddress: CONTRACT, root: plan.root, txHash: TX, blockNumber: 240_001n });
    await recordReceiptBatchAnchor(db, { contractAddress: CONTRACT, root: plan.root, txHash: TX, blockNumber: 240_001n });
    expect(await listUnconfirmedReceiptBatches(db, CONTRACT)).toEqual([]);
    expect(await getReceiptBatchProof(db, leaf.intentId, [CONTRACT])).toEqual({
      contractAddress: CONTRACT,
      chainId: 420420777,
      root: plan.root,
      leafCount: 5,
      intentHash: leaf.intentHash,
      receiptHash: leaf.receiptHash,
      leafHash: leaf.leafHash,
      proof: leaf.proof,
      txHash: TX,
      blockNumber: 240_001n,
    });
    expect(await getReceiptBatchProof(db, leaf.intentId, [OTHER_CONTRACT])).toBeNull();
    await expectCode(recordReceiptBatchAnchor(db, { contractAddress: CONTRACT, root: plan.root, txHash: `0x${"78".repeat(32)}`, blockNumber: 1n }), "INTEGRITY_ERROR");
  });

  it("refuses a batch whose leaves or proofs do not lead to its root", async () => {
    const plan = await batchOf(3);
    const [first, ...rest] = plan.leaves as [ReceiptBatchLeaf, ...ReceiptBatchLeaf[]];
    await expectCode(planReceiptBatch(db, { ...plan, leaves: [{ ...first, receiptHash: keccak256(stringToBytes("other")) }, ...rest] }), "INTEGRITY_ERROR");
    await expectCode(planReceiptBatch(db, { ...plan, leaves: [{ ...first, proof: first.proof.slice(1) }, ...rest] }), "INTEGRITY_ERROR");
    await expectCode(planReceiptBatch(db, { ...plan, leaves: [] }), "INVALID_BATCH");
    expect(await listUnconfirmedReceiptBatches(db, CONTRACT)).toEqual([]);
  });

  it("puts an intent in at most one batch per contract", async () => {
    const plan = await batchOf(2);
    await planReceiptBatch(db, plan);
    const [leaf] = plan.leaves as [ReceiptBatchLeaf];
    const alone = { ...plan, root: leaf.leafHash, leaves: [{ ...leaf, proof: [] }] };
    await expectDbRejection(planReceiptBatch(db, alone), /receipt_batch_leaves_pkey/);
    // The failed plan left nothing behind, and another contract may anchor the same intent.
    expect(await listUnconfirmedReceiptBatches(db, CONTRACT)).toHaveLength(1);
    await planReceiptBatch(db, { ...alone, contractAddress: OTHER_CONTRACT });
    expect(await listUnconfirmedReceiptBatches(db, OTHER_CONTRACT)).toHaveLength(1);
  });

  it("counts receipts anchored one by one and in mined batches, each intent once", async () => {
    const plan = await batchOf(3);
    await planReceiptBatch(db, plan);
    expect(await countAnchoredReceipts(db)).toBe(0); // planned, not mined
    await recordReceiptBatchAnchor(db, { contractAddress: CONTRACT, root: plan.root, txHash: TX, blockNumber: 1n });
    expect(await countAnchoredReceipts(db)).toBe(3);

    // An intent anchored in IntentRegistry before batching counts once, even if a batch also holds it.
    const leaf = plan.leaves[0] as ReceiptBatchLeaf;
    const anchor = { contractAddress: OTHER_CONTRACT, chainId: 420420777, txHash: TX, blockNumber: 1n };
    await recordAnchor(db, { ...anchor, intentId: leaf.intentId, step: "receipt", valueHash: leaf.receiptHash });
    const { intent, intentHash } = await newIntent(99);
    await recordAnchor(db, { ...anchor, intentId: intent.intentId, step: "intent", valueHash: intentHash });
    expect(await countAnchoredReceipts(db)).toBe(3);
    await recordAnchor(db, { ...anchor, intentId: intent.intentId, step: "receipt", valueHash: leaf.receiptHash });
    expect(await countAnchoredReceipts(db)).toBe(4);
  });

  it("is append-only", async () => {
    const plan = await batchOf(2);
    await planReceiptBatch(db, plan);
    await recordReceiptBatchAnchor(db, { contractAddress: CONTRACT, root: plan.root, txHash: TX, blockNumber: 1n });
    await expectDbRejection(db.execute(sql`UPDATE receipt_batches SET leaf_count = 9`), /append-only/);
    await expectDbRejection(db.execute(sql`UPDATE receipt_batch_leaves SET proof = '[]'::jsonb`), /append-only/);
    await expectDbRejection(db.execute(sql`DELETE FROM receipt_batch_leaves`), /append-only/);
    await expectDbRejection(db.execute(sql`DELETE FROM receipt_batch_anchors`), /append-only/);
  });
});
