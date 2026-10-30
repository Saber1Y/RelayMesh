import { sql } from "drizzle-orm";
import type { Hex } from "viem";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { BlockExtrinsic, BlockRef, EvmBalanceRead, ExtrinsicCheck, ExtrinsicVerification, V3ChainReader } from "@relaymesh/chains";
import { batchLeaf, BRIDGE_CHECK_DOMAIN, bridgeCheckLeaf, buildReceipt, hashCanonical, createIntent, hashReceipt, hashRequest, verifyMerkleProof, type IntentStatus, type Quote } from "@relaymesh/core";
import {
  advanceCursor,
  appendStatusEvent,
  connectDb,
  getBridgeCheckAnchor,
  getCursor,
  getReceiptBatchProof,
  insertIntent,
  listQuotes,
  listUnconfirmedReceiptBatches,
  loadIntent,
  recordAnchor,
  recordBridgeCheck,
  recordQuotes,
  selectQuote,
} from "@relaymesh/db";
import type { Logger } from "./log";
import { RelayerFundsError, type BatchRegistryClient, type BatchState, type MinedTx } from "./registry";
import { runPass, SOURCE_SCAN_CURSOR, type WatcherContext } from "./watcher";

// Test doubles: an in-memory V3 chain and registry. They model only what the watcher reads, so the
// watcher's decisions and database writes run for real against Postgres.

const REQUESTER = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const OTHER = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const RECIPIENT = "0x7a1d3a76fb0a1d8c2b3e4f5a6b7c8d9e0f1a2b3c";
const NOW = 1_792_500_000;
const EXPECTED = 900_000_000_000_000_000n;

const hash32 = (n: number | bigint, tag = "aa") => `0x${tag}${n.toString(16).padStart(62, "0")}` as Hex;

interface FakeBlock {
  hash: Hex;
  timestamp: number;
  extrinsics: (BlockExtrinsic & { success: boolean })[];
}

class FakeChain implements V3ChainReader {
  finalized = 100n;
  blocks = new Map<bigint, FakeBlock>();
  balances = new Map<string, bigint>();
  evmIndexedTo = 1_000n;
  prunedBelow = 0n;
  /** Remaining simulated RPC timeouts per block height (Infinity = always fails). */
  failReads = new Map<bigint, number>();
  /** Heights whose extrinsics were read, i.e. blocks the scanner actually scanned. */
  scanned = new Set<bigint>();

  block(n: bigint): FakeBlock {
    let b = this.blocks.get(n);
    if (!b) {
      // One block per second, with block 100 produced at NOW.
      b = { hash: hash32(n), timestamp: NOW + Number(n - 100n), extrinsics: [] };
      this.blocks.set(n, b);
    }
    return b;
  }
  async finalizedHead(): Promise<BlockRef> {
    return { number: this.finalized, hash: this.block(this.finalized).hash };
  }
  async canonicalHash(n: bigint) {
    const left = this.failReads.get(n) ?? 0;
    if (left > 0) {
      this.failReads.set(n, left - 1);
      throw new Error("No response received from RPC endpoint in 30s");
    }
    return this.block(n).hash;
  }
  async blockExtrinsics(hash: Hex) {
    const entry = [...this.blocks.entries()].find(([, b]) => b.hash === hash);
    if (entry) this.scanned.add(entry[0]);
    return entry?.[1].extrinsics ?? [];
  }
  async blockTimestamp(hash: Hex) {
    return [...this.blocks.values()].find((b) => b.hash === hash)?.timestamp ?? 0;
  }
  async verifyExtrinsic(check: ExtrinsicCheck): Promise<ExtrinsicVerification> {
    const entry = [...this.blocks.entries()].find(([, b]) => b.hash === check.blockHash);
    const ext = entry?.[1].extrinsics.find((e) => e.hash === check.txHash);
    if (!entry || !ext) return { found: false, reason: "not in block" };
    return {
      found: true,
      blockNumber: entry[0],
      extrinsicIndex: ext.index,
      callHex: ext.callHex,
      callMatches: ext.callHex === check.expectedCallHex,
      signerMatches: ext.signer === check.expectedSigner,
      success: ext.success,
      ...(!ext.success && { dispatchError: "balances.InsufficientBalance" }),
      events: [ext.success ? "system.ExtrinsicSuccess" : "system.ExtrinsicFailed"],
    };
  }
  async evmBalanceAt(address: Hex, n: bigint): Promise<EvmBalanceRead> {
    if (n > this.evmIndexedTo) return { ok: false, reason: "not_indexed", message: "behind" };
    if (n < this.prunedBelow) return { ok: false, reason: "state_pruned", message: "State already discarded" };
    return { ok: true, balance: this.balances.get(`${address}@${n}`) ?? 0n, blockHash: hash32(n, "ee") };
  }
  /** Balance of `address` is `before` up to block n-1 and `after` from block n on. */
  setDelta(address: string, n: bigint, before: bigint, after: bigint): void {
    this.balances.set(`${address}@${n - 1n}`, before);
    this.balances.set(`${address}@${n}`, after);
  }
}

