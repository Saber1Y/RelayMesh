import { createWalletClient, getAddress, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { portaldotV3EvmChain, type PortaldotV3Config } from "@relaymesh/chains";
import { receiptBatchRegistryAbi } from "@relaymesh/contracts/abi/ReceiptBatchRegistry";

export interface BatchState {
  /** Block timestamp of the recording transaction, in unix seconds. */
  recordedAt: bigint;
  blockNumber: bigint;
  leafCount: number;
}

export interface MinedTx {
  txHash: Hex;
  blockNumber: bigint;
}

/** On-chain ReceiptBatchRegistry access. Only the worker's relayer account ever writes. */
export interface BatchRegistryClient {
  address: Hex;
  chainId: number;
  /** The relayer account that records batches. */
  recorder: Hex;
  /** The recorder fixed in the contract at deployment; writes from any other account revert. */
  contractRecorder(): Promise<Hex>;
  /** The recorded batch with this root, or null if the root was never recorded. */
  getBatch(root: Hex): Promise<BatchState | null>;
  recordBatch(root: Hex, leafCount: number): Promise<MinedTx>;
  /** The transaction that recorded this root in the given block, for recovery after a crash between mining and recording. */
  findBatchEvent(root: Hex, blockNumber: bigint): Promise<MinedTx | null>;
}

/**
 * The relayer cannot pay for a write. On PortalDot V3 most of a write's cost is Revive's storage
 * deposit (about 3.9 tPOT per batch, whatever its size), so the account runs dry long before gas would.
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

export function createBatchRegistryClient(config: PortaldotV3Config, publicClient: PublicClient, address: Hex, privateKey: Hex): BatchRegistryClient {
  const account = privateKeyToAccount(privateKey);
  const chain = portaldotV3EvmChain(config);
  const wallet = createWalletClient({ account, chain, transport: http(config.evmRpcUrl) });
  const contract = { address: getAddress(address), abi: receiptBatchRegistryAbi } as const;
  const batchRecorded = receiptBatchRegistryAbi.find((item) => item.type === "event" && item.name === "BatchRecorded");
  if (batchRecorded?.type !== "event") throw new Error("ABI has no BatchRecorded event");

  return {
    address: address.toLowerCase() as Hex,
    chainId: config.evmChainId,
    recorder: account.address.toLowerCase() as Hex,

    async contractRecorder() {
      return (await publicClient.readContract({ ...contract, functionName: "recorder" })).toLowerCase() as Hex;
    },

    async getBatch(root) {
      const batch = await publicClient.readContract({ ...contract, functionName: "getBatch", args: [root] });
      return batch.recordedAt === 0n ? null : { recordedAt: batch.recordedAt, blockNumber: batch.blockNumber, leafCount: batch.leafCount };
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

    async findBatchEvent(root, blockNumber) {
      // The contract stores the block it recorded the batch in, so the search covers exactly that block.
      const logs = await publicClient.getLogs({ address: contract.address, event: batchRecorded, args: { root }, fromBlock: blockNumber, toBlock: blockNumber });
      const log = logs.at(-1);
      return log?.transactionHash && log.blockNumber !== null ? { txHash: log.transactionHash, blockNumber: log.blockNumber } : null;
    },
  };
}
