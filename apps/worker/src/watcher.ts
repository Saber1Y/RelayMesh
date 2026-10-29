import { u8aEq } from "@polkadot/util";
import { decodeAddress } from "@polkadot/util-crypto";
import type { Hex } from "viem";
import type { BlockRef, V3ChainReader } from "@relaymesh/chains";
import { assessSettlement, batchLeaf, buildMerkleTree, buildReceipt, hashReceipt, merkleProof, type Evidence, type Quote, type StatusEvent } from "@relaymesh/core";
import {
  advanceCursor,
  appendStatusEvent,
  getCursor,
  listExecutionPlans,
  listIntentIdsByStatus,
  listPendingReceiptAnchors,
  listQuotes,
  listUnconfirmedReceiptBatches,
  loadIntent,
  planReceiptBatch,
  recordReceiptBatchAnchor,
  type Db,
  type ReceiptBatchLeaf,
  type StoredIntent,
  type StoredReceiptBatch,
} from "@relaymesh/db";
import type { Logger } from "./log";
import { RelayerFundsError, type BatchRegistryClient, type MinedTx } from "./registry";

export const SOURCE_SCAN_CURSOR = "source-scan";
/** Extra blocks added on both sides of every scan range. */
const SCAN_WINDOW_MARGIN_BLOCKS = 10;
/** Blocks fetched in parallel while scanning. Kept low: the public V3 node times out under bursts. */
const SCAN_CONCURRENCY = 4n;
/**
 * Where to look for an extrinsic whose reported block lost a fork. polkadot.js signs with a 64-block
 * mortal era by default, so it cannot be included later than that; a fork rarely starts more than a
 * few blocks back.
 */
const FORK_SEARCH_AFTER_BLOCKS = 64n;
/** V3's target block time, for turning the signing lifetime into a number of blocks. */
const TARGET_BLOCK_SECONDS = 6;
/** How long anchoring waits after finding the relayer unable to pay, before checking again. */
const ANCHOR_FUNDS_RETRY_SECONDS = 600;
const FORK_SEARCH_BEFORE_BLOCKS = 8n;
/** Plans issued slightly after the block's own clock still count; validator clocks drift a little. */
const CLOCK_SKEW_SECONDS = 30;

export interface WatcherContext {
  db: Db;
  chain: V3ChainReader;
  registry: BatchRegistryClient | null;
  log: Logger;
  now(): number;
  config: {
    scanBackfillBlocks: number;
    maxBlocksPerPass: number;
    signedTxLifetimeSeconds: number;
    /** When to write a receipt batch: `size` receipts waiting, or the oldest waiting `maxWaitSeconds`. */
    batching: { size: number; maxWaitSeconds: number; maxLeaves: number };
    /** Base delay between retries of a failed block read; doubles each attempt. Defaults to 1000ms. */
    rpcRetryDelayMs?: number;
  };
}

export interface PassSummary {
  finalized: bigint;
  scannedTo: bigint;
  caughtUp: boolean;
  found: number;
  confirmed: number;
  settled: number;
  flagged: number;
  expired: number;
  /** Receipts anchored this pass, counted per intent, not per batch. */
  anchored: number;
  errors: number;
}

/** Attempts per block read before the pass gives up on that block (the next pass resumes from the cursor). */
const BLOCK_READ_ATTEMPTS = 3;

async function withRetry<T>(ctx: WatcherContext, what: string, fn: () => Promise<T>): Promise<T> {
  const base = ctx.config.rpcRetryDelayMs ?? 1_000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= BLOCK_READ_ATTEMPTS) throw error;
      ctx.log.warn("retrying chain read", { what, attempt, error });
      await new Promise((r) => setTimeout(r, base * 2 ** (attempt - 1)));
    }
  }
}

function sameAccount(a: string, b: string): boolean {
  try {
    return u8aEq(decodeAddress(a), decodeAddress(b));
  } catch {
    return false;
  }
}

/**
 * Event time for a new status. Status times must not go backwards, and the web server and worker may
 * run on machines with slightly different clocks, so never stamp earlier than the latest event.
 */
