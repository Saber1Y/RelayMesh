import { describe, expect, it } from "vitest";
import { normalizeAddress } from "./chains";
import { isRelayMeshError, type RelayMeshErrorCode } from "./errors";
import { createIntent, hashIntent, MAX_DEADLINE_SECONDS } from "./intent";
import { ALICE, EVM_RECIPIENT, fixtureIntent, INTENT_ID, NOW, validInput } from "./test-fixtures";

function expectCode(fn: () => unknown, code: RelayMeshErrorCode, field?: string): void {
  try {
    fn();
  } catch (error) {
    expect(isRelayMeshError(error, code), String(error)).toBe(true);
    if (field) expect((error as { field?: string }).field).toBe(field);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("createIntent", () => {
  it("normalizes a valid Substrate -> EVM intent", () => {
    const { intent, intentHash } = fixtureIntent();
    expect(intent).toEqual({
      version: 1,
      intentId: INTENT_ID,
      createdAt: NOW,
      requester: ALICE,
      source: { chain: "portaldot-v3-substrate", asset: "native", amount: 100_000_000_000_000n },
      destination: { chain: "portaldot-v3-evm", asset: "native", recipient: EVM_RECIPIENT },
      constraints: { deadline: NOW + 600 },
    });
    expect(intentHash).toBe(hashIntent(intent));
  });

  it("checksums EVM recipients", () => {
    const { intent } = fixtureIntent({
      destination: { chain: "portaldot-v3-evm", asset: "native", recipient: EVM_RECIPIENT.toLowerCase() },
    });
    expect(intent.destination.recipient).toBe(EVM_RECIPIENT);
  });

  it("re-encodes SS58 addresses from other prefixes to prefix 42", () => {
    const polkadotAlice = "15oF4uVJwmo4TdGW7VfQxNLavjCXviqxT9S1MgbjMNHr6Sp5";
    expect(normalizeAddress("portaldot-v3-substrate", polkadotAlice)).toBe(ALICE);
  });

  it("generates distinct IDs and hashes for identical requests", () => {
    const a = createIntent(validInput(), { now: NOW });
    const b = createIntent(validInput(), { now: NOW });
    expect(a.intent.intentId).not.toBe(b.intent.intentId);
    expect(a.intentHash).not.toBe(b.intentHash);
  });

  it("changes the hash when any field changes", () => {
    const base = fixtureIntent().intentHash;
    expect(fixtureIntent({ constraints: { deadline: NOW + 601 } }).intentHash).not.toBe(base);
    expect(fixtureIntent({ source: { chain: "portaldot-v3-substrate", asset: "native", amount: "100000000000001" } }).intentHash).not.toBe(base);
  });

  it("rejects malformed input with the offending field", () => {
    expectCode(() => createIntent({ ...validInput(), extra: 1 }, { now: NOW }), "INVALID_INTENT");
    expectCode(
      () => createIntent(validInput({ source: { chain: "portaldot-v3-substrate", asset: "native", amount: "1.5" } }), { now: NOW }),
      "INVALID_INTENT",
      "source.amount",
    );
  });

  it("rejects unsupported chains, assets and same-chain routes", () => {
    expectCode(() => fixtureIntent({ source: { chain: "ethereum", asset: "native", amount: "1" } }), "UNSUPPORTED_CHAIN");
    expectCode(() => fixtureIntent({ source: { chain: "portaldot-v3-substrate", asset: "USDC", amount: "1" } }), "UNSUPPORTED_ASSET");
    expectCode(
      () => fixtureIntent({ destination: { chain: "portaldot-v3-substrate", asset: "native", recipient: ALICE } }),
      "UNSUPPORTED_ROUTE",
      "destination.chain",
    );
  });

  it("rejects zero amounts", () => {
    expectCode(() => fixtureIntent({ source: { chain: "portaldot-v3-substrate", asset: "native", amount: "0" } }), "INVALID_AMOUNT");
  });

  it("rejects addresses in the wrong format for their chain", () => {
    expectCode(() => fixtureIntent({ requester: EVM_RECIPIENT }), "INVALID_ADDRESS", "requester");
    expectCode(
      () => fixtureIntent({ destination: { chain: "portaldot-v3-evm", asset: "native", recipient: ALICE } }),
      "INVALID_ADDRESS",
      "destination.recipient",
    );
    expectCode(() => fixtureIntent({ requester: `${ALICE.slice(0, -1)}Z` }), "INVALID_ADDRESS");
  });

  it("enforces the deadline window", () => {
    expectCode(() => fixtureIntent({ constraints: { deadline: NOW + 30 } }), "DEADLINE_INVALID");
    expectCode(() => fixtureIntent({ constraints: { deadline: NOW + MAX_DEADLINE_SECONDS + 1 } }), "DEADLINE_INVALID");
  });

  it("keeps optional constraints as bigint", () => {
    const { intent } = fixtureIntent({ constraints: { deadline: NOW + 600, minOutput: "5", maxFee: "7" } });
    expect(intent.constraints).toEqual({ deadline: NOW + 600, minOutput: 5n, maxFee: 7n });
  });
});
