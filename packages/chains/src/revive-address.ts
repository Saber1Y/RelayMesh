import { hexToU8a, u8aToHex } from "@polkadot/util";
import { keccak256AsU8a } from "@polkadot/util-crypto";
import type { Hex } from "viem";

// Mirrors pallet-revive's AccountId32Mapper:
// - an H160 with no mapped original account is controlled by the "fallback" AccountId32 h160 ++ [0xEE; 12]
// - an AccountId32 ending in [0xEE; 12] is eth-derived and maps back to its first 20 bytes
// - any other AccountId32 maps to keccak256(accountId)[12..32]
const ETH_SUFFIX_BYTE = 0xee;
const ETH_SUFFIX_LEN = 12;

function assertLength(bytes: Uint8Array, expected: number, label: string): void {
  if (bytes.length !== expected) {
    throw new Error(`${label} must be ${expected} bytes, got ${bytes.length}`);
  }
}

export function isEthDerivedAccountId(accountId: Uint8Array): boolean {
  assertLength(accountId, 32, "AccountId32");
  return accountId.subarray(20).every((b) => b === ETH_SUFFIX_BYTE);
}

export function fallbackAccountIdForH160(address: Hex): Uint8Array {
  const h160 = hexToU8a(address);
  assertLength(h160, 20, "H160 address");
  const accountId = new Uint8Array(32);
  accountId.set(h160, 0);
  accountId.fill(ETH_SUFFIX_BYTE, 20, 20 + ETH_SUFFIX_LEN);
  return accountId;
}

export function h160ForAccountId(accountId: Uint8Array): Hex {
  assertLength(accountId, 32, "AccountId32");
  const h160 = isEthDerivedAccountId(accountId)
    ? accountId.subarray(0, 20)
    : keccak256AsU8a(accountId).subarray(12, 32);
  return u8aToHex(h160) as Hex;
}
