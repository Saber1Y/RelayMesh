import { createWalletClient, getAddress, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { portaldotV3EvmChain, type PortaldotV3Config } from "@relaymesh/chains";
import { intentRegistryAbi } from "@relaymesh/contracts/abi/IntentRegistry";

export interface RegistryState {
  recorder: Hex;
  routeId: Hex;
  receiptHash: Hex;
}

export interface MinedTx {
  txHash: Hex;
  blockNumber: bigint;
}

/** On-chain IntentRegistry access. Only the worker's relayer account ever writes. */
export interface RegistryClient {
  address: Hex;
  chainId: number;
  /** The relayer account that records intents. */
  recorder: Hex;
  read(intentHash: Hex): Promise<RegistryState>;
  recordIntent(intentHash: Hex, routeId: Hex): Promise<MinedTx>;
  recordReceipt(intentHash: Hex, receiptHash: Hex): Promise<MinedTx>;
  /** Finds the transaction that emitted an event for this intent, for recovery after a crash between mining and recording. */
  findEvent(kind: "IntentRecorded" | "ReceiptRecorded", intentHash: Hex, fromBlock: bigint): Promise<MinedTx | null>;
}

/**
 * The relayer cannot pay for a write. On PortalDot V3 most of a write's cost is Revive's storage
 * deposit, about 11.5 tPOT per IntentRegistry write, so the account runs dry long before gas would.
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

export const ZERO_ADDRESS: Hex = "0x0000000000000000000000000000000000000000";
export const ZERO_HASH: Hex = `0x${"0".repeat(64)}`;

/** How far back findEvent searches. Recovery only matters for writes from the last few passes. */
export const EVENT_LOOKBACK_BLOCKS = 5_000n;

export function createRegistryClient(config: PortaldotV3Config, publicClient: PublicClient, address: Hex, privateKey: Hex): RegistryClient {
  const account = privateKeyToAccount(privateKey);
  const chain = portaldotV3EvmChain(config);
  const wallet = createWalletClient({ account, chain, transport: http(config.evmRpcUrl) });
  const contract = { address: getAddress(address), abi: intentRegistryAbi } as const;

  async function send(functionName: "recordIntent" | "recordReceipt", args: readonly [Hex, Hex]): Promise<MinedTx> {
    // Simulate first so a revert (already recorded, not recorder) surfaces as an error before paying fees.
    const { request } = await publicClient.simulateContract({ ...contract, functionName, args, account });
    // Check the relayer can pay before signing: the node rejects an unaffordable write as an opaque
    // "Invalid Transaction". The margin covers the fee cap sitting above the current gas price.
    const [gas, gasPrice, balance] = await Promise.all([
      publicClient.estimateContractGas({ ...contract, functionName, args, account }),
      publicClient.getGasPrice(),
      publicClient.getBalance({ address: account.address }),
    ]);
    const needed = (gas * gasPrice * 5n) / 4n;
    if (balance < needed) throw new RelayerFundsError(account.address, balance, needed);
    const txHash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
    if (receipt.status !== "success") throw new Error(`${functionName} transaction ${txHash} reverted`);
    return { txHash, blockNumber: receipt.blockNumber };
  }

  return {
    address: address.toLowerCase() as Hex,
    chainId: config.evmChainId,
    recorder: account.address.toLowerCase() as Hex,

    async read(intentHash) {
      const state = await publicClient.readContract({ ...contract, functionName: "getIntent", args: [intentHash] });
      return { recorder: state.recorder.toLowerCase() as Hex, routeId: state.routeId, receiptHash: state.receiptHash };
    },

    recordIntent: (intentHash, routeId) => send("recordIntent", [intentHash, routeId]),
    recordReceipt: (intentHash, receiptHash) => send("recordReceipt", [intentHash, receiptHash]),

    async findEvent(kind, intentHash, fromBlock) {
      const event = intentRegistryAbi.find((item) => item.type === "event" && item.name === kind);
      if (!event || event.type !== "event") throw new Error(`ABI has no ${kind} event`);
      const logs = await publicClient.getLogs({ address: contract.address, event, args: { intentHash }, fromBlock, toBlock: "latest" });
      const log = logs.at(-1);
      return log?.transactionHash && log.blockNumber !== null ? { txHash: log.transactionHash, blockNumber: log.blockNumber } : null;
    },
  };
}
