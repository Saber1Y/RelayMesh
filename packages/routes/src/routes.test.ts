import { u8aToHex } from "@polkadot/util";
import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import type { Hex } from "viem";
import { describe, expect, it } from "vitest";
import { fallbackAccountIdForH160, type AccountBalance, type V3NativeClient } from "@relaymesh/chains";
import { createIntent, isRelayMeshError, type IntentInput, type Quote, type RelayMeshErrorCode } from "@relaymesh/core";
import { collectQuotes, rankQuotes } from "./collect.js";
import { IBridgeProvider } from "./providers/ibridge.js";
import { QUOTE_TTL_SECONDS, V3SubstrateToEvmProvider } from "./providers/v3-substrate-to-evm.js";
import type { QuoteResult, RouteProvider } from "./types.js";

// Test double for the V3 chain reads. Values mirror the live V3 testnet constants from docs/devlog.md.
const ED = 10_000_000_000_000n; // 0.1 tPOT
const ONE = 100_000_000_000_000n; // 1 tPOT at 14 decimals
const FEE = 1_234_567_890n;
const CALL_HEX = "0x0603" as Hex;

class FakeV3Client implements V3NativeClient {
  ss58Prefix = 42;
  existentialDeposit = ED;
  nativeToEthRatio = 10_000n;
  expectedBlockTimeMs = 6_000;
  balances = new Map<string, AccountBalance>();
  mappings = new Map<string, Uint8Array>();
  fee = FEE;

  async balance(address: string | Uint8Array): Promise<AccountBalance> {
    return this.balances.get(u8aToHex(decodeAddress(address))) ?? { free: 0n, frozen: 0n };
  }
  async originalAccount(h160: Hex): Promise<Uint8Array | null> {
    return this.mappings.get(h160) ?? null;
  }
  async estimateTransferKeepAlive(): Promise<{ partialFee: bigint; callHex: Hex }> {
    return { partialFee: this.fee, callHex: CALL_HEX };
  }
  setBalance(account: string | Uint8Array, free: bigint, frozen = 0n): void {
    this.balances.set(u8aToHex(decodeAddress(account)), { free, frozen });
  }
}

const NOW = 1_792_500_000;
const ALICE = "5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY";
const BOB = "5FHneW46xGXgs5mUiveU4sbTyGBzmstUspZC92UhjJM694ty";
const RECIPIENT = "0xB4A81005669984dBBF9dE26aF42e82Bc9A3C4a27";
const RECIPIENT_LOWER = RECIPIENT.toLowerCase() as Hex;

function intentFor(overrides: Partial<IntentInput> = {}) {
  return createIntent(
    {
      requester: ALICE,
      source: { chain: "portaldot-v3-substrate", asset: "native", amount: ONE.toString() },
      destination: { chain: "portaldot-v3-evm", asset: "native", recipient: RECIPIENT },
      constraints: { deadline: NOW + 600 },
      ...overrides,
    },
    { now: NOW },
  ).intent;
}

function setup() {
  const client = new FakeV3Client();
  client.setBalance(ALICE, 10n * ONE);
  return { client, provider: new V3SubstrateToEvmProvider(client) };
}

async function quoteOk(provider: RouteProvider, intent = intentFor()): Promise<Quote> {
  const result = await provider.quote(intent, { now: NOW });
  if (!result.ok) throw new Error(`expected a quote, got ${result.code}: ${result.reason}`);
  expect(result.quotes).toHaveLength(1);
  return result.quotes[0] as Quote;
}

function expectRejected(result: QuoteResult, code: string): void {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.code).toBe(code);
}

async function expectCode(promise: Promise<unknown>, code: RelayMeshErrorCode): Promise<void> {
  const error = await promise.then(() => undefined, (e: unknown) => e);
  expect(isRelayMeshError(error, code), `expected ${code}, got ${String(error)}`).toBe(true);
}

