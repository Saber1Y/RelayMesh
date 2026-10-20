// Shared test fixtures. Not exported from the package entry point.
import type { Hex } from "viem";
import { createIntent, type IntentInput } from "./intent";
import type { Quote } from "./quote";

export const NOW = 1_792_500_000;
export const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
export const EVM_RECIPIENT = "0xB4A81005669984dBBF9dE26aF42e82Bc9A3C4a27"; // EIP-55 checksummed
export const INTENT_ID = "0x000102030405060708090a0b0c0d0e0f" as Hex;
export const TX_HASH = `0x${"ab".repeat(32)}` as Hex;
export const BLOCK_HASH = `0x${"cd".repeat(32)}` as Hex;

export function validInput(overrides: Partial<IntentInput> = {}): IntentInput {
  return {
    requester: ALICE,
    source: { chain: "portaldot-v3-substrate", asset: "native", amount: "100000000000000" }, // 1 tPOT
    destination: { chain: "portaldot-v3-evm", asset: "native", recipient: EVM_RECIPIENT },
    constraints: { deadline: NOW + 600 },
    ...overrides,
  };
}

export function fixtureIntent(overrides: Partial<IntentInput> = {}) {
  return createIntent(validInput(overrides), { now: NOW, intentId: INTENT_ID });
}

export function fixtureQuote(overrides: Partial<Quote> = {}): Quote {
  return {
    quoteId: "q-1",
    intentId: INTENT_ID,
    provider: "portaldot-v3-native",
    routeId: "v3-substrate-to-evm",
    expectedOutput: 1_000_000_000_000_000_000n, // 1 tPOT at 18 decimals
    fees: [{ kind: "network", chain: "portaldot-v3-substrate", asset: "native", amount: 1_000_000_000n, basis: "estimate" }],
    retrievedAt: NOW,
    expiresAt: NOW + 120,
    ...overrides,
  };
}
