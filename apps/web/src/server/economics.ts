import "server-only";
import type { Hex, PublicClient } from "viem";
import { createV3PublicClient } from "@relaymesh/chains";
import { listAnchoredBatches, serviceFeeTotals } from "@relaymesh/db";
import { batchRegistryAddress, getDb, serviceFeeConfig, v3Config } from "./services";

/** Revive reports native balances and gas in 18-decimal EVM units; tPOT has 14 on the Substrate side. */
const EVM_TO_NATIVE = 10_000n;

export interface Economics {
  /** RelayMesh's fee per transfer now, in native base units; null when no fee is charged. */
  feePerTransfer: bigint | null;
  feeTransfers: number;
  feesCollected: bigint;
  batches: number;
  anchoredEntries: number;
  /** What the mined batches cost the relayer, from each transaction's receipt (gas used times its price). */
  anchoringSpent: bigint;
  relayer: Hex | null;
  relayerBalance: bigint | null;
}

const cache = globalThis as typeof globalThis & { __relaymeshEvm?: PublicClient; __relaymeshBatchCost?: Map<Hex, bigint> };

function evm(): PublicClient {
  cache.__relaymeshEvm ??= createV3PublicClient(v3Config);
  return cache.__relaymeshEvm;
}

/** A mined transaction's cost never changes, so each is read from the chain once. */
async function batchCost(txHash: Hex): Promise<bigint> {
  const costs = (cache.__relaymeshBatchCost ??= new Map());
  const known = costs.get(txHash);
  if (known !== undefined) return known;
  const receipt = await evm().getTransactionReceipt({ hash: txHash });
  const cost = (receipt.gasUsed * receipt.effectiveGasPrice) / EVM_TO_NATIVE;
  costs.set(txHash, cost);
  return cost;
}

/**
 * Whether the fee pays for anchoring: fees collected from settled transfers against what the relayer
 * has spent writing batches, both from records anyone can check (receipts on chain, quotes in each receipt).
 */
export async function loadEconomics(): Promise<Economics> {
  const db = getDb();
  const contract = batchRegistryAddress();
  const relayer = serviceFeeConfig?.recipient ?? null;
  const [fees, batches, balance] = await Promise.all([
    serviceFeeTotals(db),
    contract ? listAnchoredBatches(db, contract) : Promise.resolve([]),
    relayer ? evm().getBalance({ address: relayer }) : Promise.resolve(null),
  ]);
  const costs = await Promise.all(batches.map((b) => batchCost(b.txHash)));
  return {
    feePerTransfer: serviceFeeConfig?.amount ?? null,
    feeTransfers: fees.transfers,
    feesCollected: fees.amount,
    batches: batches.length,
    anchoredEntries: batches.reduce((sum, b) => sum + b.leafCount, 0),
    anchoringSpent: costs.reduce((sum, c) => sum + c, 0n),
    relayer,
    relayerBalance: balance === null ? null : balance / EVM_TO_NATIVE,
  };
}