describe("V3SubstrateToEvmProvider quotes", () => {
  it("quotes a transfer to an existing unmapped EVM account at amount x 10^4", async () => {
    const { client, provider } = setup();
    client.setBalance(fallbackAccountIdForH160(RECIPIENT_LOWER), ONE);
    const quote = await quoteOk(provider);
    expect(quote.expectedOutput).toBe(ONE * 10_000n);
    expect(quote.fees).toEqual([{ kind: "network", chain: "portaldot-v3-substrate", asset: "native", amount: FEE, basis: "estimate" }]);
    expect(quote.expiresAt - quote.retrievedAt).toBe(QUOTE_TTL_SECONDS);
    expect(quote.estimatedSeconds).toBe(18);
  });

  it("subtracts the existential deposit when the destination account is new", async () => {
    const { provider } = setup();
    expect((await quoteOk(provider)).expectedOutput).toBe((ONE - ED) * 10_000n);
  });

  it("credits the mapped original account when the EVM address is mapped", async () => {
    const { client, provider } = setup();
    client.mappings.set(RECIPIENT_LOWER, decodeAddress(BOB));
    client.setBalance(BOB, ONE);
    const intent = intentFor();
    const quote = await quoteOk(provider, intent);
    expect(quote.expectedOutput).toBe(ONE * 10_000n);
    const plan = await provider.buildExecution(intent, quote, { now: NOW + 1 });
    expect(plan.destinationAccount).toBe(BOB);
  });

  it("accounts for frozen funds on the destination", async () => {
    const { client, provider } = setup();
    // frozen 2 tPOT, free 1.5 tPOT: the first 0.5 tPOT received only covers the freeze
    client.setBalance(fallbackAccountIdForH160(RECIPIENT_LOWER), (3n * ONE) / 2n, 2n * ONE);
    expect((await quoteOk(provider)).expectedOutput).toBe((ONE / 2n) * 10_000n);
  });

  it("rejects when the sender cannot cover amount + fee and stay alive", async () => {
    const { client, provider } = setup();
    client.setBalance(ALICE, ONE + ED + FEE - 1n);
    expectRejected(await provider.quote(intentFor(), { now: NOW }), "INSUFFICIENT_BALANCE");
    client.setBalance(ALICE, ONE + ED + FEE);
    expect((await provider.quote(intentFor(), { now: NOW })).ok).toBe(true);
  });

  it("rejects a new destination below the existential deposit", async () => {
    const { provider } = setup();
    const small = intentFor({ source: { chain: "portaldot-v3-substrate", asset: "native", amount: (ED - 1n).toString() } });
    expectRejected(await provider.quote(small, { now: NOW }), "AMOUNT_TOO_SMALL");
  });

  it("rejects a transfer fully absorbed by destination freezes", async () => {
    const { client, provider } = setup();
    client.setBalance(fallbackAccountIdForH160(RECIPIENT_LOWER), ONE, 5n * ONE);
    expectRejected(await provider.quote(intentFor(), { now: NOW }), "AMOUNT_TOO_SMALL");
  });

  it("rejects an EVM address mapped to the sender itself", async () => {
    const { client, provider } = setup();
    client.mappings.set(RECIPIENT_LOWER, decodeAddress(ALICE));
    expectRejected(await provider.quote(intentFor(), { now: NOW }), "INVALID_RECIPIENT");
  });

  it("refuses to run if the chain's decimal ratio disagrees with the registry", async () => {
    const { client, provider } = setup();
    client.nativeToEthRatio = 1_000n;
    await expectCode(provider.quote(intentFor(), { now: NOW }), "INTEGRITY_ERROR");
  });
});

describe("V3SubstrateToEvmProvider execution plans", () => {
  it("returns the unsigned transferKeepAlive call for the user to sign", async () => {
    const { provider } = setup();
    const intent = intentFor();
    const quote = await quoteOk(provider, intent);
    const plan = await provider.buildExecution(intent, quote, { now: NOW + 5 });
    expect(plan).toEqual({
      kind: "substrate_call",
      chain: "portaldot-v3-substrate",
      signer: ALICE,
      callHex: CALL_HEX,
      call: {
        section: "balances",
        method: "transferKeepAlive",
        args: { dest: encodeAddress(fallbackAccountIdForH160(RECIPIENT_LOWER), 42), value: ONE.toString() },
      },
      quoteId: quote.quoteId,
      submitBefore: quote.expiresAt,
      estimatedFee: FEE,
      destinationAccount: encodeAddress(fallbackAccountIdForH160(RECIPIENT_LOWER), 42),
    });
  });

  it("refuses expired quotes", async () => {
    const { provider } = setup();
    const intent = intentFor();
    const quote = await quoteOk(provider, intent);
    await expectCode(provider.buildExecution(intent, quote, { now: quote.expiresAt }), "QUOTE_EXPIRED");
  });

  it("refuses when destination state changed since quoting", async () => {
    const { client, provider } = setup();
    const intent = intentFor();
    const quote = await quoteOk(provider, intent); // destination was new: ED subtracted
    client.setBalance(fallbackAccountIdForH160(RECIPIENT_LOWER), ONE); // someone funded it meanwhile
    const error = await provider.buildExecution(intent, quote, { now: NOW + 1 }).catch((e: unknown) => e);
    expect(isRelayMeshError(error, "QUOTE_MISMATCH")).toBe(true);
    expect((error as Error).message).toMatch(/Destination state changed/);
  });

  it("refuses when the fee rose above maxFee or the sender can no longer pay", async () => {
    const { client, provider } = setup();
    const intent = intentFor({ constraints: { deadline: NOW + 600, maxFee: FEE.toString() } });
    const quote = await quoteOk(provider, intent);
    client.fee = FEE + 1n;
    await expectCode(provider.buildExecution(intent, quote, { now: NOW + 1 }), "CONSTRAINT_VIOLATION");
    client.fee = FEE;
    client.setBalance(ALICE, ED);
    await expectCode(provider.buildExecution(intent, quote, { now: NOW + 1 }), "CONSTRAINT_VIOLATION");
  });

  it("refuses quotes issued by another provider", async () => {
    const { provider } = setup();
    const intent = intentFor();
    const quote = { ...(await quoteOk(provider, intent)), provider: "someone-else" };
    const error = await provider.buildExecution(intent, quote, { now: NOW + 1 }).catch((e: unknown) => e);
    expect((error as Error).message).toMatch(/not issued by/);
  });
});