function stamp(ctx: WatcherContext, stored: StoredIntent): number {
  return Math.max(ctx.now(), stored.history.at(-1)?.at ?? 0);
}

function latestEvidence(history: StatusEvent[], kind: Evidence["kind"]): Evidence | undefined {
  return [...history].reverse().find((e) => e.evidence?.kind === kind)?.evidence;
}

async function selectedQuote(ctx: WatcherContext, stored: StoredIntent): Promise<Quote | undefined> {
  return (await listQuotes(ctx.db, stored.intent.intentId)).find((q) => q.quoteId === stored.selectedQuoteId);
}

/** Runs one stage per intent, isolating failures so one bad intent never blocks the rest. */
async function eachIntent(ctx: WatcherContext, ids: Hex[], stage: string, fn: (id: Hex) => Promise<void>): Promise<number> {
  let errors = 0;
  for (const id of ids) {
    try {
      await fn(id);
    } catch (error) {
      errors++;
      ctx.log.error(`${stage} failed`, { intentId: id, error });
    }
  }
  return errors;
}

/** Merges block ranges into sorted, non-overlapping ones; touching ranges are joined. */
export function mergeRanges(ranges: { start: bigint; end: bigint }[]): { start: bigint; end: bigint }[] {
  const sorted = [...ranges].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  const merged: { start: bigint; end: bigint }[] = [];
  for (const r of sorted) {
    const last = merged.at(-1);
    if (last && r.start <= last.end + 1n) last.end = r.end > last.end ? r.end : last.end;
    else merged.push({ ...r });
  }
  return merged;
}

/**
 * First block whose timestamp is at or after `t`, or `head + 1` if none is yet. Block times only
 * increase. The lower bound is found by stepping back from the head in doubling strides, so a recent
 * time (the usual case: a pending plan) never reads far back; old blocks can be slow or unavailable on
 * a public node. Then it interpolates on timestamps (blocks are regular, so a guess lands close) and
 * falls back to bisection whenever a guess fails to halve the interval, keeping the reads O(log n).
 */
export async function firstBlockAtOrAfter(t: number, head: bigint, timeOf: (n: bigint) => Promise<number>): Promise<bigint> {
  let hi = head;
  let tHi = await timeOf(hi);
  if (tHi < t) return head + 1n;
  // Block 0 (genesis) carries no timestamp, so block 1 is the floor.
  let stride = 64n;
  let lo = hi > stride ? hi - stride : 1n;
  let tLo = await timeOf(lo);
  while (tLo >= t && lo > 1n) {
    [hi, tHi] = [lo, tLo];
    stride *= 2n;
    lo = hi > stride ? hi - stride : 1n;
    tLo = await timeOf(lo);
  }
  if (tLo >= t || hi <= lo) return lo;
  // Invariant: timeOf(lo) < t <= timeOf(hi).
  let bisect = false;
  while (hi - lo > 1n) {
    const width = hi - lo;
    let mid = !bisect && tHi > tLo ? lo + (BigInt(t - tLo) * width) / BigInt(tHi - tLo) : lo + width / 2n;
    if (mid <= lo) mid = lo + 1n;
    if (mid >= hi) mid = hi - 1n;
    const tMid = await timeOf(mid);
    if (tMid < t) [lo, tLo] = [mid, tMid];
    else [hi, tHi] = [mid, tMid];
    bisect = (hi - lo) * 2n > width;
  }
  return hi;
}

// Heights found for plan times, per chain. Plans never change, so each is looked up once per process.
const heightCache = new WeakMap<V3ChainReader, Map<number, bigint>>();

