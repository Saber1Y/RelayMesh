import type { ApiPromise } from "@polkadot/api";
import { u8aEq } from "@polkadot/util";
import { decodeAddress } from "@polkadot/util-crypto";
import type { Hex } from "viem";

export interface ExtrinsicCheck {
  blockHash: Hex;
  txHash: Hex;
  /** The SCALE-encoded call the user was asked to sign. */
  expectedCallHex: Hex;
  expectedSigner: string;
}

export type ExtrinsicVerification =
  | { found: false; reason: string }
  | {
      found: true;
      blockNumber: bigint;
      extrinsicIndex: number;
      /** The call bytes actually included on chain. */
      callHex: Hex;
      /** True only when the call bytes match the plan exactly. */
      callMatches: boolean;
      signerMatches: boolean;
      success: boolean;
      /** Decoded module error when the extrinsic failed, e.g. "balances.InsufficientBalance". */
      dispatchError?: string;
      events: string[];
    };

/**
 * Reads the block from the chain (never from the client) and checks that it contains the extrinsic,
 * that the extrinsic is exactly the planned call signed by the expected account, and whether it succeeded.
 */
export async function verifySubstrateExtrinsic(api: ApiPromise, check: ExtrinsicCheck): Promise<ExtrinsicVerification> {
  let signedBlock;
  try {
    signedBlock = await api.rpc.chain.getBlock(check.blockHash);
  } catch {
    return { found: false, reason: `Block ${check.blockHash} is not known to the node` };
  }

  const extrinsics = signedBlock.block.extrinsics;
  const index = extrinsics.findIndex((ex) => ex.hash.toHex() === check.txHash);
  if (index < 0) return { found: false, reason: `Extrinsic ${check.txHash} is not in block ${check.blockHash}` };
  const extrinsic = extrinsics[index];
  if (!extrinsic) return { found: false, reason: "Extrinsic disappeared while reading the block" };

  const records = await (await api.at(check.blockHash)).query.system.events();
  const own = records.filter(({ phase }) => phase.isApplyExtrinsic && phase.asApplyExtrinsic.eq(index));

  let success = false;
  let dispatchError: string | undefined;
  for (const { event } of own) {
    if (api.events.system.ExtrinsicSuccess.is(event)) success = true;
    if (api.events.system.ExtrinsicFailed.is(event)) {
      const [error] = event.data;
      if (error.isModule) {
        const meta = api.registry.findMetaError(error.asModule);
        dispatchError = `${meta.section}.${meta.name}`;
      } else {
        dispatchError = error.type;
      }
    }
  }

  return {
    found: true,
    blockNumber: signedBlock.block.header.number.toBigInt(),
    extrinsicIndex: index,
    callHex: extrinsic.method.toHex() as Hex,
    callMatches: extrinsic.method.toHex() === check.expectedCallHex,
    signerMatches: extrinsic.isSigned && u8aEq(decodeAddress(extrinsic.signer.toString()), decodeAddress(check.expectedSigner)),
    success,
    ...(dispatchError !== undefined && { dispatchError }),
    events: own.map(({ event }) => `${event.section}.${event.method}`),
  };
}

/** True when the block is at or below the finalized head and is the canonical block at its height. */
export async function isBlockFinalized(api: ApiPromise, blockHash: Hex, blockNumber: bigint): Promise<boolean> {
  const finalizedHash = await api.rpc.chain.getFinalizedHead();
  const finalized = await api.rpc.chain.getHeader(finalizedHash);
  if (finalized.number.toBigInt() < blockNumber) return false;
  const canonical = await api.rpc.chain.getBlockHash(blockNumber);
  return canonical.toHex() === blockHash;
}
