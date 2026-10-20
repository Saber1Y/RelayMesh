import { describe, expect, it } from "vitest";
import { isRelayMeshError } from "./errors.js";
import { hashRequest, resolveIdempotency } from "./idempotency.js";
import { buildReceipt, hashReceipt, serializeReceipt } from "./receipt.js";
import { appendStatus, createHistory, type Evidence } from "./status.js";
import { BLOCK_HASH, fixtureIntent, fixtureQuote, INTENT_ID, NOW, TX_HASH, validInput } from "./test-fixtures.js";

describe("idempotency", () => {
  const body = validInput();
  const record = { key: "intent-key-0001", requestHash: hashRequest(body), intentId: INTENT_ID };

  it("treats a first use as new and a matching replay as the original intent", () => {
    expect(resolveIdempotency(undefined, record.key, record.requestHash)).toEqual({ kind: "new" });
    expect(resolveIdempotency(record, record.key, hashRequest({ ...body }))).toEqual({ kind: "replay", intentId: INTENT_ID });
  });

  it("rejects the same key with a different body", () => {
    const other = hashRequest(validInput({ constraints: { deadline: NOW + 601 } }));
    try {
      resolveIdempotency(record, record.key, other);
      throw new Error("expected conflict");
    } catch (error) {
      expect(isRelayMeshError(error, "IDEMPOTENCY_CONFLICT")).toBe(true);
    }
  });

  it("rejects malformed keys", () => {
    for (const key of ["short", "has space here", "x".repeat(129)]) {
      expect(() => resolveIdempotency(undefined, key, record.requestHash)).toThrow(/Idempotency key/);
    }
  });
});

describe("receipts", () => {
  const { intent, intentHash } = fixtureIntent();
  const quote = fixtureQuote();
  const source: Evidence = {
    kind: "source_transaction",
    chain: "portaldot-v3-substrate",
    method: "substrate_extrinsic_events",
    txHash: TX_HASH,
    blockHash: BLOCK_HASH,
    blockNumber: 113_950n,
    finalized: true,
    observedAt: NOW + 20,
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

  function settledHistory() {
    let h = createHistory(NOW);
    h = appendStatus(h, { status: "QUOTED", at: NOW, reason: "quote received" });
    h = appendStatus(h, { status: "AWAITING_SIGNATURE", at: NOW, reason: "route selected" });
    h = appendStatus(h, { status: "SOURCE_SUBMITTED", at: NOW + 1, reason: "submitted", evidence: { ...source, finalized: false } });
    h = appendStatus(h, { status: "SOURCE_CONFIRMED", at: NOW + 20, reason: "finalized", evidence: source });
    h = appendStatus(h, { status: "DESTINATION_PENDING", at: NOW + 20, reason: "watching" });
    return appendStatus(h, {
      status: "SETTLED",
      at: NOW + 30,
      reason: "balance delta observed",
      evidence: destination,
      verificationMode: "destination_rpc_state",
    });
  }

  it("builds a settled receipt from recorded evidence", () => {
    const receipt = buildReceipt({ intent, intentHash, quote, history: settledHistory() });
    expect(receipt.status).toBe("SETTLED");
    expect(receipt.verificationMode).toBe("destination_rpc_state");
    expect(receipt.source).toMatchObject({ txHash: TX_HASH, blockHash: BLOCK_HASH, finalized: true, verifiedBy: "substrate_extrinsic_events" });
    expect(receipt.destination).toMatchObject({ observedAmount: quote.expectedOutput, finalized: true, verifiedBy: "evm_balance_delta" });
    expect(receipt.timeline.map((t) => t.status)).toEqual([
      "DRAFT",
      "QUOTED",
      "AWAITING_SIGNATURE",
      "SOURCE_SUBMITTED",
      "SOURCE_CONFIRMED",
      "DESTINATION_PENDING",
      "SETTLED",
    ]);
  });

  it("leaves unobserved fields null for in-progress intents", () => {
    const receipt = buildReceipt({ intent, intentHash, quote, history: createHistory(NOW) });
    expect(receipt.status).toBe("DRAFT");
    expect(receipt.verificationMode).toBeNull();
    expect(receipt.source.txHash).toBeNull();
    expect(receipt.destination.observedAmount).toBeNull();
  });

  it("hashes deterministically and serializes bigints as strings", () => {
    const a = buildReceipt({ intent, intentHash, quote, history: settledHistory() });
    const b = buildReceipt({ intent, intentHash, quote, history: settledHistory() });
    expect(hashReceipt(a)).toBe(hashReceipt(b));
    const json = JSON.parse(serializeReceipt(a)) as { source: { amount: string } };
    expect(json.source.amount).toBe("100000000000000");
    expect(hashReceipt({ ...a, status: "NEEDS_REVIEW" })).not.toBe(hashReceipt(a));
  });

  it("refuses a mismatched intent hash or quote", () => {
    expect(() => buildReceipt({ intent, intentHash: `0x${"00".repeat(32)}`, quote, history: settledHistory() })).toThrow(/intentHash/);
    expect(() =>
      buildReceipt({ intent, intentHash, quote: fixtureQuote({ intentId: "0xffffffffffffffffffffffffffffffff" }), history: settledHistory() }),
    ).toThrow(/different intent/);
  });
});