describe("IBridgeProvider", () => {
  it("reports itself unavailable and never quotes", async () => {
    const provider = new IBridgeProvider();
    expect(provider.status().available).toBe(false);
    expect(provider.supports()).toBe(false);
    expectRejected(await provider.quote(), "PROVIDER_UNAVAILABLE");
    await expectCode(provider.buildExecution(), "UNSUPPORTED_ROUTE");
  });
});

describe("collectQuotes and rankQuotes", () => {
  const intent = intentFor();
  const base = { intentId: intent.intentId, routeId: "r", retrievedAt: NOW, expiresAt: NOW + 60 };
  const fee = (amount: bigint) => [{ kind: "network" as const, chain: "portaldot-v3-substrate" as const, asset: "native", amount, basis: "estimate" as const }];

  it("ranks by output, then source fees, then validity, then quote ID", () => {
    const quotes: Quote[] = [
      { ...base, quoteId: "d", provider: "p", expectedOutput: 100n, fees: fee(5n) },
      { ...base, quoteId: "a", provider: "p", expectedOutput: 200n, fees: fee(9n) },
      { ...base, quoteId: "c", provider: "p", expectedOutput: 100n, fees: fee(1n) },
      { ...base, quoteId: "b", provider: "p", expectedOutput: 100n, fees: fee(1n), expiresAt: NOW + 90 },
      { ...base, quoteId: "e", provider: "p", expectedOutput: 100n, fees: fee(1n), expiresAt: NOW + 90 },
    ];
    expect(rankQuotes(quotes, intent).map((q) => q.quoteId)).toEqual(["a", "b", "e", "c", "d"]);
  });

  it("collects quotes and reports every provider that could not quote, including thrown errors", async () => {
    const { provider } = setup();
    const broken: RouteProvider = {
      id: "broken",
      name: "Broken",
      description: "",
      status: () => ({ available: true }),
      supports: () => true,
      quote: () => Promise.reject(new Error("RPC timeout")),
      buildExecution: () => Promise.reject(new Error("unused")),
    };
    const result = await collectQuotes([provider, new IBridgeProvider(), broken], intent, { now: NOW });
    expect(result.ranked).toHaveLength(1);
    expect(result.rejections).toEqual([
      { provider: "portaldot-ibridge", code: "PROVIDER_UNAVAILABLE", reason: expect.stringContaining("iBridge") },
      { provider: "broken", code: "PROVIDER_ERROR", reason: "RPC timeout" },
    ]);
  });

  it("reports unsupported pairs without calling the provider", async () => {
    const { provider } = setup();
    const reversed = createIntent(
      {
        requester: RECIPIENT,
        source: { chain: "portaldot-v3-evm", asset: "native", amount: "1" },
        destination: { chain: "portaldot-v3-substrate", asset: "native", recipient: ALICE },
        constraints: { deadline: NOW + 600 },
      },
      { now: NOW },
    ).intent;
    const result = await collectQuotes([provider], reversed, { now: NOW });
    expect(result.ranked).toEqual([]);
    expect(result.rejections[0]?.code).toBe("UNSUPPORTED_ROUTE");
  });
});