class FakeBatchRegistry implements BatchRegistryClient {
  address = "0x00000000000000000000000000000000000000aa" as Hex;
  chainId = 420420777;
  recorder = "0x00000000000000000000000000000000000000bb" as Hex;
  batches = new Map<Hex, BatchState & MinedTx>();
  /** Roots of every mined recordBatch, in order. */
  writes: Hex[] = [];
  /** When set, every write fails the way an unfunded relayer's does; `refused` counts those attempts. */
  shortOfFunds = false;
  refused = 0;
  /** "after_mining": the next write is mined, then the worker dies before recording it. "before_sending": it dies first. */
  crash: "after_mining" | "before_sending" | null = null;
  private block = 500n;

  async contractRecorder() {
    return this.recorder;
  }
  async getBatch(root: Hex) {
    const b = this.batches.get(root);
    return b ? { recordedAt: b.recordedAt, blockNumber: b.blockNumber, leafCount: b.leafCount } : null;
  }
  async recordBatch(root: Hex, leafCount: number) {
    if (this.crash === "before_sending") {
      this.crash = null;
      throw new Error("worker stopped before sending");
    }
    if (this.shortOfFunds) {
      this.refused++;
      throw new RelayerFundsError(this.recorder, 1_597_805_812_053_544_000n, 4_892_650_567_171_883_400n);
    }
    if (this.batches.has(root)) throw new Error(`BatchAlreadyRecorded(${root})`);
    const tx = { txHash: hash32(++this.block, "cc"), blockNumber: this.block };
    this.batches.set(root, { ...tx, recordedAt: BigInt(clock), leafCount });
    this.writes.push(root);
    if (this.crash === "after_mining") {
      this.crash = null;
      throw new Error("worker stopped after the transaction was mined");
    }
    return tx;
  }
  async findBatchEvent(root: Hex, blockNumber: bigint) {
    const b = this.batches.get(root);
    return b && b.blockNumber === blockNumber ? { txHash: b.txHash, blockNumber: b.blockNumber } : null;
  }
}

const silent: Logger = { info: () => {}, warn: () => {}, error: (m, f) => process.env.DEBUG_WATCHER && console.error(m, f) };

const { db, close } = connectDb(process.env.TEST_DATABASE_URL as string, { max: 4 });
afterAll(() => close());

let chain: FakeChain;
let registry: FakeBatchRegistry | null;
let batching: WatcherContext["config"]["batching"];
let clock: number;
let callCounter = 0;

