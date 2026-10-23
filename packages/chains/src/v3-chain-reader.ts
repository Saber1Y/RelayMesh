import type { ApiPromise } from "@polkadot/api";
import type { Hex, PublicClient } from "viem";
import { verifySubstrateExtrinsic, type ExtrinsicCheck, type ExtrinsicVerification } from "./substrate-verify";

export interface BlockRef {
  number: bigint;
  hash: Hex;
}

export interface BlockExtrinsic {
  index: number;
  hash: Hex;
  callHex: Hex;
  /** SS58 signer, or null for unsigned extrinsics (inherents). */
  signer: string | null;
}

export type EvmBalanceRead =
  | { ok: true; balance: bigint; blockHash: Hex }
  | { ok: false; reason: "not_indexed" | "state_pruned" | "error"; message: string };

/**
 * Everything the watcher reads from PortalDot V3. On V3 the EVM block number equals the Substrate
 * block number (verified 2026-10-20), but the hashes differ, so EVM reads report their own hash.
 */
export interface V3ChainReader {
  finalizedHead(): Promise<BlockRef>;
  /** Canonical block hash at a height, or null if the node has no block there yet. */
  canonicalHash(number: bigint): Promise<Hex | null>;
  blockExtrinsics(hash: Hex): Promise<BlockExtrinsic[]>;
  verifyExtrinsic(check: ExtrinsicCheck): Promise<ExtrinsicVerification>;
  /** Block time in unix seconds, from the block's own timestamp.set inherent (works for blocks of any age). */
  blockTimestamp(hash: Hex): Promise<number>;
  /** eth_getBalance at an exact block. Historical state is only kept for recent blocks. */
  evmBalanceAt(address: Hex, blockNumber: bigint): Promise<EvmBalanceRead>;
}

export function createV3ChainReader(api: ApiPromise, evm: PublicClient): V3ChainReader {
  return {
    async finalizedHead() {
      const hash = await api.rpc.chain.getFinalizedHead();
      const header = await api.rpc.chain.getHeader(hash);
      return { number: header.number.toBigInt(), hash: hash.toHex() as Hex };
    },

    async canonicalHash(number) {
      const hash = await api.rpc.chain.getBlockHash(number);
      return hash.isEmpty ? null : (hash.toHex() as Hex);
    },

    async blockExtrinsics(hash) {
      const block = await api.rpc.chain.getBlock(hash);
      return block.block.extrinsics.map((ex, index) => ({
        index,
        hash: ex.hash.toHex() as Hex,
        callHex: ex.method.toHex() as Hex,
        signer: ex.isSigned ? ex.signer.toString() : null,
      }));
    },

    verifyExtrinsic(check) {
      return verifySubstrateExtrinsic(api, check);
    },

    async blockTimestamp(hash) {
      // Read from the block body, not from state: the public node discards state for older blocks,
      // but keeps every block, so this answers for any height.
      const block = await api.rpc.chain.getBlock(hash);
      const set = block.block.extrinsics.find((ex) => ex.method.section === "timestamp" && ex.method.method === "set");
      if (!set) throw new Error(`Block ${hash} has no timestamp.set inherent`);
      return Number(BigInt(set.method.args[0]?.toString() ?? "0") / 1000n);
    },

    async evmBalanceAt(address, blockNumber) {
      try {
        const indexed = await evm.getBlockNumber();
        if (indexed < blockNumber) return { ok: false, reason: "not_indexed", message: `EVM RPC is at block ${indexed}` };
        const [balance, block] = await Promise.all([evm.getBalance({ address, blockNumber }), evm.getBlock({ blockNumber })]);
        if (!block.hash) return { ok: false, reason: "not_indexed", message: `EVM block ${blockNumber} has no hash yet` };
        return { ok: true, balance, blockHash: block.hash };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, reason: /state already discarded|unknownblock/i.test(message) ? "state_pruned" : "error", message };
      }
    },
  };
}
