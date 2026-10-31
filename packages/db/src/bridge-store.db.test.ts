import { sql } from "drizzle-orm";
import type { Hex } from "viem";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { bridgeCheckFacts, bridgeCheckLeaf, buildMerkleTree, hashBridgeCheck, isRelayMeshError, merkleProof, type BridgeDeposit, type BridgePayout } from "@relaymesh/core";
import { planReceiptBatch, recordReceiptBatchAnchor } from "./batch-store";
import { findBridgeCheckHash, getBridgeCheckAnchor, listPendingBridgeChecks, recordBridgeCheck, type BridgeCheckRecord } from "./bridge-store";
import { connectDb } from "./client";

const { db, close } = connectDb(process.env.TEST_DATABASE_URL as string, { max: 4 });
afterAll(() => close());
beforeEach(async () => {
  await db.execute(
    sql`TRUNCATE bridge_batch_leaves, bridge_checks, receipt_batch_anchors, receipt_batch_leaves, receipt_batches, watcher_cursors, registry_anchors, execution_plans, status_events, idempotency_records, quotes, intents`,
  );
});

const CONTRACT = "0x00000000000000000000000000000000000000ab" as Hex;
const NEXT_CONTRACT = "0x00000000000000000000000000000000000000cd" as Hex;
const NOW = 1_793_270_000;

// A verified bridge transfer shaped like the real 33 POT deposit (832820-1) and its 32.01 WPOT payout.
function check(block = 832_820, amount = 3_300_000_000_000_000n): BridgeCheckRecord {
  const deposit: BridgeDeposit = {
    id: { block, index: 1 },
    blockHash: `0x${"aa".repeat(32)}` as Hex,
    extrinsicHash: `0x${"bb".repeat(32)}` as Hex,
    time: 1_793_196_984,
    finalized: true,
    signer: "5HihmwaxKxhxdNTy4LM57bSeoMpRWprqsaJvLUVZ81bAwSJB",
    call: "balances.transferKeepAlive",
    destination: "5DFSpdFBFU1eXYUKf6887djpFAhrEuzgUEDHHb9ksi2javoo",
    amount,
    success: true,
  };
  const payout: BridgePayout = {
    txHash: `0x${block.toString(16).padStart(64, "0")}` as Hex,
    blockNumber: 130_387_635n,
    time: 1_793_238_384,
    recipient: "0x43b4202021771ef6fa034e9ea10a54dcd076c25c" as Hex,
    amount: (amount * 10_000n * 97n) / 100n,
    finalized: true,
  };
  return { checkHash: hashBridgeCheck(deposit, payout), depositId: `${block}-1`, payoutTxHash: payout.txHash, facts: bridgeCheckFacts(deposit, payout), checkedAt: NOW };
}

describe("bridge checks", () => {
  it("records a verified transfer once and lists it as pending", async () => {
    const c = check();
    await recordBridgeCheck(db, c);
    await recordBridgeCheck(db, c); // a repeat check of the same deposit is a no-op
    expect(await listPendingBridgeChecks(db, CONTRACT, 10)).toEqual([{ checkHash: c.checkHash, checkedAt: NOW }]);
    expect(await getBridgeCheckAnchor(db, c.checkHash, [CONTRACT])).toEqual({ status: "queued" });
    expect(await findBridgeCheckHash(db, "832820-1")).toBe(c.checkHash);
    expect(await findBridgeCheckHash(db, "832820-2")).toBeNull();
  });

  it("refuses facts that do not hash to the check hash", async () => {
    const c = check();
    const error = await recordBridgeCheck(db, { ...c, facts: { ...c.facts, payout: null } }).then(() => null, (e: unknown) => e);
    expect(isRelayMeshError(error) && error.code).toBe("INTEGRITY_ERROR");
  });

  it("moves from queued to batching to anchored as its batch is planned and mined", async () => {
    const a = check(832_820);
    const b = check(833_349, 2_700_000_000_000_000n);
    await recordBridgeCheck(db, a);
    await recordBridgeCheck(db, b);
    const leaves = [a, b].map((c) => ({ checkHash: c.checkHash, leafHash: bridgeCheckLeaf(c.checkHash) }));
    const tree = buildMerkleTree(leaves.map((l) => l.leafHash));
    await planReceiptBatch(db, { contractAddress: CONTRACT, chainId: 420420777, root: tree.root, createdAt: NOW, leaves: [], bridgeLeaves: leaves.map((l) => ({ ...l, proof: merkleProof(tree, l.leafHash) })) });
    expect(await listPendingBridgeChecks(db, CONTRACT, 10)).toEqual([]);
    expect(await getBridgeCheckAnchor(db, a.checkHash, [CONTRACT])).toMatchObject({ status: "batching", root: tree.root });

    await recordReceiptBatchAnchor(db, { contractAddress: CONTRACT, root: tree.root, txHash: `0x${"77".repeat(32)}` as Hex, blockNumber: 244_000n });
    expect(await getBridgeCheckAnchor(db, b.checkHash, [CONTRACT])).toMatchObject({ status: "anchored", root: tree.root, leafCount: 2, blockNumber: 244_000n });
  });

  it("is not anchored again in a later batch contract once a batch holding it is mined", async () => {
    const mined = check(832_820);
    const planned = check(833_349, 2_700_000_000_000_000n);
    await recordBridgeCheck(db, mined);
    await recordBridgeCheck(db, planned);
    for (const c of [mined, planned]) {
      const leafHash = bridgeCheckLeaf(c.checkHash);
      await planReceiptBatch(db, { contractAddress: CONTRACT, chainId: 420420777, root: leafHash, createdAt: NOW, leaves: [], bridgeLeaves: [{ checkHash: c.checkHash, leafHash, proof: [] }] });
    }
    await recordReceiptBatchAnchor(db, { contractAddress: CONTRACT, root: bridgeCheckLeaf(mined.checkHash), txHash: `0x${"77".repeat(32)}` as Hex, blockNumber: 244_000n });

    // A batch planned but never mined in the old contract does not hold the check back from the new one.
    expect(await listPendingBridgeChecks(db, NEXT_CONTRACT, 10)).toEqual([{ checkHash: planned.checkHash, checkedAt: NOW }]);
    expect(await getBridgeCheckAnchor(db, mined.checkHash, [NEXT_CONTRACT, CONTRACT])).toMatchObject({ status: "anchored", contractAddress: CONTRACT });
    expect(await getBridgeCheckAnchor(db, mined.checkHash, [NEXT_CONTRACT])).toEqual({ status: "queued" });
  });

  it("refuses a batch whose bridge leaf does not commit to its check", async () => {
    const c = check();
    await recordBridgeCheck(db, c);
    const wrong = bridgeCheckLeaf(`0x${"cd".repeat(32)}` as Hex);
    const error = await planReceiptBatch(db, { contractAddress: CONTRACT, chainId: 420420777, root: wrong, createdAt: NOW, leaves: [], bridgeLeaves: [{ checkHash: c.checkHash, leafHash: wrong, proof: [] }] }).then(() => null, (e: unknown) => e);
    expect(isRelayMeshError(error) && error.code).toBe("INTEGRITY_ERROR");
  });

  it("knows nothing of a check RelayMesh never recorded", async () => {
    expect(await getBridgeCheckAnchor(db, check().checkHash, [CONTRACT])).toBeNull();
  });
});