/** Height of the first block at or after `t`, from on-chain block timestamps. */
async function heightAtTime(ctx: WatcherContext, t: number, finalized: BlockRef): Promise<bigint> {
  let cache = heightCache.get(ctx.chain);
  if (!cache) heightCache.set(ctx.chain, (cache = new Map()));
  const cached = cache.get(t);
  if (cached !== undefined) return cached;
  const height = await firstBlockAtOrAfter(t, finalized.number, (n) =>
    withRetry(ctx, `timestamp of block ${n}`, async () => {
      const hash = n === finalized.number ? finalized.hash : await ctx.chain.canonicalHash(n);
      if (!hash) throw new Error(`Node has no canonical block at finalized height ${n}`);
      return ctx.chain.blockTimestamp(hash);
    }),
  );
  // Only a block that already exists is final; "not yet" must be asked again later.
  if (height <= finalized.number) cache.set(t, height);
  return height;
}

/**
 * Blocks where a plan's extrinsic could have landed: from its creation to the end of its signing
 * lifetime, located by block timestamps, widened by the clock-skew allowance and a small margin.
 * A window that has not closed yet runs to the finalized head.
 */
async function planWindow(ctx: WatcherContext, createdAt: number, finalized: BlockRef): Promise<{ start: bigint; end: bigint }> {
  const margin = BigInt(SCAN_WINDOW_MARGIN_BLOCKS);
  const first = await heightAtTime(ctx, createdAt - CLOCK_SKEW_SECONDS, finalized);
  const last = await heightAtTime(ctx, createdAt + ctx.config.signedTxLifetimeSeconds + CLOCK_SKEW_SECONDS, finalized);
  const start = first > margin ? first - margin : 0n;
  const end = last + margin < finalized.number ? last + margin : finalized.number;
  return { start, end };
}

/**
 * Scans finalized blocks for extrinsics that are exactly a stored plan's call, signed by the intent's
 * requester. This finds transfers even when the browser never reported them, so nothing depends on
 * client reports.
 */
async function scanForPlannedExtrinsics(ctx: WatcherContext, finalized: BlockRef, summary: PassSummary): Promise<void> {
  // callHex -> candidate intents, oldest plan first, so identical requests are matched in order.
  const watch = new Map<Hex, { intentId: Hex; signer: string; planCreatedAt: number }[]>();
  const planTimes: number[] = [];
  for (const intentId of await listIntentIdsByStatus(ctx.db, ["AWAITING_SIGNATURE"], 500)) {
    const stored = await loadIntent(ctx.db, intentId);
    if (!stored) continue;
    for (const plan of await listExecutionPlans(ctx.db, intentId)) {
      if (plan.quoteId !== stored.selectedQuoteId) continue;
      const list = watch.get(plan.callHex) ?? [];
      list.push({ intentId, signer: stored.intent.requester, planCreatedAt: plan.createdAt });
      watch.set(plan.callHex, list);
      planTimes.push(plan.createdAt);
    }
  }
  for (const list of watch.values()) list.sort((a, b) => a.planCreatedAt - b.planCreatedAt);

  // A planned extrinsic can only land between its plan's creation and the end of its signing
  // lifetime, so only those block ranges are scanned; gaps between them are skipped. This keeps a
  // stale cursor from forcing a crawl through thousands of irrelevant blocks on a slow node.
  const cursor = (await getCursor(ctx.db, SOURCE_SCAN_CURSOR)) ?? finalized.number - BigInt(ctx.config.scanBackfillBlocks);
  const windows: { start: bigint; end: bigint }[] = [];
  for (const t of new Set(planTimes)) windows.push(await planWindow(ctx, t, finalized));
  const ranges = mergeRanges(windows);
  let start = cursor;
  let rangeEnd = finalized.number;
  const current = ranges.find((r) => r.end > cursor);
  if (!current) {
    start = cursor > finalized.number ? cursor : finalized.number;
  } else {
    if (current.start > cursor) start = current.start;
    rangeEnd = current.end;
  }
  const limit = start + BigInt(ctx.config.maxBlocksPerPass);
  const end = [finalized.number, rangeEnd, limit].reduce((a, b) => (b < a ? b : a));
  summary.scannedTo = start;

  const matched = new Set<Hex>();
  // Fetch blocks concurrently (each costs a couple of RPC round trips), but match them strictly in order.
  for (let chunkStart = start + 1n; chunkStart <= end && watch.size > 0; chunkStart += SCAN_CONCURRENCY) {
    const numbers: bigint[] = [];
    for (let n = chunkStart; n <= end && n < chunkStart + SCAN_CONCURRENCY; n++) numbers.push(n);
    const blocks = await Promise.all(
      numbers.map((n) =>
        withRetry(ctx, `block ${n}`, async () => {
          const hash = await ctx.chain.canonicalHash(n);
          if (!hash) throw new Error(`Node has no canonical block at finalized height ${n}`);
          return { number: n, hash, extrinsics: await ctx.chain.blockExtrinsics(hash) };
        }),
      ),
    );

    for (const block of blocks) {
      let timestamp: number | undefined;
      for (const ext of block.extrinsics) {
        const candidates = ext.signer ? watch.get(ext.callHex) : undefined;
        if (!candidates || !ext.signer) continue;
        timestamp ??= await ctx.chain.blockTimestamp(block.hash);
        const blockTime = timestamp;
        const candidate = candidates.find(
          (c) => !matched.has(c.intentId) && sameAccount(ext.signer as string, c.signer) && blockTime + CLOCK_SKEW_SECONDS >= c.planCreatedAt,
        );
        if (!candidate) continue;
        matched.add(candidate.intentId);
        await recordScannedSource(ctx, candidate.intentId, { number: block.number, hash: block.hash }, ext.hash, ext.callHex);
        summary.found++;
      }
    }
    // Keep finished work even if a later chunk fails: the next pass resumes after this chunk.
    const chunkEnd = numbers.at(-1) as bigint;
    await advanceCursor(ctx.db, SOURCE_SCAN_CURSOR, chunkEnd);
    summary.scannedTo = chunkEnd;
  }
  await advanceCursor(ctx.db, SOURCE_SCAN_CURSOR, end);
  summary.scannedTo = end;
  summary.caughtUp = end === finalized.number;
}

