import { decodeEventLog, getAbiItem, toEventSelector, type Hex, type PublicClient } from "viem";
import { receiptBatchLogAbi } from "@relaymesh/contracts/abi/ReceiptBatchLog";

/**
 * Reads a batch root from the chain the same way for both batch contracts: from the BatchRecorded log
 * of the transaction RelayMesh says recorded it. ReceiptBatchRegistry and ReceiptBatchLog emit the same
 * event, and only from recordBatch after checking the caller is the recorder fixed at deployment, so a
 * BatchRecorded log from one of RelayMesh's contract addresses is the relayer's commitment to that
 * root. The transaction hash comes from RelayMesh and is untrusted: a wrong one finds no such log.
 */

export interface BatchOnChain {
  txHash: Hex;
  blockNumber: bigint;
  /** Block timestamp of the recording transaction, in unix seconds. */
  recordedAt: bigint;
  leafCount: number;
}

const BATCH_RECORDED = getAbiItem({ abi: receiptBatchLogAbi, name: "BatchRecorded" });
const BATCH_RECORDED_TOPIC = toEventSelector(BATCH_RECORDED);

/** The batch `contract` recorded with this root in transaction `txHash`, or null if that transaction holds no such record. */
export async function findBatchLog(client: PublicClient, contract: Hex, txHash: Hex, root: Hex): Promise<BatchOnChain | null> {
  const receipt = await client.getTransactionReceipt({ hash: txHash }).catch(() => null);
  if (!receipt || receipt.status !== "success") return null;
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.toLowerCase() || log.topics[0] !== BATCH_RECORDED_TOPIC) continue;
    const { args } = decodeEventLog({ abi: [BATCH_RECORDED], data: log.data, topics: log.topics });
    if (args.root.toLowerCase() !== root.toLowerCase()) continue;
    const block = await client.getBlock({ blockNumber: receipt.blockNumber });
    return { txHash: receipt.transactionHash, blockNumber: receipt.blockNumber, recordedAt: block.timestamp, leafCount: args.leafCount };
  }
  return null;
}
