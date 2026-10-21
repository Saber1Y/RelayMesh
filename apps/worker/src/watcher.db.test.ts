import { sql } from "drizzle-orm";
import type { Hex } from "viem";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { BlockExtrinsic, BlockRef, EvmBalanceRead, ExtrinsicCheck, ExtrinsicVerification, V3ChainReader } from "@relaymesh/chains";
import { createIntent, hashRequest, type IntentStatus, type Quote } from "@relaymesh/core";
import {
  appendStatusEvent,
  connectDb,
  getCursor,
  insertIntent,
  listAnchors,
  loadIntent,
  recordQuotes,
  selectQuote,
} from "@relaymesh/db";
import type { Logger } from "./log";
import { ZERO_ADDRESS, ZERO_HASH, type MinedTx, type RegistryClient, type RegistryState } from "./registry";
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

  block(n: bigint): FakeBlock {
    let b = this.blocks.get(n);
    if (!b) {
      b = { hash: hash32(n), timestamp: NOW, extrinsics: [] };
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
    return [...this.blocks.values()].find((b) => b.hash === hash)?.extrinsics ?? [];
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

class FakeRegistry implements RegistryClient {
  address = "0x00000000000000000000000000000000000000aa" as Hex;
  chainId = 420420777;
  recorder = "0x00000000000000000000000000000000000000bb" as Hex;
  state = new Map<Hex, RegistryState>();
  writes: string[] = [];
  events = new Map<string, MinedTx>();
  private block = 500n;

  async read(intentHash: Hex) {
    return this.state.get(intentHash) ?? { recorder: ZERO_ADDRESS, routeId: ZERO_HASH, receiptHash: ZERO_HASH };
  }
  async recordIntent(intentHash: Hex, routeId: Hex) {
    this.writes.push(`intent:${intentHash}`);
    this.state.set(intentHash, { recorder: this.recorder, routeId, receiptHash: ZERO_HASH });
    return this.mine(`IntentRecorded:${intentHash}`);
  }
  async recordReceipt(intentHash: Hex, receiptHash: Hex) {
    this.writes.push(`receipt:${intentHash}`);
    const s = await this.read(intentHash);
    this.state.set(intentHash, { ...s, receiptHash });
    return this.mine(`ReceiptRecorded:${intentHash}`);
  }
  async findEvent(kind: string, intentHash: Hex) {
    return this.events.get(`${kind}:${intentHash}`) ?? null;
  }
  private mine(key: string): MinedTx {
    const tx = { txHash: hash32(++this.block, "cc"), blockNumber: this.block };
    this.events.set(key, tx);
    return tx;
  }
}

const silent: Logger = { info: () => {}, warn: () => {}, error: (m, f) => process.env.DEBUG_WATCHER && console.error(m, f) };

const { db, close } = connectDb(process.env.TEST_DATABASE_URL as string, { max: 4 });
afterAll(() => close());

let chain: FakeChain;
let registry: FakeRegistry | null;
let clock: number;
let callCounter = 0;

function ctx(): WatcherContext {
  return {
    db,
    chain,
    registry,
    log: silent,
    now: () => clock,
    config: { scanBackfillBlocks: 10, maxBlocksPerPass: 50, signedTxLifetimeSeconds: 1_800, rpcRetryDelayMs: 0 },
  };
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE watcher_cursors, registry_anchors, execution_plans, status_events, idempotency_records, quotes, intents`);
  chain = new FakeChain();
  registry = new FakeRegistry();
  clock = NOW + 30; // after the reported submission at NOW + 5, as in real use
});

/** Creates an intent and drives it to AWAITING_SIGNATURE with a stored plan, through the real store functions. */
async function awaitingIntent(amount = "100000000000000", sharedCallHex?: Hex) {
  const body = {
    requester: REQUESTER,
    source: { chain: "portaldot-v3-substrate", asset: "native", amount },
    destination: { chain: "portaldot-v3-evm", asset: "native", recipient: RECIPIENT },
    constraints: { deadline: NOW + 600 },
  };
  const { intent, intentHash } = createIntent(body, { now: NOW });
  await insertIntent(db, { intent, intentHash, idempotencyKey: `test-${crypto.randomUUID()}`, requestHash: hashRequest(body) });
  const quote: Quote = {
    quoteId: `q-${crypto.randomUUID()}`,
    intentId: intent.intentId,
    provider: "portaldot-v3-native",
    routeId: "v3-substrate-to-evm",
    expectedOutput: EXPECTED,
    fees: [{ kind: "network", chain: "portaldot-v3-substrate", asset: "native", amount: 1_490_601_551_715n, basis: "estimate" }],
    retrievedAt: NOW,
    expiresAt: NOW + 60,
  };
  await recordQuotes(db, intent.intentId, [quote], NOW);
  // Identical requests (same signer, amount and destination) really do produce identical call bytes.
  const callHex = sharedCallHex ?? (`0x0603${(++callCounter).toString(16).padStart(8, "0")}` as Hex);
  await selectQuote(db, intent.intentId, quote.quoteId, NOW + 1, {
    planId: `plan-${crypto.randomUUID()}`,
    quoteId: quote.quoteId,
    kind: "substrate_call",
    chain: "portaldot-v3-substrate",
    signer: REQUESTER,
    callHex,
    destinationAccount: OTHER,
    estimatedFee: 1n,
    submitBefore: NOW + 60,
    createdAt: NOW + 1,
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

    const anchors = await listAnchors(db, intent.intentId);
    expect(anchors.map((a) => a.step)).toEqual(["intent", "receipt"]);
    expect(registry?.writes).toHaveLength(2);

    // Idempotent: nothing more happens on the next pass.
    expect(await runPass(ctx())).toMatchObject({ confirmed: 0, settled: 0, anchored: 0, errors: 0 });
    expect(registry?.writes).toHaveLength(2);
  });

  it("waits while the inclusion block is not finalized", async () => {
    const { intent, callHex } = await awaitingIntent();
    await includeAndReport(intent.intentId, callHex, 120n);
    await runPass(ctx());
    expect((await statuses(intent.intentId)).at(-1)).toBe("SOURCE_SUBMITTED");
  });

  it("flags a reported block that lost a fork", async () => {
    const { intent, callHex } = await awaitingIntent();
    await includeAndReport(intent.intentId, callHex, 95n);
    chain.block(95n).hash = hash32(95n, "ff"); // the finalized chain has a different block at 95
    await runPass(ctx());
    const last = (await loadIntent(db, intent.intentId))?.history.at(-1);
    expect(last?.status).toBe("NEEDS_REVIEW");
    expect(last?.reason).toMatch(/replaced on the finalized chain/);
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

  it("never moves the cursor backwards and limits blocks per pass", async () => {
    await awaitingIntent();
    await runPass(ctx()); // cursor at finalized 100
    chain.finalized = 1_000n;
    expect(await runPass(ctx())).toMatchObject({ scannedTo: 150n, caughtUp: false }); // at most 50 blocks per pass
    chain.finalized = 120n; // a lagging node must not rewind progress
    await runPass(ctx());
    expect(await getCursor(db, SOURCE_SCAN_CURSOR)).toBe(150n);
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
    expect(pass).toMatchObject({ caughtUp: false, scannedTo: 120n, errors: 1 });
    expect(await getCursor(db, SOURCE_SCAN_CURSOR)).toBe(120n);

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

    clock = NOW + 1 + 1_800; // lifetime elapsed and the scanner is caught up
    await runPass(ctx());
    const last = (await loadIntent(db, intent.intentId))?.history.at(-1);
    expect(last?.status).toBe("EXPIRED");
    expect(last?.reason).toMatch(/no matching signed transaction/);
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

describe("registry anchoring", () => {
  async function settledIntent() {
    const created = await awaitingIntent();
    await includeAndReport(created.intent.intentId, created.callHex, 95n);
    chain.setDelta(RECIPIENT, 95n, 0n, EXPECTED);
    return created;
  }

  it("is skipped when the registry is not configured", async () => {
    registry = null;
    const { intent } = await settledIntent();
    expect(await runPass(ctx())).toMatchObject({ settled: 1, anchored: 0, errors: 0 });
    expect(await listAnchors(db, intent.intentId)).toEqual([]);
  });

  it("recovers an intent write that was mined before a crash", async () => {
    const { intent, intentHash } = await settledIntent();
    const fake = registry as FakeRegistry;
    await fake.recordIntent(intentHash, ZERO_HASH); // mined earlier, but never recorded in the database
    fake.writes = [];
    await runPass(ctx());
    expect(fake.writes).toEqual([`receipt:${intentHash}`]);
    expect((await listAnchors(db, intent.intentId)).map((a) => a.step)).toEqual(["intent", "receipt"]);
  });

  it("refuses to anchor when another account recorded the intent hash", async () => {
    const { intent, intentHash } = await settledIntent();
    const fake = registry as FakeRegistry;
    fake.state.set(intentHash, { recorder: "0x00000000000000000000000000000000000000ff", routeId: ZERO_HASH, receiptHash: ZERO_HASH });
    const pass = await runPass(ctx());
    expect(pass).toMatchObject({ settled: 1, anchored: 0, errors: 1 });
    expect(fake.writes).toEqual([]);
    expect(await listAnchors(db, intent.intentId)).toEqual([]);
  });
});
