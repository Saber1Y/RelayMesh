import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import { getAddress, isAddress } from "viem";
import { RelayMeshError } from "./errors";

export type AddressKind = "ss58" | "evm";

export interface AssetDefinition {
  symbol: string;
  decimals: number;
}

export interface ChainDefinition {
  id: string;
  name: string;
  addressKind: AddressKind;
  ss58Prefix?: number;
  evmChainId?: number;
  testnet: boolean;
  /** Assets keyed by RelayMesh asset ID. "native" is the chain's fee token. */
  assets: Record<string, AssetDefinition>;
}

// Values verified against the live V3 testnet on 2026-10-20 (see docs/devlog.md).
// Both entries are views of the same PortalDot V3 chain: the native Substrate side (14 decimals)
// and the Revive EVM side (18 decimals, nativeToEthRatio = 10^4).
export const CHAINS = {
  "portaldot-v3-substrate": {
    id: "portaldot-v3-substrate",
    name: "PortalDot V3 Testnet (Substrate)",
    addressKind: "ss58",
    ss58Prefix: 42,
    testnet: true,
    assets: { native: { symbol: "tPOT", decimals: 14 } },
  },
  "portaldot-v3-evm": {
    id: "portaldot-v3-evm",
    name: "PortalDot V3 Testnet (EVM)",
    addressKind: "evm",
    evmChainId: 420420777,
    testnet: true,
    assets: { native: { symbol: "tPOT", decimals: 18 } },
  },
} as const satisfies Record<string, ChainDefinition>;

export type ChainId = keyof typeof CHAINS;

export function isChainId(value: string): value is ChainId {
  return Object.hasOwn(CHAINS, value);
}

export function getChain(chainId: string): ChainDefinition {
  if (!isChainId(chainId)) throw new RelayMeshError("UNSUPPORTED_CHAIN", `Unsupported chain: ${chainId}`);
  return CHAINS[chainId];
}

export function getAsset(chainId: string, assetId: string): AssetDefinition {
  const asset = getChain(chainId).assets[assetId];
  if (!asset) throw new RelayMeshError("UNSUPPORTED_ASSET", `Asset "${assetId}" is not supported on ${chainId}`);
  return asset;
}

/** Validates an address for the chain and returns its canonical form (SS58 with the chain prefix, or EIP-55). */
export function normalizeAddress(chainId: string, address: string, field = "address"): string {
  const chain = getChain(chainId);
  const value = address.trim();

  if (chain.addressKind === "evm") {
    if (!isAddress(value, { strict: false })) {
      throw new RelayMeshError("INVALID_ADDRESS", `${field} is not a valid EVM address`, field);
    }
    return getAddress(value);
  }

  // SS58 only: raw hex public keys are rejected so users cannot paste an EVM address by mistake.
  // Any network prefix is accepted (wallets show the same key in different formats); the checksum
  // must be valid and the key must be a 32-byte account, and the result is re-encoded with this chain's prefix.
  const prefix = chain.ss58Prefix ?? 42;
  if (value.startsWith("0x")) {
    throw new RelayMeshError("INVALID_ADDRESS", `${field} must be an SS58 address, not hex`, field);
  }
  let publicKey: Uint8Array;
  try {
    publicKey = decodeAddress(value);
  } catch (error) {
    throw new RelayMeshError("INVALID_ADDRESS", `${field} is not a valid SS58 address: ${(error as Error).message}`, field);
  }
  if (publicKey.length !== 32) {
    throw new RelayMeshError("INVALID_ADDRESS", `${field} must be a 32-byte account`, field);
  }
  return encodeAddress(publicKey, prefix);
}
