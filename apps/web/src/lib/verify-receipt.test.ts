import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes, type Hex } from "viem";
import { batchLeaf, buildMerkleTree, merkleProof } from "@relaymesh/core";
import { parseReceipt, ReceiptFormatError, receiptHashOf, verifyReceipt, type AnchorState, type BatchProofClaim, type BatchReader, type BatchState, type RegistryReader } from "./verify-receipt";

// The real receipt of the 150 tPOT transfer settled in block #136917, as downloaded from RelayMesh,
// and the receipt hash the relayer anchored for it in IntentRegistry (tx 0x7b09dc97…, block #136956).
const RECEIPT_JSON = readFileSync(new URL("./fixtures/receipt-block-136917.json", import.meta.url), "utf8");
const ANCHORED_HASH = "0x58f6e2f9dae10f1a2313815ad21f8fd8b8ef1cc3f2d00f9e17db47ea793fb54e" as Hex;
const RELAYER = "0xd0dd606e328e9402c056d50171cacaadfb2563e4" as Hex;
const ROUTE_ID = keccak256(stringToBytes("v3-substrate-to-evm"));
const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
const ANCHORED: AnchorState = { recorder: RELAYER, routeId: ROUTE_ID, receiptHash: ANCHORED_HASH };

function reader(state: AnchorState | null, findReceiptTx: RegistryReader["findReceiptTx"] = async () => ({ txHash: "0x7b09" as Hex, blockNumber: 136956n })): RegistryReader {
  return {
    getIntent: async () => state ?? { recorder: `0x${"0".repeat(40)}` as Hex, routeId: ZERO_HASH, receiptHash: ZERO_HASH },
    findReceiptTx,
  };
}

describe("receipt verification in the browser", () => {
  it("re-hashes the real downloaded receipt to the hash anchored on chain", () => {
    expect(receiptHashOf(parseReceipt(RECEIPT_JSON))).toBe(ANCHORED_HASH);
  });

  it("gives the same hash for a pretty-printed copy, since the hash covers canonical JSON", () => {
    expect(receiptHashOf(parseReceipt(JSON.stringify(JSON.parse(RECEIPT_JSON), null, 2)))).toBe(ANCHORED_HASH);
  });

  it("matches when the registry holds this receipt's hash", async () => {
    const result = await verifyReceipt(parseReceipt(RECEIPT_JSON), reader(ANCHORED));
    expect(result).toMatchObject({ verdict: "match", computedHash: ANCHORED_HASH, routeMatches: true, anchorTx: { blockNumber: 136956n } });
  });

  it("catches one changed digit in the observed amount", async () => {
    const tampered = RECEIPT_JSON.replace('"observedAmount":"149900000000000000000"', '"observedAmount":"249900000000000000000"');
    expect(tampered).not.toBe(RECEIPT_JSON);
    const result = await verifyReceipt(parseReceipt(tampered), reader(ANCHORED));
    expect(result.verdict).toBe("mismatch");
    expect(result.computedHash).not.toBe(ANCHORED_HASH);
  });

  it("reports a recorded intent whose receipt is not on chain yet", async () => {
    const result = await verifyReceipt(parseReceipt(RECEIPT_JSON), reader({ ...ANCHORED, receiptHash: ZERO_HASH }));
    expect(result).toMatchObject({ verdict: "receipt_pending", anchorTx: null });
  });

  it("reports an intent that was never anchored", async () => {
    expect(await verifyReceipt(parseReceipt(RECEIPT_JSON), reader(null))).toMatchObject({ verdict: "not_anchored", routeMatches: null });
  });

  it("flags a route ID on chain that differs from the receipt's", async () => {
    const result = await verifyReceipt(parseReceipt(RECEIPT_JSON), reader({ ...ANCHORED, routeId: keccak256(stringToBytes("other-route")) }));
    expect(result).toMatchObject({ verdict: "match", routeMatches: false });
  });

  it("keeps the verdict when the transaction search fails", async () => {
    const failing = reader(ANCHORED, async () => {
      throw new Error("log range too large");
    });
    expect(await verifyReceipt(parseReceipt(RECEIPT_JSON), failing)).toMatchObject({ verdict: "match", anchorTx: null });
  });

  it("rejects input that is not a RelayMesh receipt, with a reason", () => {
    expect(() => parseReceipt("{not json")).toThrow(ReceiptFormatError);
    expect(() => parseReceipt(JSON.stringify({ version: 2 }))).toThrow(/version 1/);
    expect(() => parseReceipt(JSON.stringify({ version: 1, intentId: "0x12", intentHash: "0x" }))).toThrow(/intentId/);
  });
});

