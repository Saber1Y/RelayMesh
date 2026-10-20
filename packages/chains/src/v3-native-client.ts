import type { ApiPromise } from "@polkadot/api";
import { u8aToHex } from "@polkadot/util";
import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import type { Hex } from "viem";

export interface AccountBalance {
  free: bigint;
  frozen: bigint;
}

export interface TransferEstimate {
  /** payment_queryInfo partialFee for the unsigned call, in native base units. */
  partialFee: bigint;
  /** SCALE-encoded call, the exact call the user will be asked to sign. */
  callHex: Hex;
}

/**
 * The PortalDot V3 reads and estimates the Substrate -> EVM route needs. A narrow interface so the
 * route logic can be unit-tested without a node; `createV3NativeClient` is the only real implementation.
 */
export interface V3NativeClient {
  ss58Prefix: number;
  existentialDeposit: bigint;
  /** Revive's native (14 decimals) to EVM (18 decimals) multiplier. */
  nativeToEthRatio: bigint;
  expectedBlockTimeMs: number;
  balance(address: string | Uint8Array): Promise<AccountBalance>;
  /** The native account an H160 is mapped to via revive.mapAccount, or null if unmapped. */
  originalAccount(h160: Hex): Promise<Uint8Array | null>;
  estimateTransferKeepAlive(from: string, to: Uint8Array, amount: bigint): Promise<TransferEstimate>;
}

export function createV3NativeClient(api: ApiPromise): V3NativeClient {
  const ss58Prefix = api.registry.chainSS58 ?? 42;
  return {
    ss58Prefix,
    existentialDeposit: api.consts.balances.existentialDeposit.toBigInt(),
    nativeToEthRatio: BigInt(api.consts.revive.nativeToEthRatio.toNumber()),
    expectedBlockTimeMs: api.consts.babe.expectedBlockTime.toNumber(),

    async balance(address) {
      const { data } = await api.query.system.account(address);
      return { free: data.free.toBigInt(), frozen: data.frozen.toBigInt() };
    },

    async originalAccount(h160) {
      const mapped = await api.query.revive.originalAccount(h160);
      return mapped.isSome ? mapped.unwrap().toU8a() : null;
    },

    async estimateTransferKeepAlive(from, to, amount) {
      const tx = api.tx.balances.transferKeepAlive(encodeAddress(to, ss58Prefix), amount);
      const info = await tx.paymentInfo(encodeAddress(decodeAddress(from), ss58Prefix));
      return { partialFee: info.partialFee.toBigInt(), callHex: u8aToHex(tx.method.toU8a()) as Hex };
    },
  };
}
