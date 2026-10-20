import { sql } from "drizzle-orm";
import type { Hex } from "viem";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  buildReceipt,
  createIntent,
  hashReceipt,
  hashRequest,
  isRelayMeshError,
  type Evidence,
  type IntentInput,
  type Quote,
  type RelayMeshErrorCode,
} from "@relaymesh/core";
import { connectDb } from "./client";
import {
  appendStatusEvent,
  insertIntent,
  listIntentIdsByStatus,
  addExecutionPlan,
  listExecutionPlans,
  listQuotes,
  loadIntent,
  recordQuotes,
  selectQuote,
  type ExecutionPlanRecord,
} from "./store";

const url = process.env.TEST_DATABASE_URL as string;
const { db, close } = connectDb(url, { max: 5 });
afterAll(() => close());
beforeEach(async () => {
  await db.execute(sql`TRUNCATE watcher_cursors, registry_anchors, execution_plans, status_events, idempotency_records, quotes, intents`);
});

const NOW = 1_792_500_000;
const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
const BLOCK_HASH = `0x${"cd".repeat(32)}` as Hex;

function input(overrides: Partial<IntentInput> = {}): IntentInput {
  return {
    requester: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    // Larger than 2^64 to prove numeric(78,0) round-trips exactly
    source: { chain: "portaldot-v3-substrate", asset: "native", amount: "123456789012345678901234567890" },
    destination: { chain: "portaldot-v3-evm", asset: "native", recipient: "0xB4A81005669984dBBF9dE26aF42e82Bc9A3C4a27" },
    constraints: { deadline: NOW + 600, minOutput: "1" },
    ...overrides,
  };
}

async function newIntent(key = `key-${crypto.randomUUID()}`, body = input()) {
  const created = createIntent(body, { now: NOW });
  const result = await insertIntent(db, { ...created, idempotencyKey: key, requestHash: hashRequest(body) });
  return { ...created, key, body, result };
}

function quoteFor(intentId: Hex, overrides: Partial<Quote> = {}): Quote {
  return {
    quoteId: `q-${crypto.randomUUID()}`,
    intentId,
    provider: "portaldot-v3-native",
    routeId: "v3-substrate-to-evm",
    expectedOutput: 1_234_567_890_123_456_789_012_345_678_900_000n,
    fees: [{ kind: "network", chain: "portaldot-v3-substrate", asset: "native", amount: 12_345n, basis: "estimate" }],
    retrievedAt: NOW,
    expiresAt: NOW + 120,
    estimatedSeconds: 30,
    ...overrides,
  };
}