function ctx(): WatcherContext {
  return {
    db,
    chain,
    registry,
    log: silent,
    now: () => clock,
    config: { scanBackfillBlocks: 10, maxBlocksPerPass: 50, signedTxLifetimeSeconds: 1_800, rpcRetryDelayMs: 0, batching },
  };
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE bridge_batch_leaves, bridge_checks, receipt_batch_anchors, receipt_batch_leaves, receipt_batches, watcher_cursors, registry_anchors, execution_plans, status_events, idempotency_records, quotes, intents`);
  chain = new FakeChain();
  registry = new FakeBatchRegistry();
  // Anchor every receipt as it settles unless a test is about batching.
  batching = { size: 1, maxWaitSeconds: 1_800, maxLeaves: 256 };
  clock = NOW + 30; // after the reported submission at NOW + 5, as in real use
});

/** Creates an intent and drives it to AWAITING_SIGNATURE with a stored plan, through the real store functions. */
async function awaitingIntent(amount = "100000000000000", sharedCallHex?: Hex, at = NOW) {
  const body = {
    requester: REQUESTER,
    source: { chain: "portaldot-v3-substrate", asset: "native", amount },
    destination: { chain: "portaldot-v3-evm", asset: "native", recipient: RECIPIENT },
    constraints: { deadline: at + 600 },
  };
  const { intent, intentHash } = createIntent(body, { now: at });
  await insertIntent(db, { intent, intentHash, idempotencyKey: `test-${crypto.randomUUID()}`, requestHash: hashRequest(body) });
  const quote: Quote = {
    quoteId: `q-${crypto.randomUUID()}`,
    intentId: intent.intentId,
    provider: "portaldot-v3-native",
    routeId: "v3-substrate-to-evm",
    expectedOutput: EXPECTED,
    fees: [{ kind: "network", chain: "portaldot-v3-substrate", asset: "native", amount: 1_490_601_551_715n, basis: "estimate" }],
    retrievedAt: at,
    expiresAt: at + 60,
  };
  await recordQuotes(db, intent.intentId, [quote], at);
  // Identical requests (same signer, amount and destination) really do produce identical call bytes.
  const callHex = sharedCallHex ?? (`0x0603${(++callCounter).toString(16).padStart(8, "0")}` as Hex);
  await selectQuote(db, intent.intentId, quote.quoteId, at + 1, {
    planId: `plan-${crypto.randomUUID()}`,
    quoteId: quote.quoteId,
    kind: "substrate_call",
    chain: "portaldot-v3-substrate",
    signer: REQUESTER,
    callHex,
    destinationAccount: OTHER,
    estimatedFee: 1n,
    submitBefore: at + 60,
    createdAt: at + 1,
  });
  return { intent, intentHash, callHex };
}

/** Puts the planned extrinsic in block n and records the API-style SOURCE_SUBMITTED report. */
async function includeAndReport(intentId: Hex, callHex: Hex, n: bigint, success = true) {
  const txHash = hash32(n, "dd");
  chain.block(n).extrinsics.push({ index: 1, hash: txHash, callHex, signer: REQUESTER, success });
  await appendStatusEvent(db, intentId, {
    status: "SOURCE_SUBMITTED",
    at: NOW + 5,
    reason: "reported",
    evidence: {
      kind: "source_transaction",
      chain: "portaldot-v3-substrate",
      method: "substrate_block_extrinsic",
      txHash,
      blockHash: chain.block(n).hash,
      blockNumber: n,
      finalized: false,
      observedAt: NOW + 5,
    },
  });
  return txHash;
}

async function statuses(intentId: Hex): Promise<IntentStatus[]> {
  return (await loadIntent(db, intentId))?.history.map((e) => e.status) ?? [];
}

describe("event timestamps", () => {
  it("never stamps an event earlier than the latest one, even if the worker clock is behind", async () => {
    const { intent, callHex } = await awaitingIntent();
    await includeAndReport(intent.intentId, callHex, 95n); // reported at NOW + 5 by the web server
    chain.setDelta(RECIPIENT, 95n, 0n, EXPECTED);
    clock = NOW; // worker clock 5 seconds behind
    expect(await runPass(ctx())).toMatchObject({ settled: 1, errors: 0 });
    const history = (await loadIntent(db, intent.intentId))?.history ?? [];
    expect(history.at(-1)?.at).toBe(NOW + 5);
  });
});

describe("source confirmation and destination measurement", () => {
  it("settles a reported transfer once final and anchors the receipt", async () => {
    const { intent, callHex } = await awaitingIntent();
    await includeAndReport(intent.intentId, callHex, 95n);
    chain.setDelta(RECIPIENT, 95n, 5n, 5n + EXPECTED);

    const pass = await runPass(ctx());
    expect(pass).toMatchObject({ confirmed: 1, settled: 1, anchored: 1, errors: 0 });
    expect((await statuses(intent.intentId)).slice(-4)).toEqual(["SOURCE_SUBMITTED", "SOURCE_CONFIRMED", "DESTINATION_PENDING", "SETTLED"]);

    const settled = (await loadIntent(db, intent.intentId))?.history.at(-1);
    expect(settled?.verificationMode).toBe("destination_rpc_state");
    expect(settled?.evidence).toMatchObject({
      kind: "destination_state",
      method: "evm_balance_delta",
      amount: EXPECTED,
      blockNumber: 95n,
      finalized: true,
      details: { balanceBefore: "5", balanceAfter: (5n + EXPECTED).toString() },
    });

    expect(await getReceiptBatchProof(db, intent.intentId, (registry as FakeBatchRegistry).address)).toMatchObject({ leafCount: 1, proof: [] });
    expect(registry?.writes).toHaveLength(1);

    // Idempotent: nothing more happens on the next pass.
    expect(await runPass(ctx())).toMatchObject({ confirmed: 0, settled: 0, anchored: 0, errors: 0 });
    expect(registry?.writes).toHaveLength(1);
  });

  it("waits while the inclusion block is not finalized", async () => {
    const { intent, callHex } = await awaitingIntent();
    await includeAndReport(intent.intentId, callHex, 120n);
    await runPass(ctx());
    expect((await statuses(intent.intentId)).at(-1)).toBe("SOURCE_SUBMITTED");
  });

  /** The browser saw `reported`, but the finalized chain has a different block at its height. */
  function loseFork(n: bigint, keepExtrinsic: boolean): Hex {
    const reported = chain.block(n);
    const winner = { hash: hash32(n, "ff"), timestamp: reported.timestamp, extrinsics: keepExtrinsic ? reported.extrinsics : [] };
    chain.blocks.set(n, winner);
    return winner.hash;
  }

  it("settles when the block that won the fork holds the same extrinsic", async () => {
    const { intent, callHex } = await awaitingIntent();
    const txHash = await includeAndReport(intent.intentId, callHex, 95n);
    const reportedHash = chain.block(95n).hash;
    const winnerHash = loseFork(95n, true);
    chain.setDelta(RECIPIENT, 95n, 0n, EXPECTED);
    await runPass(ctx());
    const history = (await loadIntent(db, intent.intentId))?.history ?? [];
    expect(history.at(-1)?.status).toBe("SETTLED");
    const confirmed = history.find((e) => e.status === "SOURCE_CONFIRMED");
    expect(confirmed?.reason).toMatch(/lost a fork; the same extrinsic is in finalized block 95/);
    expect(confirmed?.evidence).toMatchObject({ txHash, blockHash: winnerHash, blockNumber: 95n, finalized: true });
    expect(confirmed?.evidence?.details?.reportedBlockHash).toBe(reportedHash);
  });

  it("follows an extrinsic that was included again a few blocks later", async () => {
    const { intent, callHex } = await awaitingIntent();
    const txHash = await includeAndReport(intent.intentId, callHex, 95n);
    loseFork(95n, false);
    chain.block(97n).extrinsics.push({ index: 1, hash: txHash, callHex, signer: REQUESTER, success: true });
    chain.setDelta(RECIPIENT, 97n, 0n, EXPECTED);
    await runPass(ctx());
    const history = (await loadIntent(db, intent.intentId))?.history ?? [];
    expect(history.at(-1)?.status).toBe("SETTLED");
    expect(history.find((e) => e.status === "SOURCE_CONFIRMED")?.evidence?.blockNumber).toBe(97n);
  });

  it("waits while the extrinsic could still appear in blocks that are not final", async () => {
    const { intent, callHex } = await awaitingIntent();
    await includeAndReport(intent.intentId, callHex, 95n);
    loseFork(95n, false); // finalized head is 100, the search window runs to 159
    await runPass(ctx());
    expect((await statuses(intent.intentId)).at(-1)).toBe("SOURCE_SUBMITTED");
  });

  it("flags a lost fork only once the whole window is final without the extrinsic", async () => {
    const { intent, callHex } = await awaitingIntent();
    await includeAndReport(intent.intentId, callHex, 95n);
    loseFork(95n, false);
    chain.finalized = 200n;
    await runPass(ctx());
    const last = (await loadIntent(db, intent.intentId))?.history.at(-1);
    expect(last?.status).toBe("NEEDS_REVIEW");
    expect(last?.reason).toMatch(/replaced on the finalized chain .* in no finalized block from 87 to 159/);
  });

  it("flags a short delivery and keeps the measurement", async () => {
    const { intent, callHex } = await awaitingIntent();
    await includeAndReport(intent.intentId, callHex, 95n);
    chain.setDelta(RECIPIENT, 95n, 0n, EXPECTED - 1n);
    await runPass(ctx());
    const last = (await loadIntent(db, intent.intentId))?.history.at(-1);
    expect(last?.status).toBe("NEEDS_REVIEW");
    expect(last?.evidence?.amount).toBe(EXPECTED - 1n);
    expect(registry?.writes).toEqual([]);
  });

  it("flags no balance change at a finalized block", async () => {
    const { intent, callHex } = await awaitingIntent();
    await includeAndReport(intent.intentId, callHex, 95n);
    await runPass(ctx());
    const last = (await loadIntent(db, intent.intentId))?.history.at(-1);
    expect(last?.status).toBe("NEEDS_REVIEW");
    expect(last?.reason).toMatch(/no balance increase/);
  });

  it("waits for the EVM RPC to index the block, and flags pruned state", async () => {
    const { intent, callHex } = await awaitingIntent();
    await includeAndReport(intent.intentId, callHex, 95n);
    chain.setDelta(RECIPIENT, 95n, 0n, EXPECTED);
    chain.evmIndexedTo = 94n;
    await runPass(ctx());
    expect((await statuses(intent.intentId)).at(-1)).toBe("DESTINATION_PENDING");

    chain.evmIndexedTo = 1_000n;
    chain.prunedBelow = 200n;
    await runPass(ctx());
    const last = (await loadIntent(db, intent.intentId))?.history.at(-1);
    expect(last?.status).toBe("NEEDS_REVIEW");
    expect(last?.reason).toMatch(/discarded EVM state/);
  });
});

describe("finalized block scanner", () => {
  it("finds an unreported transfer and carries it to SETTLED in one pass", async () => {
    const { intent, callHex } = await awaitingIntent();
    chain.block(97n).extrinsics.push({ index: 2, hash: hash32(97n, "dd"), callHex, signer: REQUESTER, success: true });
    chain.setDelta(RECIPIENT, 97n, 0n, EXPECTED);

    const pass = await runPass(ctx());
    expect(pass).toMatchObject({ found: 1, settled: 1, caughtUp: true, scannedTo: 100n });
    const history = (await loadIntent(db, intent.intentId))?.history ?? [];
    expect(history.map((e) => e.status).slice(-4)).toEqual(["SOURCE_SUBMITTED", "SOURCE_CONFIRMED", "DESTINATION_PENDING", "SETTLED"]);
    expect(history.find((e) => e.status === "SOURCE_SUBMITTED")?.evidence?.method).toBe("watcher_finalized_block_scan");
    expect(await getCursor(db, SOURCE_SCAN_CURSOR)).toBe(100n);
  });

  it("ignores the same call from another signer or from before the plan existed", async () => {
    const { intent, callHex } = await awaitingIntent();
    chain.block(96n).extrinsics.push({ index: 1, hash: hash32(96n, "d1"), callHex, signer: OTHER, success: true });
    chain.block(97n).timestamp = NOW - 3_600;
    chain.block(97n).extrinsics.push({ index: 1, hash: hash32(97n, "d2"), callHex, signer: REQUESTER, success: true });
    await runPass(ctx());
    expect((await statuses(intent.intentId)).at(-1)).toBe("AWAITING_SIGNATURE");
  });

  it("records a failed extrinsic as failed before source", async () => {
    const { intent, callHex } = await awaitingIntent();
    chain.block(98n).extrinsics.push({ index: 1, hash: hash32(98n, "dd"), callHex, signer: REQUESTER, success: false });
    await runPass(ctx());
    const last = (await loadIntent(db, intent.intentId))?.history.at(-1);
    expect(last?.status).toBe("FAILED_BEFORE_SOURCE");
    expect(last?.reason).toMatch(/InsufficientBalance/);
  });

  it("matches identical calls to identical intents one at a time, oldest first", async () => {
    const a = await awaitingIntent();
    const b = await awaitingIntent(undefined, a.callHex);
    chain.block(96n).extrinsics.push({ index: 1, hash: hash32(96n, "d1"), callHex: a.callHex, signer: REQUESTER, success: true });
    await runPass(ctx());
    expect((await statuses(a.intent.intentId)).at(-1)).not.toBe("AWAITING_SIGNATURE");
    expect((await statuses(b.intent.intentId)).at(-1)).toBe("AWAITING_SIGNATURE");

    // A second identical extrinsic later goes to the remaining intent.
    chain.finalized = 110n;
    chain.block(105n).extrinsics.push({ index: 1, hash: hash32(105n, "d2"), callHex: a.callHex, signer: REQUESTER, success: true });
    await runPass(ctx());
    const bSource = (await loadIntent(db, b.intent.intentId))?.history.find((e) => e.status === "SOURCE_SUBMITTED");
    expect(bSource?.evidence?.blockNumber).toBe(105n);
  });

  it("starts at the plan's window, limits blocks per pass, and never rewinds", async () => {
    await awaitingIntent(); // plan created at NOW + 1, block 101
    await runPass(ctx()); // cursor at finalized 100
    chain.finalized = 1_000n;
    expect(await runPass(ctx())).toMatchObject({ scannedTo: 150n, caughtUp: false }); // at most 50 blocks per pass
    chain.finalized = 120n; // a lagging node must not rewind progress
    await runPass(ctx());
    expect(await getCursor(db, SOURCE_SCAN_CURSOR)).toBe(150n);
  });

  it("jumps from an old cursor straight to the plan's window, located by block timestamps", async () => {
    await advanceCursor(db, SOURCE_SCAN_CURSOR, 10n);
    chain.finalized = 50_000n;
    clock = NOW + 40_000;
    for (let n = 20n; n < 60n; n++) chain.failReads.set(n, Infinity); // reading these would fail the pass
    await awaitingIntent(undefined, undefined, NOW + 30_000); // plan created at NOW + 30_001, block 30_101
    const pass = await runPass(ctx());
    // First block at or after the plan time minus 30 s of clock skew is 30_071, less a 10-block margin.
    expect(pass).toMatchObject({ errors: 0, scannedTo: 30_111n });
  });

  it("skips the gap after a stale plan's signing window has closed", async () => {
    await awaitingIntent(); // plan created at NOW + 1, block 101, lifetime 1800 s
    await runPass(ctx()); // cursor at finalized 100
    clock = NOW + 10_000; // window closed long ago
    chain.finalized = 5_000n;
    // The window ends at the first block at or after NOW + 1 + 1_800 + 30 (block 1_931), plus 10.
    for (let i = 0; i < 200 && !(await runPass(ctx())).caughtUp; i++);
    expect(await getCursor(db, SOURCE_SCAN_CURSOR)).toBe(5_000n);
    expect([...chain.scanned].filter((n) => n > 1_941n && n < 5_000n)).toEqual([]); // the gap is never scanned
  });
});

describe("slow or failing RPC", () => {
  it("retries a block that times out and still finds the transfer in the same pass", async () => {
    const { intent, callHex } = await awaitingIntent();
    chain.block(95n).extrinsics.push({ index: 1, hash: hash32(95n, "dd"), callHex, signer: REQUESTER, success: true });
    chain.setDelta(RECIPIENT, 95n, 0n, EXPECTED);
    chain.failReads.set(95n, 2); // two timeouts, then it answers
    const pass = await runPass(ctx());
    expect(pass).toMatchObject({ found: 1, settled: 1, caughtUp: true, errors: 0 });
    expect((await statuses(intent.intentId)).at(-1)).toBe("SETTLED");
  });

  it("keeps progress from finished chunks when a later block keeps failing", async () => {
    await awaitingIntent();
    await runPass(ctx()); // cursor at finalized 100
    chain.finalized = 130n;
    chain.failReads.set(125n, Infinity);
    const pass = await runPass(ctx());
    expect(pass).toMatchObject({ caughtUp: false, scannedTo: 124n, errors: 1 }); // last finished 4-block chunk
    expect(await getCursor(db, SOURCE_SCAN_CURSOR)).toBe(124n);

    chain.failReads.delete(125n); // the node recovers
    expect(await runPass(ctx())).toMatchObject({ caughtUp: true, scannedTo: 130n, errors: 0 });
  });
});

describe("expiry", () => {
  it("expires quoted intents after the deadline", async () => {
    const { intent } = await awaitingIntent();
    await appendStatusEvent(db, intent.intentId, { status: "QUOTED", at: NOW + 2, reason: "re-quoted" });
    clock = NOW + 600;
    await runPass(ctx());
    expect((await statuses(intent.intentId)).at(-1)).toBe("EXPIRED");
  });

  it("keeps awaiting-signature intents until the signing lifetime is scanned", async () => {
    const { intent } = await awaitingIntent();
    clock = NOW + 600; // deadline passed, but a signed tx could still land
    await runPass(ctx());
    expect((await statuses(intent.intentId)).at(-1)).toBe("AWAITING_SIGNATURE");

    clock = NOW + 1 + 1_800; // lifetime elapsed in time and, below, in blocks (1,800 s = 300 blocks)
    chain.finalized = 400n;
    for (let i = 0; i < 20 && (await statuses(intent.intentId)).at(-1) === "AWAITING_SIGNATURE"; i++) await runPass(ctx());
    const last = (await loadIntent(db, intent.intentId))?.history.at(-1);
    expect(last?.status).toBe("EXPIRED");
    expect(last?.reason).toMatch(/no matching signed transaction/);
  });

  it("does not expire an awaiting-signature intent while the chain is stalled", async () => {
    const { intent } = await awaitingIntent(); // plan created at NOW + 1; the chain stops at block 100
    clock = NOW + 10_000; // hours of wall-clock time, but no new blocks, so a signed tx is still valid
    await runPass(ctx());
    expect((await statuses(intent.intentId)).at(-1)).toBe("AWAITING_SIGNATURE");
  });

  it("does not expire awaiting-signature intents while the scanner is behind", async () => {
    const { intent } = await awaitingIntent();
    await runPass(ctx()); // cursor at finalized 100
    chain.finalized = 1_000n; // 900 blocks still to scan
    clock = NOW + 3_600;
    const pass = await runPass(ctx());
    expect(pass.caughtUp).toBe(false);
    expect((await statuses(intent.intentId)).at(-1)).toBe("AWAITING_SIGNATURE");
  });
});

describe("batch anchoring", () => {
  /** Settles an intent through the real watcher pass, in block n (distinct n for each, two apart). */
  async function settledIntent(n = 95n) {
    const created = await awaitingIntent();
    await includeAndReport(created.intent.intentId, created.callHex, n);
    chain.setDelta(RECIPIENT, n, 0n, EXPECTED);
    expect(await runPass(ctx())).toMatchObject({ settled: 1 });
    return created;
  }

  async function receiptHashOf(intentId: Hex): Promise<Hex> {
    const stored = await loadIntent(db, intentId);
    const quote = (await listQuotes(db, intentId)).find((q) => q.quoteId === stored?.selectedQuoteId);
    if (!stored || !quote) throw new Error("not settled");
    return hashReceipt(buildReceipt({ intent: stored.intent, intentHash: stored.intentHash, quote, history: stored.history }));
  }

  const fake = () => registry as FakeBatchRegistry;
  const proofOf = (intentId: Hex) => getReceiptBatchProof(db, intentId, new FakeBatchRegistry().address);

  it("is skipped when the registry is not configured", async () => {
    registry = null;
    const { intent } = await settledIntent();
    expect(await proofOf(intent.intentId)).toBeNull();
    expect(await listUnconfirmedReceiptBatches(db, new FakeBatchRegistry().address)).toEqual([]);
  });

  it("waits for a full batch, then anchors every receipt with one write and a proof each", async () => {
    batching = { size: 3, maxWaitSeconds: 1_800, maxLeaves: 256 };
    const a = await settledIntent(91n);
    const b = await settledIntent(93n);
    expect(fake().writes).toEqual([]);
    expect(await proofOf(a.intent.intentId)).toBeNull();

    const c = await settledIntent(95n); // the third waiting receipt fills the batch in the same pass
    expect(fake().writes).toHaveLength(1);
    const root = fake().writes[0] as Hex;
    for (const { intent, intentHash } of [a, b, c]) {
      const proof = await proofOf(intent.intentId);
      const leaf = batchLeaf(intentHash, await receiptHashOf(intent.intentId));
      expect(proof).toMatchObject({ root, leafCount: 3, leafHash: leaf, txHash: fake().batches.get(root)?.txHash });
      expect(verifyMerkleProof(leaf, proof?.proof ?? [], root)).toBe(true);
    }
    expect(await runPass(ctx())).toMatchObject({ anchored: 0, errors: 0 });
    expect(fake().writes).toHaveLength(1);
  });

  it("anchors verified bridge transfers in the same batch as receipts", async () => {
    batching = { size: 2, maxWaitSeconds: 1_800, maxLeaves: 256 };
    const facts = { deposit: { id: "832820-1", amount: "3300000000000000" }, payout: null };
    const checkHash = hashCanonical(BRIDGE_CHECK_DOMAIN, facts);
    await recordBridgeCheck(db, { checkHash, depositId: "832820-1", payoutTxHash: hash32(9n, "ee"), facts, checkedAt: clock });
    expect(await runPass(ctx())).toMatchObject({ anchored: 0, errors: 0 }); // one leaf waiting, below the batch size

    const { intent } = await settledIntent();
    expect(fake().writes).toHaveLength(1);
    const root = fake().writes[0] as Hex;
    expect(await proofOf(intent.intentId)).toMatchObject({ root, leafCount: 2 });
    const bridge = await getBridgeCheckAnchor(db, checkHash, fake().address);
    expect(bridge).toMatchObject({ status: "anchored", root, leafCount: 2, leafHash: bridgeCheckLeaf(checkHash) });
    expect(bridge?.status === "anchored" && verifyMerkleProof(bridge.leafHash, bridge.proof, root)).toBe(true);
  });

  it("writes a smaller batch once the oldest receipt has waited the maximum time", async () => {
    batching = { size: 10, maxWaitSeconds: 600, maxLeaves: 256 };
    const { intent } = await settledIntent();
    const settledAt = (await loadIntent(db, intent.intentId))?.history.at(-1)?.at ?? 0;

    clock = settledAt + 599;
    expect(await runPass(ctx())).toMatchObject({ anchored: 0, errors: 0 });
    expect(fake().writes).toEqual([]);

    clock = settledAt + 600;
    expect(await runPass(ctx())).toMatchObject({ anchored: 1, errors: 0 });
    expect(await proofOf(intent.intentId)).toMatchObject({ leafCount: 1 });
  });

  it("caps a batch at the maximum size and leaves the rest for the next one", async () => {
    const configured = fake();
    registry = null; // let all three settle before anchoring starts
    const settled = [await settledIntent(91n), await settledIntent(93n), await settledIntent(95n)];
    registry = configured;
    batching = { size: 2, maxWaitSeconds: 1_800, maxLeaves: 2 };
    expect(await runPass(ctx())).toMatchObject({ anchored: 2, errors: 0 });
    const proofs = await Promise.all(settled.map((s) => proofOf(s.intent.intentId)));
    // Oldest settled first: the third waits for the next batch.
    expect(proofs.map((p) => p?.leafCount ?? null)).toEqual([2, 2, null]);

    clock += 1_800;
    expect(await runPass(ctx())).toMatchObject({ anchored: 1, errors: 0 });
    expect(fake().writes).toHaveLength(2);
    expect((await proofOf(settled[2]?.intent.intentId as Hex))?.root).toBe(fake().writes[1]);
  });

  it("recovers a batch that was mined before a crash without writing it again", async () => {
    fake().crash = "after_mining";
    const { intent } = await settledIntent();
    expect(fake().writes).toHaveLength(1);
    expect(await proofOf(intent.intentId)).toBeNull(); // mined, but the worker died before recording it

    expect(await runPass(ctx())).toMatchObject({ anchored: 1, errors: 0 });
    expect(fake().writes).toHaveLength(1);
    const root = fake().writes[0] as Hex;
    expect(await proofOf(intent.intentId)).toMatchObject({ root, txHash: fake().batches.get(root)?.txHash });
  });

  it("sends a batch planned before a crash with its original leaves, even after more receipts settle", async () => {
    fake().crash = "before_sending";
    const first = await settledIntent(93n);
    expect(await listUnconfirmedReceiptBatches(db, fake().address)).toHaveLength(1);
    expect(fake().writes).toEqual([]);

    // Another receipt settles before the worker comes back; it must not change the planned root.
    const second = await settledIntent(95n);
    const planned = await proofOf(first.intent.intentId);
    expect(planned).toMatchObject({ leafCount: 1 });
    expect(await proofOf(second.intent.intentId)).toMatchObject({ leafCount: 1 });
    expect(fake().writes).toEqual([planned?.root, (await proofOf(second.intent.intentId))?.root]);
    expect(await listUnconfirmedReceiptBatches(db, fake().address)).toEqual([]);
  });

  it("refuses to adopt an on-chain batch that disagrees with the stored plan", async () => {
    fake().crash = "before_sending";
    const { intent } = await settledIntent();
    const [planned] = await listUnconfirmedReceiptBatches(db, fake().address);
    fake().batches.set(planned?.root as Hex, { txHash: hash32(1n, "cc"), blockNumber: 501n, recordedAt: BigInt(clock), leafCount: 7 });
    expect(await runPass(ctx())).toMatchObject({ anchored: 0, errors: 1 });
    expect(await proofOf(intent.intentId)).toBeNull();
  });

  it("never re-anchors a receipt already anchored in IntentRegistry", async () => {
    batching = { size: 2, maxWaitSeconds: 1_800, maxLeaves: 256 };
    const legacy = await settledIntent(93n);
    await recordAnchor(db, {
      intentId: legacy.intent.intentId,
      step: "receipt",
      valueHash: await receiptHashOf(legacy.intent.intentId),
      contractAddress: "0xfcfc36e3ea951640d1e495a1e671d66c75eb5123",
      chainId: 420420777,
      txHash: hash32(1n, "ab"),
      blockNumber: 136956n,
    });
    const fresh = await settledIntent(95n);
    expect(fake().writes).toEqual([]); // only one receipt is waiting, below the batch size
    clock += 1_800;
    expect(await runPass(ctx())).toMatchObject({ anchored: 1, errors: 0 });
    expect(await proofOf(legacy.intent.intentId)).toBeNull();
    expect(await proofOf(fresh.intent.intentId)).toMatchObject({ leafCount: 1 });
  });

  it("pauses anchoring with one warning when the relayer cannot pay, then resumes once funded", async () => {
    fake().shortOfFunds = true;
    const warnings: { message: string; fields: unknown }[] = [];
    const log: Logger = { ...silent, warn: (message, fields) => void warnings.push({ message, fields }) };
    const created = await awaitingIntent();
    await includeAndReport(created.intent.intentId, created.callHex, 95n);
    chain.setDelta(RECIPIENT, 95n, 0n, EXPECTED);

    expect(await runPass({ ...ctx(), log })).toMatchObject({ settled: 1, anchored: 0, errors: 0 });
    expect(warnings.map((w) => w.message)).toEqual(["relayer needs funding; anchoring paused"]);
    expect(warnings[0]?.fields).toMatchObject({ waiting: 1, retryInSeconds: 600 });
    expect(fake().refused).toBe(1);
    // The plan is kept, so the write that resumes is the same root.
    expect(await listUnconfirmedReceiptBatches(db, fake().address)).toHaveLength(1);

    await runPass({ ...ctx(), log }); // still paused: no write attempted, no new warning
    expect(fake().refused).toBe(1);
    expect(warnings).toHaveLength(1);

    fake().shortOfFunds = false; // the operator funds the relayer
    clock += 601;
    expect(await runPass({ ...ctx(), log })).toMatchObject({ anchored: 1, errors: 0 });
    expect(await proofOf(created.intent.intentId)).toMatchObject({ leafCount: 1 });
  });
});