async function recordScannedSource(ctx: WatcherContext, intentId: Hex, block: BlockRef, txHash: Hex, callHex: Hex): Promise<void> {
  const stored = await loadIntent(ctx.db, intentId);
  if (!stored || stored.history.at(-1)?.status !== "AWAITING_SIGNATURE") return;
  const result = await ctx.chain.verifyExtrinsic({ blockHash: block.hash, txHash, expectedCallHex: callHex, expectedSigner: stored.intent.requester });
  if (!result.found || !result.callMatches || !result.signerMatches) {
    throw new Error(`Scanned extrinsic ${txHash} did not re-verify: ${result.found ? "call or signer mismatch" : result.reason}`);
  }
  const now = stamp(ctx, stored);
  const evidence: Evidence = {
    kind: "source_transaction",
    chain: stored.intent.source.chain,
    method: "watcher_finalized_block_scan",
    txHash,
    blockHash: block.hash,
    blockNumber: block.number,
    finalized: true,
    observedAt: now,
    details: { extrinsicIndex: String(result.extrinsicIndex), events: result.events.join(",") },
  };
  if (!result.success) {
    await appendStatusEvent(ctx.db, intentId, {
      status: "FAILED_BEFORE_SOURCE",
      at: now,
      reason: `found on chain in finalized block ${block.number}, but it failed: ${result.dispatchError ?? "unknown error"}; no funds were transferred`,
      evidence,
    });
    return;
  }
  await appendStatusEvent(ctx.db, intentId, { status: "SOURCE_SUBMITTED", at: now, reason: `found by the watcher in finalized block ${block.number}`, evidence });
  await appendStatusEvent(ctx.db, intentId, { status: "SOURCE_CONFIRMED", at: now, reason: `block ${block.number} is finalized`, evidence });
  ctx.log.info("source found by scan", { intentId, block: block.number, txHash });
}

