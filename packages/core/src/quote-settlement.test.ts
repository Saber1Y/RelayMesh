import { describe, expect, it } from "vitest";
import { isRelayMeshError, type RelayMeshErrorCode } from "./errors.js";
import { assertQuoteUsable, otherFees, sourceFeeTotal } from "./quote.js";
import { assessSettlement } from "./settlement.js";
import type { Evidence } from "./status.js";
import { fixtureIntent, fixtureQuote, NOW } from "./test-fixtures.js";

function expectCode(fn: () => unknown, code: RelayMeshErrorCode): void {
  try {
    fn();
  } catch (error) {
    expect(isRelayMeshError(error, code), String(error)).toBe(true);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("assertQuoteUsable", () => {
  const { intent } = fixtureIntent({ constraints: { deadline: NOW + 600, minOutput: "900000000000000000", maxFee: "2000000000" } });

  it("accepts a fresh quote that meets constraints", () => {
    expect(() => assertQuoteUsable(fixtureQuote(), intent, NOW + 10)).not.toThrow();
  });

  it("blocks expired quotes and passed deadlines", () => {
    expectCode(() => assertQuoteUsable(fixtureQuote(), intent, NOW + 120), "QUOTE_EXPIRED");
    expectCode(() => assertQuoteUsable(fixtureQuote({ expiresAt: NOW + 10_000 }), intent, NOW + 600), "QUOTE_EXPIRED");
  });

  it("blocks quotes for another intent", () => {
    expectCode(() => assertQuoteUsable(fixtureQuote({ intentId: "0xffffffffffffffffffffffffffffffff" }), intent, NOW), "QUOTE_MISMATCH");
  });

  it("enforces minOutput and maxFee", () => {
    expectCode(() => assertQuoteUsable(fixtureQuote({ expectedOutput: 1n }), intent, NOW), "CONSTRAINT_VIOLATION");
    const expensive = fixtureQuote({
      fees: [{ kind: "network", chain: "portaldot-v3-substrate", asset: "native", amount: 2_000_000_001n, basis: "estimate" }],
    });
    expectCode(() => assertQuoteUsable(expensive, intent, NOW), "CONSTRAINT_VIOLATION");
  });

  it("only counts source-asset fees against maxFee and reports the rest separately", () => {
    const quote = fixtureQuote({
      fees: [
        { kind: "network", chain: "portaldot-v3-substrate", asset: "native", amount: 5n, basis: "estimate" },
        { kind: "provider", chain: "portaldot-v3-substrate", asset: "native", amount: 7n, basis: "quoted" },
        { kind: "network", chain: "portaldot-v3-evm", asset: "native", amount: 1_000n, basis: "estimate" },
      ],
    });
    expect(sourceFeeTotal(quote, intent)).toBe(12n);
    expect(otherFees(quote, intent)).toHaveLength(1);
  });
});

describe("assessSettlement", () => {
  const { intent } = fixtureIntent();
  const quote = fixtureQuote();
  const observed = (amount: bigint, finalized = true): Evidence => ({
    kind: "destination_state",
    chain: "portaldot-v3-evm",
    method: "evm_balance_delta",
    amount,
    finalized,
    observedAt: NOW,
  });

  it("settles when finalized destination funds meet the expected output", () => {
    expect(assessSettlement({ intent, quote, destination: observed(quote.expectedOutput) }).decision).toBe("settled");
  });

  it("stays pending without destination funds or before finality", () => {
    expect(assessSettlement({ intent, quote }).decision).toBe("pending");
    expect(assessSettlement({ intent, quote, providerStatus: "pending" }).decision).toBe("pending");
    expect(assessSettlement({ intent, quote, destination: observed(quote.expectedOutput, false) }).decision).toBe("pending");
  });

  it("flags conflicts between provider status and chain evidence for review", () => {
    expect(assessSettlement({ intent, quote, providerStatus: "completed" }).decision).toBe("needs_review");
    expect(assessSettlement({ intent, quote, destination: observed(0n), providerStatus: "completed" }).decision).toBe("needs_review");
    expect(assessSettlement({ intent, quote, destination: observed(quote.expectedOutput), providerStatus: "failed" }).decision).toBe(
      "needs_review",
    );
  });

  it("flags short deliveries and evidence from the wrong chain", () => {
    expect(assessSettlement({ intent, quote, destination: observed(quote.expectedOutput - 1n) }).decision).toBe("needs_review");
    expect(
      assessSettlement({ intent, quote, destination: { ...observed(quote.expectedOutput), chain: "portaldot-v3-substrate" } }).decision,
    ).toBe("needs_review");
  });

  it("uses minOutput as the threshold when the user set one", () => {
    const { intent: tolerant } = fixtureIntent({ constraints: { deadline: NOW + 600, minOutput: "1" } });
    expect(assessSettlement({ intent: tolerant, quote, destination: observed(1n) }).decision).toBe("settled");
  });
});
