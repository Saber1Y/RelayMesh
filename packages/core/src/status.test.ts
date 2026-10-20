import { describe, expect, it } from "vitest";
import { isRelayMeshError } from "./errors.js";
import { appendStatus, createHistory, currentStatus, isTerminal, type Evidence, type StatusEvent } from "./status.js";
import { BLOCK_HASH, NOW, TX_HASH } from "./test-fixtures.js";

const submitted: Evidence = {
  kind: "source_transaction",
  chain: "portaldot-v3-substrate",
  method: "substrate_extrinsic_events",
  txHash: TX_HASH,
  finalized: false,
  observedAt: NOW,
};
const confirmed: Evidence = { ...submitted, blockHash: BLOCK_HASH, blockNumber: 10n, finalized: true };
const destination: Evidence = {
  kind: "destination_state",
  chain: "portaldot-v3-evm",
  method: "evm_balance_delta",
  amount: 1n,
  finalized: true,
  observedAt: NOW,
};

function happyPathUntil(status: StatusEvent["status"]): StatusEvent[] {
  const steps: Omit<StatusEvent, "seq">[] = [
    { status: "QUOTED", at: NOW, reason: "quote received" },
    { status: "AWAITING_SIGNATURE", at: NOW, reason: "route selected" },
    { status: "SOURCE_SUBMITTED", at: NOW + 1, reason: "extrinsic submitted", evidence: submitted },
    { status: "SOURCE_CONFIRMED", at: NOW + 20, reason: "finalized", evidence: confirmed },
    { status: "DESTINATION_PENDING", at: NOW + 20, reason: "watching destination" },
    {
      status: "SETTLED",
      at: NOW + 30,
      reason: "balance delta observed",
      evidence: destination,
      verificationMode: "destination_rpc_state",
    },
  ];
  let history = createHistory(NOW);
  for (const step of steps) {
    history = appendStatus(history, step);
    if (step.status === status) break;
  }
  return history;
}

function expectRejected(fn: () => unknown, code: "INVALID_TRANSITION" | "MISSING_EVIDENCE" | "INTEGRITY_ERROR"): void {
  try {
    fn();
  } catch (error) {
    expect(isRelayMeshError(error, code), String(error)).toBe(true);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("status state machine", () => {
  it("walks the full happy path to SETTLED", () => {
    const history = happyPathUntil("SETTLED");
    expect(currentStatus(history)).toBe("SETTLED");
    expect(history.map((e) => e.seq)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(isTerminal("SETTLED")).toBe(true);
  });

  it("does not mutate the input history", () => {
    const history = createHistory(NOW);
    appendStatus(history, { status: "QUOTED", at: NOW, reason: "quote" });
    expect(history).toHaveLength(1);
  });

  it("rejects skipped states", () => {
    expectRejected(() => appendStatus(createHistory(NOW), { status: "SETTLED", at: NOW, reason: "x" }), "INVALID_TRANSITION");
    // source confirmation alone never means settled
    expectRejected(
      () =>
        appendStatus(happyPathUntil("SOURCE_CONFIRMED"), {
          status: "SETTLED",
          at: NOW + 30,
          reason: "x",
          evidence: destination,
          verificationMode: "destination_rpc_state",
        }),
      "INVALID_TRANSITION",
    );
  });

  it("rejects transitions out of terminal states", () => {
    expectRejected(() => appendStatus(happyPathUntil("SETTLED"), { status: "NEEDS_REVIEW", at: NOW + 40, reason: "x" }), "INVALID_TRANSITION");
  });

  it("requires a tx hash to mark the source submitted", () => {
    const { txHash: _txHash, ...noHash } = submitted;
    expectRejected(
      () => appendStatus(happyPathUntil("AWAITING_SIGNATURE"), { status: "SOURCE_SUBMITTED", at: NOW, reason: "x", evidence: noHash }),
      "MISSING_EVIDENCE",
    );
  });

  it("requires finalized source evidence to confirm", () => {
    expectRejected(
      () => appendStatus(happyPathUntil("SOURCE_SUBMITTED"), { status: "SOURCE_CONFIRMED", at: NOW + 20, reason: "x", evidence: submitted }),
      "MISSING_EVIDENCE",
    );
  });

  it("requires destination chain evidence and a verification mode to settle", () => {
    const pending = happyPathUntil("DESTINATION_PENDING");
    expectRejected(() => appendStatus(pending, { status: "SETTLED", at: NOW + 30, reason: "x", evidence: destination }), "MISSING_EVIDENCE");
    expectRejected(
      () =>
        appendStatus(pending, {
          status: "SETTLED",
          at: NOW + 30,
          reason: "x",
          evidence: { ...destination, finalized: false },
          verificationMode: "destination_rpc_state",
        }),
      "MISSING_EVIDENCE",
    );
    expectRejected(
      () =>
        appendStatus(pending, {
          status: "SETTLED",
          at: NOW + 30,
          reason: "x",
          evidence: { kind: "provider_status", method: "provider_api", finalized: true, observedAt: NOW },
          verificationMode: "destination_rpc_state",
        }),
      "MISSING_EVIDENCE",
    );
  });

  it("allows provider-only settlement only when labeled as such", () => {
    const history = appendStatus(happyPathUntil("DESTINATION_PENDING"), {
      status: "SETTLED",
      at: NOW + 30,
      reason: "provider reported completion",
      evidence: { kind: "provider_status", method: "provider_api", finalized: true, observedAt: NOW },
      verificationMode: "provider_report_only",
    });
    expect(currentStatus(history)).toBe("SETTLED");
  });

  it("rejects verificationMode on non-settled events, empty reasons and time going backwards", () => {
    expectRejected(
      () => appendStatus(createHistory(NOW), { status: "QUOTED", at: NOW, reason: "x", verificationMode: "destination_rpc_state" }),
      "INVALID_TRANSITION",
    );
    expectRejected(() => appendStatus(createHistory(NOW), { status: "QUOTED", at: NOW, reason: "  " }), "INVALID_TRANSITION");
    expectRejected(() => appendStatus(createHistory(NOW), { status: "QUOTED", at: NOW - 1, reason: "x" }), "INVALID_TRANSITION");
  });

  it("supports re-quoting and quote expiry before signing", () => {
    let history = happyPathUntil("AWAITING_SIGNATURE");
    history = appendStatus(history, { status: "QUOTED", at: NOW + 5, reason: "selected quote expired; re-quoted" });
    history = appendStatus(history, { status: "EXPIRED", at: NOW + 600, reason: "intent deadline passed" });
    expect(currentStatus(history)).toBe("EXPIRED");
  });

  it("detects tampered histories on replay", () => {
    const history = happyPathUntil("SOURCE_CONFIRMED");
    expectRejected(() => currentStatus(history.filter((e) => e.status !== "SOURCE_SUBMITTED")), "INTEGRITY_ERROR");
    const reordered = history.map((e) => (e.status === "QUOTED" ? { ...e, status: "SOURCE_CONFIRMED" as const } : e));
    expectRejected(() => currentStatus(reordered), "INVALID_TRANSITION");
    expectRejected(() => currentStatus([]), "INTEGRITY_ERROR");
  });
});