/** SOURCE_SUBMITTED -> SOURCE_CONFIRMED once the inclusion block is finalized and still canonical. */
async function confirmSources(ctx: WatcherContext, finalized: BlockRef, summary: PassSummary): Promise<void> {
  const ids = await listIntentIdsByStatus(ctx.db, ["SOURCE_SUBMITTED"]);
  summary.errors += await eachIntent(ctx, ids, "confirm source", async (intentId) => {
    const stored = await loadIntent(ctx.db, intentId);
    const source = stored && latestEvidence(stored.history, "source_transaction");
    if (!stored || !source?.blockHash || source.blockNumber === undefined || !source.txHash) {
      throw new Error("SOURCE_SUBMITTED without block evidence");
    }
    if (finalized.number < source.blockNumber) return; // not final yet

    const now = stamp(ctx, stored);
    let block: BlockRef = { number: source.blockNumber, hash: source.blockHash };
    let reason = `block ${source.blockNumber} is finalized and canonical`;
    const canonical = await ctx.chain.canonicalHash(source.blockNumber);
    if (canonical !== source.blockHash) {
      // The reported block lost a fork. The same extrinsic is usually in the block that won, or in
      // one shortly after, so look for it on the finalized chain before drawing any conclusion.
      const search = await findOnFinalizedChain(ctx, source.txHash, source.blockNumber, finalized);
      if (search.kind === "pending") return; // part of the window is not final yet
      if (search.kind === "missing") {
        await appendStatusEvent(ctx.db, intentId, {
          status: "NEEDS_REVIEW",
          at: now,
          reason: `block ${source.blockNumber} was replaced on the finalized chain (finalized hash ${canonical ?? "unknown"}), and the extrinsic is in no finalized block from ${search.from} to ${search.to}`,
        });
        summary.flagged++;
        return;
      }
      block = search.block;
      reason = `reported block ${source.blockNumber} lost a fork; the same extrinsic is in finalized block ${block.number}`;
    }

    const plans = (await listExecutionPlans(ctx.db, intentId)).filter((p) => p.quoteId === stored.selectedQuoteId);
    const plan = plans.find((p) => p.planId === source.details?.planId) ?? plans[0];
    if (!plan) throw new Error("No execution plan for the selected quote");
    const result = await ctx.chain.verifyExtrinsic({
      blockHash: block.hash,
      txHash: source.txHash,
      expectedCallHex: plan.callHex,
      expectedSigner: stored.intent.requester,
    });
    if (!result.found || !result.success || !plans.some((p) => p.callHex === result.callHex) || !result.signerMatches) {
      await appendStatusEvent(ctx.db, intentId, {
        status: "NEEDS_REVIEW",
        at: now,
        reason: "the finalized block no longer verifies as the planned, successful extrinsic",
      });
      summary.flagged++;
      return;
    }

    await appendStatusEvent(ctx.db, intentId, {
      status: "SOURCE_CONFIRMED",
      at: now,
      reason,
      evidence: {
        ...source,
        method: "substrate_finalized_block",
        blockNumber: block.number,
        blockHash: block.hash,
        finalized: true,
        observedAt: now,
        details: {
          ...source.details,
          extrinsicIndex: String(result.extrinsicIndex),
          ...(block.hash !== source.blockHash && { reportedBlockHash: source.blockHash }),
        },
      },
    });
    summary.confirmed++;
  });
}

/**
 * Where a signed extrinsic from a block that lost a fork ended up on the finalized chain. It can sit in
 * the competing block at the same height, or be included again a little later while its mortal era
 * lasts; if the fork began earlier, the winning chain may hold it a few blocks before.
 */
async function findOnFinalizedChain(
  ctx: WatcherContext,
  txHash: Hex,
  reportedAt: bigint,
  finalized: BlockRef,
): Promise<{ kind: "found"; block: BlockRef } | { kind: "pending" } | { kind: "missing"; from: bigint; to: bigint }> {
  const from = reportedAt > FORK_SEARCH_BEFORE_BLOCKS ? reportedAt - FORK_SEARCH_BEFORE_BLOCKS : 1n;
  const to = reportedAt + FORK_SEARCH_AFTER_BLOCKS;
  const heights: bigint[] = [];
  for (let n = reportedAt; n <= to && n <= finalized.number; n++) heights.push(n);
  for (let n = reportedAt - 1n; n >= from; n--) heights.push(n);
  for (const n of heights) {
    const hash = await withRetry(ctx, `block ${n}`, () => ctx.chain.canonicalHash(n));
    if (!hash) continue;
    const extrinsics = await withRetry(ctx, `block ${n}`, () => ctx.chain.blockExtrinsics(hash));
    if (extrinsics.some((ex) => ex.hash === txHash)) return { kind: "found", block: { number: n, hash } };
  }
  return finalized.number < to ? { kind: "pending" } : { kind: "missing", from, to };
}

