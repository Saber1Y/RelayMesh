import { describe, expect, it } from "vitest";
import type { Hex } from "viem";
import { assessBridgeTransfer, BRIDGE_CHECK_DOMAIN, bridgeCheckFacts, expectedPayout, hashBridgeCheck, parseDepositId, type BridgeDeposit, type BridgePayout } from "./bridge";
import { hashCanonical } from "./canonical";

const BRIDGE = "5DFSpdFBFU1eXYUKf6887djpFAhrEuzgUEDHHb9ksi2javoo";
const FEE = { feeBps: 300, sourceDecimals: 14, targetDecimals: 18 };
const same = (a: string, b: string) => a === b;

// A real deposit: 33 POT into the bridge in Portaldot block #832820 (14:16:24 UTC, 28 Oct 2026).
function deposit(overrides: Partial<BridgeDeposit> = {}): BridgeDeposit {
  return {
    id: { block: 832820, index: 1 },
    blockHash: `0x${"aa".repeat(32)}` as Hex,
    extrinsicHash: `0x${"bb".repeat(32)}` as Hex,
    time: 1793196984,
    finalized: true,
    signer: "5FCseeEx3WhNNikXozEiXjjRhAVB5KRtAgJvy3NWfgnbwvyh",
    call: "balances.transferKeepAlive",
    destination: BRIDGE,
    amount: 3_300_000_000_000_000n,
    success: true,
    ...overrides,
  };
}

function payout(overrides: Partial<BridgePayout> = {}): BridgePayout {
  return {
    txHash: `0x${"cc".repeat(32)}` as Hex,
    blockNumber: 130_000_000n,
    time: 1793196984 + 336 * 60,
    recipient: "0x43b42020aa000000000000000000000000000001" as Hex,
    amount: 32_010_000_000_000_000_000n, // 32.01 WPOT, as observed on BSC
    finalized: true,
    ...overrides,
  };
}

describe("parseDepositId", () => {
  it("reads explorer IDs and explorer links", () => {
    expect(parseDepositId("844578-1")).toEqual({ block: 844578, index: 1 });
    expect(parseDepositId(" https://scanner-live-v3.portaldot.dev/#/extrinsics/844578-1 ")).toEqual({ block: 844578, index: 1 });
  });

  it("rejects anything else with a hint", () => {
    expect(() => parseDepositId("0x0927208b")).toThrow(/block-index/);
    expect(() => parseDepositId("844578")).toThrow(/block-index/);
  });
});

describe("expectedPayout", () => {
  it("takes the 3% fee and rescales 14-decimal POT to 18-decimal WPOT, exactly as observed on chain", () => {
    expect(expectedPayout(3_300_000_000_000_000n, FEE)).toBe(32_010_000_000_000_000_000n); // 33 POT -> 32.01 WPOT
    expect(expectedPayout(600_000_000_000_000n, FEE)).toBe(5_820_000_000_000_000_000n); // 6 POT -> 5.82 WPOT
    expect(expectedPayout(100_000_000_000_000n, FEE)).toBe(970_000_000_000_000_000n); // 1 POT -> 0.97 WPOT
  });

  it("rejects an impossible fee", () => {
    expect(() => expectedPayout(1n, { ...FEE, feeBps: 10_000 })).toThrow(/fee/);
  });
});

describe("assessBridgeTransfer", () => {
  it("verifies a deposit with an exact later payout", () => {
    const result = assessBridgeTransfer({ deposit: deposit(), depositAddress: BRIDGE, fee: FEE, candidates: [payout()], sameAccount: same });
    expect(result).toMatchObject({ verdict: "verified", expected: 32_010_000_000_000_000_000n, problems: [] });
  });

  it("ignores an equal payout made before the deposit, the trap a naive amount match falls into", () => {
    const earlier = payout({ time: deposit().time - 60, blockNumber: 129_999_000n });
    const result = assessBridgeTransfer({ deposit: deposit(), depositAddress: BRIDGE, fee: FEE, candidates: [earlier], sameAccount: same });
    expect(result.verdict).toBe("payout_pending");
    expect(result.payout).toBeNull();
  });

  it("takes the earliest matching payout, and only the named recipient's when one is given", () => {
    const first = payout({ blockNumber: 130_000_000n, recipient: "0x1111111111111111111111111111111111111111" });
    const second = payout({ blockNumber: 130_000_500n, txHash: `0x${"dd".repeat(32)}` as Hex });
    expect(assessBridgeTransfer({ deposit: deposit(), depositAddress: BRIDGE, fee: FEE, candidates: [second, first], sameAccount: same }).payout?.blockNumber).toBe(130_000_000n);
    const named = assessBridgeTransfer({ deposit: deposit(), depositAddress: BRIDGE, fee: FEE, candidates: [second, first], recipient: second.recipient, sameAccount: same });
    expect(named.payout?.txHash).toBe(second.txHash);
  });

  it("calls a proven deposit without a payout pending, not failed", () => {
    const result = assessBridgeTransfer({ deposit: deposit(), depositAddress: BRIDGE, fee: FEE, candidates: [payout({ amount: 1n })], sameAccount: same });
    expect(result).toMatchObject({ verdict: "payout_pending", payout: null });
  });

  it("holds the verdict while either block is not final", () => {
    expect(assessBridgeTransfer({ deposit: deposit(), depositAddress: BRIDGE, fee: FEE, candidates: [payout({ finalized: false })], sameAccount: same }).verdict).toBe("not_final");
    expect(assessBridgeTransfer({ deposit: deposit({ finalized: false }), depositAddress: BRIDGE, fee: FEE, candidates: [], sameAccount: same }).verdict).toBe("not_final");
  });

  it("rejects transfers that are not successful deposits into the bridge", () => {
    expect(assessBridgeTransfer({ deposit: deposit({ destination: "5Other" }), depositAddress: BRIDGE, fee: FEE, candidates: [payout()], sameAccount: same }).verdict).toBe("not_a_deposit");
    expect(assessBridgeTransfer({ deposit: deposit({ success: false }), depositAddress: BRIDGE, fee: FEE, candidates: [payout()], sameAccount: same }).verdict).toBe("not_a_deposit");
    const remark = assessBridgeTransfer({ deposit: deposit({ call: "system.remark", destination: null, amount: null }), depositAddress: BRIDGE, fee: FEE, candidates: [], sameAccount: same });
    expect(remark).toMatchObject({ verdict: "not_a_deposit", problems: ["The extrinsic is system.remark, not a balances transfer"] });
  });

  it("still verifies when the node lost the block's state, and says so", () => {
    const result = assessBridgeTransfer({ deposit: deposit({ success: null }), depositAddress: BRIDGE, fee: FEE, candidates: [payout()], sameAccount: same });
    expect(result.verdict).toBe("verified");
    expect(result.problems[0]).toMatch(/no longer holds/);
  });
});

describe("hashBridgeCheck", () => {
  it("is stable for the same facts and changes with any of them", () => {
    expect(hashBridgeCheck(deposit(), payout())).toBe(hashBridgeCheck(deposit(), payout()));
    expect(hashBridgeCheck(deposit(), payout({ amount: 1n }))).not.toBe(hashBridgeCheck(deposit(), payout()));
  });
});

describe("bridgeCheckFacts", () => {
  it("is plain JSON that re-hashes to the check hash", () => {
    const facts = bridgeCheckFacts(deposit(), payout());
    expect(JSON.parse(JSON.stringify(facts))).toEqual(facts);
    expect(hashCanonical(BRIDGE_CHECK_DOMAIN, facts)).toBe(hashBridgeCheck(deposit(), payout()));
  });
});