function planFor(quote: Quote, at = NOW + 2): ExecutionPlanRecord {
  return {
    planId: `plan-${crypto.randomUUID()}`,
    quoteId: quote.quoteId,
    kind: "substrate_call",
    chain: "portaldot-v3-substrate",
    signer: "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY",
    callHex: "0x0603aa",
    destinationAccount: "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty",
    estimatedFee: 1_490_601_551_715n,
    submitBefore: quote.expiresAt,
    createdAt: at,
  };
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

describe("intents", () => {
  it("round-trips an intent exactly, including amounts above 2^64", async () => {
    const { intent, intentHash, result } = await newIntent();
    expect(result).toEqual({ kind: "created", intentId: intent.intentId });

    const stored = await loadIntent(db, intent.intentId);
    expect(stored?.intent).toEqual(intent);
    expect(stored?.intentHash).toBe(intentHash);
    expect(stored?.history.map((e) => e.status)).toEqual(["DRAFT"]);
    expect(stored?.selectedQuoteId).toBeNull();
  });

  it("returns undefined for unknown intents", async () => {
    expect(await loadIntent(db, "0xffffffffffffffffffffffffffffffff")).toBeUndefined();
  });

  it("detects tampering with stored terms", async () => {
    const { intent } = await newIntent();
    await db.execute(sql`ALTER TABLE intents DISABLE TRIGGER intents_guard_update`);
    try {
      await db.execute(sql`UPDATE intents SET source_amount = source_amount + 1 WHERE intent_id = ${intent.intentId}`);
    } finally {
      await db.execute(sql`ALTER TABLE intents ENABLE TRIGGER intents_guard_update`);
    }
    await expectCode(loadIntent(db, intent.intentId), "INTEGRITY_ERROR");
  });
});

describe("idempotency", () => {
  it("replays the original intent for the same key and body", async () => {
    const first = await newIntent("intent-key-0001");
    const second = await newIntent("intent-key-0001", first.body);
    expect(second.result).toEqual({ kind: "replayed", intentId: first.intent.intentId });
    expect(await listIntentIdsByStatus(db, ["DRAFT"])).toEqual([first.intent.intentId]);
  });

  it("rejects the same key with a different body", async () => {
    await newIntent("intent-key-0002");
    await expectCode(newIntent("intent-key-0002", input({ constraints: { deadline: NOW + 601 } })), "IDEMPOTENCY_CONFLICT");
  });

  it("creates exactly one intent under concurrent requests with the same key", async () => {
    const body = input();
    const results = await Promise.all(Array.from({ length: 5 }, () => newIntent("intent-key-race", body)));
    const created = results.filter((r) => r.result.kind === "created");
    expect(created).toHaveLength(1);
    expect(new Set(results.map((r) => r.result.intentId)).size).toBe(1);
    expect(await listIntentIdsByStatus(db, ["DRAFT"])).toHaveLength(1);
  });
});

describe("quotes and status events", () => {
  it("records quotes, selects one, and walks to SETTLED with evidence intact", async () => {
    const { intent, intentHash } = await newIntent();
    const quote = quoteFor(intent.intentId);
    await recordQuotes(db, intent.intentId, [quote], NOW + 1);
    expect(await listQuotes(db, intent.intentId)).toEqual([quote]);

    const { event } = await selectQuote(db, intent.intentId, quote.quoteId, NOW + 2, planFor(quote));
    expect(event.status).toBe("AWAITING_SIGNATURE");

    const source: Evidence = {
      kind: "source_transaction",
      chain: "portaldot-v3-substrate",
      method: "substrate_extrinsic_events",
      txHash: TX_HASH,
      blockHash: BLOCK_HASH,
      blockNumber: 113_950n,
      finalized: true,
      observedAt: NOW + 20,
      details: { extrinsicIndex: "2" },
    };
    const destination: Evidence = {
      kind: "destination_state",
      chain: "portaldot-v3-evm",
      method: "evm_balance_delta",
      amount: quote.expectedOutput,
      blockNumber: 113_951n,
      finalized: true,
      observedAt: NOW + 30,
    };
    await appendStatusEvent(db, intent.intentId, { status: "SOURCE_SUBMITTED", at: NOW + 3, reason: "submitted", evidence: { ...source, finalized: false } });
    await appendStatusEvent(db, intent.intentId, { status: "SOURCE_CONFIRMED", at: NOW + 20, reason: "finalized", evidence: source });
    await appendStatusEvent(db, intent.intentId, { status: "DESTINATION_PENDING", at: NOW + 20, reason: "watching" });
    await appendStatusEvent(db, intent.intentId, {
      status: "SETTLED",
      at: NOW + 30,
      reason: "balance delta observed",
      evidence: destination,
      verificationMode: "destination_rpc_state",
    });

    const stored = await loadIntent(db, intent.intentId);
    expect(stored?.selectedQuoteId).toBe(quote.quoteId);
    expect(stored?.history.map((e) => e.status)).toEqual([
      "DRAFT",
      "QUOTED",
      "AWAITING_SIGNATURE",
      "SOURCE_SUBMITTED",
      "SOURCE_CONFIRMED",
      "DESTINATION_PENDING",
      "SETTLED",
    ]);
    expect(stored?.history[4]?.evidence).toEqual(source);
    expect(stored?.history[6]?.evidence).toEqual(destination);

    // A receipt rebuilt from storage is identical to one built from the same facts in memory.
    const fromDb = buildReceipt({ intent, intentHash, quote, history: stored?.history ?? [] });
    expect(fromDb.status).toBe("SETTLED");
    expect(hashReceipt(fromDb)).toBe(hashReceipt(buildReceipt({ intent, intentHash, quote, history: stored?.history ?? [] })));
    expect(await listIntentIdsByStatus(db, ["SETTLED"])).toEqual([intent.intentId]);
  });

  it("refuses to select an expired quote and leaves state unchanged", async () => {
    const { intent } = await newIntent();
    const quote = quoteFor(intent.intentId);
    await recordQuotes(db, intent.intentId, [quote], NOW + 1);
    await expectCode(selectQuote(db, intent.intentId, quote.quoteId, quote.expiresAt, planFor(quote)), "QUOTE_EXPIRED");
    const stored = await loadIntent(db, intent.intentId);
    expect(stored?.history.at(-1)?.status).toBe("QUOTED");
    expect(stored?.selectedQuoteId).toBeNull();
  });

  it("refuses to select another intent's quote", async () => {
    const a = await newIntent();
    const b = await newIntent();
    const quote = quoteFor(b.intent.intentId);
    await recordQuotes(db, a.intent.intentId, [quoteFor(a.intent.intentId)], NOW + 1);
    await recordQuotes(db, b.intent.intentId, [quote], NOW + 1);
    await expectCode(selectQuote(db, a.intent.intentId, quote.quoteId, NOW + 2, planFor(quote)), "QUOTE_MISMATCH");
  });

  it("re-quoting clears a previous selection", async () => {
    const { intent } = await newIntent();
    const first = quoteFor(intent.intentId);
    await recordQuotes(db, intent.intentId, [first], NOW + 1);
    await selectQuote(db, intent.intentId, first.quoteId, NOW + 2, planFor(first));
    await recordQuotes(db, intent.intentId, [quoteFor(intent.intentId, { retrievedAt: NOW + 130, expiresAt: NOW + 250 })], NOW + 130);
    const stored = await loadIntent(db, intent.intentId);
    expect(stored?.history.at(-1)?.status).toBe("QUOTED");
    expect(stored?.selectedQuoteId).toBeNull();
    expect(await listQuotes(db, intent.intentId)).toHaveLength(2);
  });

  it("rejects invalid transitions without writing anything", async () => {
    const { intent } = await newIntent();
    await expectCode(appendStatusEvent(db, intent.intentId, { status: "SOURCE_CONFIRMED", at: NOW + 1, reason: "skip" }), "INVALID_TRANSITION");
    const stored = await loadIntent(db, intent.intentId);
    expect(stored?.history).toHaveLength(1);
  });

  it("serializes concurrent transitions for one intent", async () => {
    const { intent } = await newIntent();
    const quote = quoteFor(intent.intentId);
    await recordQuotes(db, intent.intentId, [quote], NOW + 1);
    await selectQuote(db, intent.intentId, quote.quoteId, NOW + 2, planFor(quote));
    const submit = () =>
      appendStatusEvent(db, intent.intentId, {
        status: "SOURCE_SUBMITTED",
        at: NOW + 3,
        reason: "submitted",
        evidence: { kind: "source_transaction", method: "substrate_extrinsic_events", txHash: TX_HASH, finalized: false, observedAt: NOW + 3 },
      });
    const results = await Promise.allSettled([submit(), submit(), submit()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect((await loadIntent(db, intent.intentId))?.history.filter((e) => e.status === "SOURCE_SUBMITTED")).toHaveLength(1);
  });
});

describe("execution plans", () => {
  it("stores the plan with the selection and allows re-built plans only while awaiting signature", async () => {
    const { intent } = await newIntent();
    const quote = quoteFor(intent.intentId);
    await recordQuotes(db, intent.intentId, [quote], NOW + 1);
    const first = planFor(quote);
    await selectQuote(db, intent.intentId, quote.quoteId, NOW + 2, first);
    const second = planFor(quote, NOW + 3);
    await addExecutionPlan(db, intent.intentId, second);
    expect(await listExecutionPlans(db, intent.intentId)).toEqual([first, second]);

    await expectCode(addExecutionPlan(db, intent.intentId, planFor(quoteFor(intent.intentId))), "INVALID_TRANSITION");
  });

  it("does not store a plan when selection fails", async () => {
    const { intent } = await newIntent();
    const quote = quoteFor(intent.intentId);
    await recordQuotes(db, intent.intentId, [quote], NOW + 1);
    await expectCode(selectQuote(db, intent.intentId, quote.quoteId, quote.expiresAt, planFor(quote)), "QUOTE_EXPIRED");
    await expectCode(selectQuote(db, intent.intentId, quote.quoteId, NOW + 2, planFor(quoteFor(intent.intentId))), "QUOTE_MISMATCH");
    expect(await listExecutionPlans(db, intent.intentId)).toEqual([]);
  });

  it("is append-only", async () => {
    const { intent } = await newIntent();
    const quote = quoteFor(intent.intentId);
    await recordQuotes(db, intent.intentId, [quote], NOW + 1);
    await selectQuote(db, intent.intentId, quote.quoteId, NOW + 2, planFor(quote));
    await expectDbRejection(db.execute(sql`UPDATE execution_plans SET call_hex = '0x00' WHERE intent_id = ${intent.intentId}`), /append-only/);
  });
});

describe("append-only enforcement in the database", () => {
  it("rejects updates and deletes of status events, quotes and idempotency records", async () => {
    const { intent, key } = await newIntent();
    await recordQuotes(db, intent.intentId, [quoteFor(intent.intentId)], NOW + 1);
    await expectDbRejection(db.execute(sql`UPDATE status_events SET reason = 'edited' WHERE intent_id = ${intent.intentId}`), /append-only/);
    await expectDbRejection(db.execute(sql`DELETE FROM status_events WHERE intent_id = ${intent.intentId}`), /append-only/);
    await expectDbRejection(db.execute(sql`UPDATE quotes SET expected_output = 0 WHERE intent_id = ${intent.intentId}`), /append-only/);
    await expectDbRejection(db.execute(sql`DELETE FROM idempotency_records WHERE key = ${key}`), /append-only/);
  });

  it("rejects changes to intent terms and deletes, but allows the status projection", async () => {
    const { intent } = await newIntent();
    await expectDbRejection(db.execute(sql`UPDATE intents SET recipient = 'x' WHERE intent_id = ${intent.intentId}`), /immutable/);
    await expectDbRejection(db.execute(sql`DELETE FROM intents WHERE intent_id = ${intent.intentId}`), /not allowed/);
    await db.execute(sql`UPDATE intents SET current_status = 'DRAFT' WHERE intent_id = ${intent.intentId}`);
  });

  it("enforces check constraints on raw inserts", async () => {
    await expectDbRejection(
      db.execute(sql`INSERT INTO intents (intent_id, intent_hash, version, requester, source_chain, source_asset, source_amount,
        destination_chain, destination_asset, recipient, deadline, created_at, current_status)
        VALUES ('not-hex', ${`0x${"00".repeat(32)}`}, 1, 'r', 'a', 'n', 1, 'b', 'n', 'x', 2, 1, 'DRAFT')`),
      /intents_intent_id_hex/,
    );
  });
});

describe("activity summaries", () => {
  it("counts by status, lists recent intents and measures settlement time", async () => {
    const { countIntentsByStatus, listRecentIntents, recentSettlementSeconds } = await import("./activity-store");
    const a = await newIntent();
    const b = await newIntent();
    const quote = quoteFor(b.intent.intentId);
    await recordQuotes(db, b.intent.intentId, [quote], NOW + 1);
    await selectQuote(db, b.intent.intentId, quote.quoteId, NOW + 2, planFor(quote));
    const source: Evidence = {
      kind: "source_transaction",
      chain: "portaldot-v3-substrate",
      method: "substrate_block_extrinsic",
      txHash: TX_HASH,
      blockHash: BLOCK_HASH,
      blockNumber: 10n,
      finalized: true,
      observedAt: NOW + 10,
    };
    await appendStatusEvent(db, b.intent.intentId, { status: "SOURCE_SUBMITTED", at: NOW + 10, reason: "in block", evidence: { ...source, finalized: false } });
    await appendStatusEvent(db, b.intent.intentId, { status: "SOURCE_CONFIRMED", at: NOW + 20, reason: "final", evidence: source });
    await appendStatusEvent(db, b.intent.intentId, { status: "DESTINATION_PENDING", at: NOW + 20, reason: "measuring" });
    await appendStatusEvent(db, b.intent.intentId, {
      status: "SETTLED",
      at: NOW + 29,
      reason: "observed",
      evidence: { kind: "destination_state", chain: "portaldot-v3-evm", method: "evm_balance_delta", amount: 1n, finalized: true, observedAt: NOW + 29 },
      verificationMode: "destination_rpc_state",
    });

    const counts = await countIntentsByStatus(db);
    expect(counts.DRAFT).toBe(1);
    expect(counts.SETTLED).toBe(1);
    expect(counts.EXPIRED).toBe(0);
    const recent = await listRecentIntents(db, 5);
    expect(recent.map((r) => r.intentId).sort()).toEqual([a.intent.intentId, b.intent.intentId].sort());
    expect(recent.find((r) => r.intentId === b.intent.intentId)?.sourceAmount).toBe(a.intent.source.amount);
    expect(await recentSettlementSeconds(db)).toEqual([19]);
  });
});