/** SOURCE_CONFIRMED -> DESTINATION_PENDING. Kept as its own step so the timeline shows when measurement began. */
async function startDestinationChecks(ctx: WatcherContext, summary: PassSummary): Promise<void> {
  const ids = await listIntentIdsByStatus(ctx.db, ["SOURCE_CONFIRMED"]);
  summary.errors += await eachIntent(ctx, ids, "start destination check", async (intentId) => {
    const stored = await loadIntent(ctx.db, intentId);
    if (!stored) return;
    const source = latestEvidence(stored.history, "source_transaction");
    await appendStatusEvent(ctx.db, intentId, {
      status: "DESTINATION_PENDING",
      at: stamp(ctx, stored),
      reason: `measuring the EVM balance of ${stored.intent.destination.recipient} across block ${source?.blockNumber}`,
    });
  });
}

/**
 * DESTINATION_PENDING -> SETTLED or NEEDS_REVIEW. On V3 the destination is the same chain, so the
 * delta is read with eth_getBalance at the inclusion block and the block before it. The block is
 * already finalized, so the measurement is final: anything short of the expectation is flagged.
 */
async function measureDestinations(ctx: WatcherContext, summary: PassSummary): Promise<void> {
  const ids = await listIntentIdsByStatus(ctx.db, ["DESTINATION_PENDING"]);
  summary.errors += await eachIntent(ctx, ids, "measure destination", async (intentId) => {
    const stored = await loadIntent(ctx.db, intentId);
    const source = stored && latestEvidence(stored.history, "source_transaction");
    if (!stored || !source?.finalized || source.blockNumber === undefined || !source.blockHash) {
      throw new Error("DESTINATION_PENDING without finalized source evidence");
    }
    const quote = await selectedQuote(ctx, stored);
    if (!quote) throw new Error("No selected quote");

    const n = source.blockNumber;
    const address = stored.intent.destination.recipient.toLowerCase() as Hex;
    const [before, after] = await Promise.all([ctx.chain.evmBalanceAt(address, n - 1n), ctx.chain.evmBalanceAt(address, n)]);
    const failed = !before.ok ? before : !after.ok ? after : undefined;
    const now = stamp(ctx, stored);
    if (failed && !failed.ok) {
      if (failed.reason !== "state_pruned") {
        ctx.log.warn("destination not measurable yet", { intentId, reason: failed.reason, message: failed.message });
        return;
      }
      await appendStatusEvent(ctx.db, intentId, {
        status: "NEEDS_REVIEW",
        at: now,
        reason: `the node discarded EVM state for block ${n} before the balance change could be measured`,
      });
      summary.flagged++;
      return;
    }
    if (!before.ok || !after.ok) return;

    const rawDelta = after.balance - before.balance;
    const evidence: Evidence = {
      kind: "destination_state",
      chain: stored.intent.destination.chain,
      method: "evm_balance_delta",
      blockNumber: n,
      blockHash: after.blockHash,
      finalized: true,
      amount: rawDelta > 0n ? rawDelta : 0n,
      observedAt: now,
      details: {
        address,
        balanceBefore: before.balance.toString(),
        balanceAfter: after.balance.toString(),
        rawDelta: rawDelta.toString(),
        substrateBlockHash: source.blockHash,
      },
    };

    const decision = assessSettlement({ intent: stored.intent, quote, destination: evidence });
    if (decision.decision === "settled") {
      await appendStatusEvent(ctx.db, intentId, { status: "SETTLED", at: now, reason: decision.reason, evidence, verificationMode: "destination_rpc_state" });
      summary.settled++;
      ctx.log.info("settled", { intentId, delta: rawDelta, expected: quote.expectedOutput });
      return;
    }
    // "pending" cannot resolve later: the measured block is final.
    const reason = decision.decision === "pending" ? `no balance increase at finalized block ${n}` : decision.reason;
    await appendStatusEvent(ctx.db, intentId, { status: "NEEDS_REVIEW", at: now, reason, evidence });
    summary.flagged++;
    ctx.log.warn("flagged for review", { intentId, reason });
  });
}