describe("batched receipt verification in the browser", () => {
  const receipt = parseReceipt(RECEIPT_JSON);
  const leaf = batchLeaf(receipt.intentHash, ANCHORED_HASH);
  // A batch of five: this receipt and four other settled intents.
  const others = [1, 2, 3, 4].map((n) => batchLeaf(keccak256(stringToBytes(`intent-${n}`)), keccak256(stringToBytes(`receipt-${n}`))));
  const tree = buildMerkleTree([leaf, ...others]);
  const claim: BatchProofClaim = { receiptHash: ANCHORED_HASH, proof: merkleProof(tree, leaf) };
  const BATCH: BatchState = { recordedAt: 1_793_270_000n, blockNumber: 240_100n, leafCount: 5 };
  const BATCH_TX = { txHash: `0x${"5b".repeat(32)}` as Hex, blockNumber: 240_100n };

  function batches(served: BatchProofClaim | null, recorded: Hex[] = [tree.root]): BatchReader & { lookups: Hex[] } {
    const lookups: Hex[] = [];
    return {
      lookups,
      fetchProof: async () => served,
      getBatch: async (root) => {
        lookups.push(root);
        return recorded.includes(root) ? BATCH : null;
      },
      findBatchTx: async (root, block) => (recorded.includes(root) && block === BATCH.blockNumber ? BATCH_TX : null),
    };
  }

  it("folds the proof from a leaf computed here up to a root recorded on chain", async () => {
    const result = await verifyReceipt(receipt, reader(null), batches(claim));
    expect(result).toMatchObject({
      verdict: "match",
      anchoredIn: "batch",
      anchoredHash: ANCHORED_HASH,
      batch: { leaf, root: tree.root, proof: claim.proof, onChain: { leafCount: 5 } },
      anchorTx: BATCH_TX,
      routeMatches: null,
    });
  });

  it("catches one changed digit in a batched receipt, and shows the hash the chain commits to", async () => {
    const tampered = parseReceipt(RECEIPT_JSON.replace('"observedAmount":"149900000000000000000"', '"observedAmount":"249900000000000000000"'));
    const reads = batches(claim);
    const result = await verifyReceipt(tampered, reader(null), reads);
    expect(result).toMatchObject({ verdict: "mismatch", anchoredIn: "batch", anchoredHash: ANCHORED_HASH, batch: { root: tree.root } });
    expect(result.computedHash).not.toBe(ANCHORED_HASH);
    expect(result.batch?.leaf).not.toBe(leaf);
    // The tampered receipt's own fold reached a root nobody recorded.
    expect(reads.lookups[0]).not.toBe(tree.root);
  });

  it("rejects a proof that leads to no recorded root, whatever RelayMesh claims", async () => {
    const forged = { receiptHash: ANCHORED_HASH, proof: [...claim.proof.slice(0, -1), keccak256(stringToBytes("forged"))] };
    expect(await verifyReceipt(receipt, reader(null), batches(forged))).toMatchObject({ verdict: "proof_invalid", anchoredIn: null, anchoredHash: null, anchorTx: null });
    expect(await verifyReceipt(receipt, reader(null), batches(claim, []))).toMatchObject({ verdict: "proof_invalid" });
    expect(await verifyReceipt(receipt, reader(null), batches({ receiptHash: ANCHORED_HASH, proof: ["0xnot-a-hash" as Hex] }))).toMatchObject({ verdict: "proof_invalid" });
  });

  it("rejects a proof with a level missing", async () => {
    expect(await verifyReceipt(receipt, reader(null), batches({ receiptHash: ANCHORED_HASH, proof: claim.proof.slice(1) }))).toMatchObject({ verdict: "proof_invalid" });
  });

  it("checks IntentRegistry first, so receipts anchored before batching verify exactly as before", async () => {
    const reads = batches(claim);
    const result = await verifyReceipt(receipt, reader(ANCHORED), reads);
    expect(result).toMatchObject({ verdict: "match", anchoredIn: "registry", anchoredHash: ANCHORED_HASH, batch: null, routeMatches: true, anchorTx: { blockNumber: 136956n } });
    expect(reads.lookups).toEqual([]);
  });

  it("uses the batch when IntentRegistry recorded the intent but never its receipt", async () => {
    const result = await verifyReceipt(receipt, reader({ ...ANCHORED, receiptHash: ZERO_HASH }), batches(claim));
    expect(result).toMatchObject({ verdict: "match", anchoredIn: "batch", routeMatches: true });
  });

  it("reports a receipt RelayMesh has not batched yet as not anchored", async () => {
    expect(await verifyReceipt(receipt, reader(null), batches(null))).toMatchObject({ verdict: "not_anchored", batch: null });
    expect(await verifyReceipt(receipt, null, batches(null))).toMatchObject({ verdict: "not_anchored" });
  });

  it("keeps the verdict when the batch transaction search fails", async () => {
    const reads = { ...batches(claim), findBatchTx: async () => Promise.reject(new Error("log range too large")) };
    expect(await verifyReceipt(receipt, reader(null), reads)).toMatchObject({ verdict: "match", anchorTx: null });
  });
});
