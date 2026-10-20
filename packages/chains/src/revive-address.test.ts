import { u8aToHex } from "@polkadot/util";
import { decodeAddress, keccak256AsU8a } from "@polkadot/util-crypto";
import { describe, expect, it } from "vitest";
import { fallbackAccountIdForH160, h160ForAccountId, isEthDerivedAccountId } from "./revive-address";

const ALICE = decodeAddress("5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY");
const H160 = "0x1234567890abcdef1234567890abcdef12345678";

describe("revive address mapping", () => {
  it("builds the fallback account as h160 followed by twelve 0xEE bytes", () => {
    const accountId = fallbackAccountIdForH160(H160);
    expect(u8aToHex(accountId)).toBe(`${H160}${"ee".repeat(12)}`);
    expect(isEthDerivedAccountId(accountId)).toBe(true);
  });

  it("round-trips an eth-derived account back to its h160", () => {
    expect(h160ForAccountId(fallbackAccountIdForH160(H160))).toBe(H160);
  });

  it("hashes a native account to the last 20 bytes of keccak256", () => {
    expect(isEthDerivedAccountId(ALICE)).toBe(false);
    expect(h160ForAccountId(ALICE)).toBe(u8aToHex(keccak256AsU8a(ALICE).subarray(12)));
  });

  it("rejects inputs of the wrong length", () => {
    expect(() => fallbackAccountIdForH160("0x1234")).toThrow(/20 bytes/);
    expect(() => h160ForAccountId(new Uint8Array(31))).toThrow(/32 bytes/);
  });
});