/**
 * Expires intents nobody signed. An AWAITING_SIGNATURE intent is only expired once its deadline has
 * passed, the longest plausible signed-transaction lifetime has elapsed since its last plan, and the
 * scanner has covered the chain up to the finalized head, so a late inclusion cannot be missed.
 */
async function expireStale(ctx: WatcherContext, finalized: BlockRef, summary: PassSummary): Promise<void> {
  const now = ctx.now();
  const ids = await listIntentIdsByStatus(ctx.db, ["DRAFT", "QUOTED", "AWAITING_SIGNATURE"], 500);
  summary.errors += await eachIntent(ctx, ids, "expire", async (intentId) => {
    const stored = await loadIntent(ctx.db, intentId);
    if (!stored || now < stored.intent.constraints.deadline) return;
    const status = stored.history.at(-1)?.status;
    let reason = "deadline passed before a route was signed";
    if (status === "AWAITING_SIGNATURE") {
      const lastPlan = (await listExecutionPlans(ctx.db, intentId)).at(-1);
      const signableUntil = (lastPlan?.createdAt ?? 0) + ctx.config.signedTxLifetimeSeconds;
      if (now < signableUntil || !summary.caughtUp) return;
      // A signed extrinsic's mortal era counts blocks, not seconds: while the chain is stalled it
      // stays valid, so wall-clock time alone must never expire it. Require the finalized chain to
      // have moved a full lifetime of blocks past the plan as well.
      const planBlock = await heightAtTime(ctx, (lastPlan?.createdAt ?? 0) - CLOCK_SKEW_SECONDS, finalized);
      const lifetimeBlocks = BigInt(Math.ceil(ctx.config.signedTxLifetimeSeconds / TARGET_BLOCK_SECONDS));
      if (finalized.number < planBlock + lifetimeBlocks) return;
      reason = `deadline passed; finalized blocks through ${summary.scannedTo} contain no matching signed transaction`;
    }
    await appendStatusEvent(ctx.db, intentId, { status: "EXPIRED", at: stamp(ctx, stored), reason });
    summary.expired++;
  });
}

// When anchoring paused for lack of relayer funds, per registry: unix seconds to try again.
const anchoringPausedUntil = new WeakMap<BatchRegistryClient, number>();

/**
 * Anchors settled receipts in ReceiptBatchRegistry, one Merkle root per batch. A batch is stored with
 * every leaf and proof before its root is sent, so after a crash the exact root is read back from the
 * contract instead of being rebuilt from a set of waiting receipts that may have changed meanwhile.
 */
