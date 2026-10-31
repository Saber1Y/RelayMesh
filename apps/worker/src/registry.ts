import { createWalletClient, getAbiItem, getAddress, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { portaldotV3EvmChain, type PortaldotV3Config } from "@relaymesh/chains";
import { receiptBatchLogAbi } from "@relaymesh/contracts/abi/ReceiptBatchLog";
import { receiptBatchRegistryAbi } from "@relaymesh/contracts/abi/ReceiptBatchRegistry";

/**
 * Which batch contract the watcher writes to. "registry" (ReceiptBatchRegistry) also stores each root;
 * "log" (ReceiptBatchLog) only emits it, which skips Revive's storage deposit.
 */
export type BatchContractKind = "registry" | "log";

export interface MinedTx {
  txHash: Hex;
  blockNumber: bigint;
}

/** On-chain batch contract access (ReceiptBatchRegistry or ReceiptBatchLog). Only the worker's relayer account ever writes. */
export interface BatchRegistryClient {
  address: Hex;
  kind: BatchContractKind;
  chainId: number;
  /** The relayer account that records batches. */
  recorder: Hex;
  /** The recorder fixed in the contract at deployment; writes from any other account revert. */
  contractRecorder(): Promise<Hex>;
  recordBatch(root: Hex, leafCount: number): Promise<MinedTx>;
  /**
   * The transaction that already recorded this root, for recovery after a crash between mining and
   * recording, or null if none is found. For the log contract the search covers the last
   * EVENT_LOOKBACK_BLOCKS; a root mined earlier than that is simply recorded again.
   */
  findBatch(root: Hex): Promise<(MinedTx & { leafCount: number }) | null>;
}

/** How far back the log contract's recovery search reaches: about eight hours of V3 blocks. */
export const EVENT_LOOKBACK_BLOCKS = 5_000n;

/**
 * The relayer cannot pay for a write. A ReceiptBatchRegistry write costs about 3.9 tPOT on PortalDot
 * V3, almost all of it Revive's storage deposit; a ReceiptBatchLog write about 0.013 tPOT.
 */
export class RelayerFundsError extends Error {
  constructor(
    readonly account: Hex,
    readonly balance: bigint,
    readonly needed: bigint,
  ) {
    super(`Relayer ${account} holds ${balance} wei but this write needs about ${needed}`);
    this.name = "RelayerFundsError";
  }
}

export function createBatchRegistryClient(
  config: PortaldotV3Config,
  publicClient: PublicClient,
  address: Hex,
  privateKey: Hex,
  kind: BatchContractKind,
): BatchRegistryClient {
  const account = privateKeyToAccount(privateKey);
  const chain = portaldotV3EvmChain(config);
  const wallet = createWalletClient({ account, chain, transport: http(config.evmRpcUrl) });
  // Both contracts share recorder(), recordBatch and the BatchRecorded event; only the registry has getBatch.
  const contract = { address: getAddress(address), abi: receiptBatchLogAbi } as const;
  const batchRecorded = getAbiItem({ abi: receiptBatchLogAbi, name: "BatchRecorded" });

  async function logsFor(root: Hex, fromBlock: bigint, toBlock: bigint | "latest") {
    const logs = await publicClient.getLogs({ address: contract.address, event: batchRecorded, args: { root }, fromBlock, toBlock });
    const log = logs[0]; // earliest first
    if (!log?.transactionHash || log.blockNumber === null || log.args.leafCount === undefined) return null;
    return { txHash: log.transactionHash, blockNumber: log.blockNumber, leafCount: log.args.leafCount };
  }

  return {
    address: address.toLowerCase() as Hex,
    kind,
    chainId: config.evmChainId,
    recorder: account.address.toLowerCase() as Hex,

    async contractRecorder() {
      return (await publicClient.readContract({ ...contract, functionName: "recorder" })).toLowerCase() as Hex;
    },

    async recordBatch(root, leafCount) {
      const args = [root, leafCount] as const;
      // Simulate first so a revert (already recorded, not recorder) surfaces as an error before paying fees.
      const { request } = await publicClient.simulateContract({ ...contract, functionName: "recordBatch", args, account });
      // Check the relayer can pay before signing: the node rejects an unaffordable write as an opaque
      // "Invalid Transaction". The margin covers the fee cap sitting above the current gas price.
      const [gas, gasPrice, balance] = await Promise.all([
        publicClient.estimateContractGas({ ...contract, functionName: "recordBatch", args, account }),
        publicClient.getGasPrice(),
        publicClient.getBalance({ address: account.address }),
      ]);
      const needed = (gas * gasPrice * 5n) / 4n;
      if (balance < needed) throw new RelayerFundsError(account.address, balance, needed);
      const txHash = await wallet.writeContract(request);
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
      if (receipt.status !== "success") throw new Error(`recordBatch transaction ${txHash} reverted`);
      return { txHash, blockNumber: receipt.blockNumber };
    },

    async findBatch(root) {
      if (kind === "registry") {
        // The registry stores the block it recorded the batch in, so the search covers exactly that block.
        const batch = await publicClient.readContract({ address: contract.address, abi: receiptBatchRegistryAbi, functionName: "getBatch", args: [root] });
        if (batch.recordedAt === 0n) return null;
        const found = await logsFor(root, batch.blockNumber, batch.blockNumber);
        if (!found) throw new Error(`Registry holds batch ${root} but no BatchRecorded event was found in block ${batch.blockNumber}`);
        return found;
      }
      // The log keeps nothing in storage: search recent blocks for the event, earliest first.
      const head = await publicClient.getBlockNumber();
      return logsFor(root, head > EVENT_LOOKBACK_BLOCKS ? head - EVENT_LOOKBACK_BLOCKS : 0n, "latest");
    },
  };
}