async function anchorReceipts(ctx: WatcherContext, summary: PassSummary): Promise<void> {
  const registry = ctx.registry;
  if (!registry) return;
  // An unfunded relayer is an operator task, not an intent failure: say so once, then wait for
  // funds instead of retrying a write that cannot succeed every pass. Settlement is unaffected.
  if (ctx.now() < (anchoringPausedUntil.get(registry) ?? 0)) return;
  const { size, maxWaitSeconds, maxLeaves } = ctx.config.batching;
  let waiting = 0;
  try {
    // Finish planned batches first: one sent before a crash, or one whose write failed.
    for (const batch of await listUnconfirmedReceiptBatches(ctx.db, registry.address)) await confirmBatch(ctx, registry, batch, summary);

    const pending = await listPendingReceiptAnchors(ctx.db, registry.address, maxLeaves);
    waiting = pending.length;
    const oldest = pending[0];
    if (!oldest || (pending.length < size && ctx.now() - oldest.settledAt < maxWaitSeconds)) return;

    const leaves: Omit<ReceiptBatchLeaf, "proof">[] = [];
    summary.errors += await eachIntent(
      ctx,
      pending.map((p) => p.intentId),
      "hash receipt for anchoring",
      async (intentId) => {
        const stored = await loadIntent(ctx.db, intentId);
        const quote = stored && (await selectedQuote(ctx, stored));
        if (!stored || !quote) throw new Error("Settled intent without a selected quote");
        const receiptHash = hashReceipt(buildReceipt({ intent: stored.intent, intentHash: stored.intentHash, quote, history: stored.history }));
        leaves.push({ intentId, intentHash: stored.intentHash, receiptHash, leafHash: batchLeaf(stored.intentHash, receiptHash) });
      },
    );
    if (leaves.length === 0) return;
    const tree = buildMerkleTree(leaves.map((l) => l.leafHash));
    const batch = { contractAddress: registry.address, chainId: registry.chainId, root: tree.root, leafCount: leaves.length, createdAt: ctx.now() };
    await planReceiptBatch(ctx.db, { ...batch, leaves: leaves.map((l) => ({ ...l, proof: merkleProof(tree, l.leafHash) })) });
    await confirmBatch(ctx, registry, batch, summary);
  } catch (error) {
    if (!(error instanceof RelayerFundsError)) {
      summary.errors++;
      ctx.log.error("anchor receipts failed", { error });
      return;
    }
    anchoringPausedUntil.set(registry, ctx.now() + ANCHOR_FUNDS_RETRY_SECONDS);
    ctx.log.warn("relayer needs funding; anchoring paused", {
      relayer: error.account,
      balance: error.balance.toString(),
      needed: error.needed.toString(),
      retryInSeconds: ANCHOR_FUNDS_RETRY_SECONDS,
      waiting,
    });
  }
}

/** Gets a planned batch's root on chain, or finds the transaction that already put it there, and records it. */
async function confirmBatch(ctx: WatcherContext, registry: BatchRegistryClient, batch: StoredReceiptBatch, summary: PassSummary): Promise<void> {
  const onChain = await registry.getBatch(batch.root);
  let tx: MinedTx | null;
  if (!onChain) {
    tx = await registry.recordBatch(batch.root, batch.leafCount);
  } else {
    // Only the configured recorder can write, so a recorded root is this relayer's earlier write.
    if (onChain.leafCount !== batch.leafCount) {
      throw new Error(`Registry holds batch ${batch.root} with ${onChain.leafCount} leaves, but the stored plan has ${batch.leafCount}`);
    }
    tx = await registry.findBatchEvent(batch.root, onChain.blockNumber);
    if (!tx) throw new Error(`Registry holds batch ${batch.root} but no BatchRecorded event was found in block ${onChain.blockNumber}`);
  }
  await recordReceiptBatchAnchor(ctx.db, { contractAddress: registry.address, root: batch.root, ...tx });
  summary.anchored += batch.leafCount;
  ctx.log.info("receipt batch anchored", { root: batch.root, receipts: batch.leafCount, txHash: tx.txHash, recovered: onChain !== null });
}

/** One watcher pass. Each stage reads fresh state, so passes are idempotent and safe to re-run after a crash. */
export async function runPass(ctx: WatcherContext): Promise<PassSummary> {
  const finalized = await ctx.chain.finalizedHead();
  const summary: PassSummary = {
    finalized: finalized.number,
    scannedTo: 0n,
    caughtUp: false,
    found: 0,
    confirmed: 0,
    settled: 0,
    flagged: 0,
    expired: 0,
    anchored: 0,
    errors: 0,
  };
  try {
    await scanForPlannedExtrinsics(ctx, finalized, summary);
  } catch (error) {
    summary.errors++;
    ctx.log.error("source scan failed", { error });
  }
  await confirmSources(ctx, finalized, summary);
  await startDestinationChecks(ctx, summary);
  await measureDestinations(ctx, summary);
  await expireStale(ctx, finalized, summary);
  await anchorReceipts(ctx, summary);
  return summary;
}
