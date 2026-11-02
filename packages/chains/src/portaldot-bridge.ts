import type { ApiPromise } from "@polkadot/api";
import { createPublicClient, http, parseAbiItem, type Hex, type PublicClient } from "viem";
import type { BridgeDeposit, BridgeFee, BridgePayout, DepositId } from "@relaymesh/core";

/**
 * The public PortalDot bridge (bridge.portaldot.dev): POT on Portaldot mainnet to WPOT on BSC.
 * Defaults are the bridge's published configuration as of 2026-10-29; every value can be overridden
 * from the environment, because the bridge can change them.
 */
export interface PortaldotBridgeConfig {
  mainnetWsUrl: string;
  mainnetExplorerUrl: string;
  /** PortalDot's explorer API, used only to list recent deposits as examples, never to verify. */
  mainnetExplorerApiUrl: string;
  /** Portaldot address users deposit POT into. */
  depositAddress: string;
  bsc: {
    rpcUrl: string;
    explorerUrl: string;
    /** WPOT token contract. */
    token: Hex;
    /** Bridge-held address that pays WPOT out. */
    reserve: Hex;
  };
  fee: BridgeFee;
  /** How long after a deposit to look for its payout. */
  maxPayoutDelaySeconds: number;
}

export function loadPortaldotBridgeConfig(env: NodeJS.ProcessEnv = process.env): PortaldotBridgeConfig {
  const feeBps = env.PORTALDOT_BRIDGE_FEE_BPS ? Number(env.PORTALDOT_BRIDGE_FEE_BPS) : 300;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps >= 10_000) throw new Error(`PORTALDOT_BRIDGE_FEE_BPS must be 0-9999, got "${env.PORTALDOT_BRIDGE_FEE_BPS}"`);
  return {
    mainnetWsUrl: env.PORTALDOT_MAINNET_WS_URL || "wss://live-v3-node.portaldot.dev",
    mainnetExplorerUrl: (env.PORTALDOT_MAINNET_EXPLORER_URL || "https://scanner-live-v3.portaldot.dev").replace(/\/+$/, ""),
    mainnetExplorerApiUrl: (env.PORTALDOT_MAINNET_EXPLORER_API_URL || "https://scanner-live-v3-api.portaldot.dev").replace(/\/+$/, ""),
    depositAddress: env.PORTALDOT_BRIDGE_DEPOSIT_ADDRESS || "5DFSpdFBFU1eXYUKf6887djpFAhrEuzgUEDHHb9ksi2javoo",
    bsc: {
      rpcUrl: env.BSC_RPC_URL || "https://bsc-rpc.publicnode.com",
      explorerUrl: "https://bscscan.com",
      token: (env.PORTALDOT_BRIDGE_BSC_TOKEN || "0x123b057a772d463174fcfbf0f97e6ccdb166a999") as Hex,
      reserve: (env.PORTALDOT_BRIDGE_BSC_RESERVE || "0x3c255f8068b923eaa986ea0c4836702a08ce181a") as Hex,
    },
    fee: { feeBps, sourceDecimals: 14, targetDecimals: 18 },
    maxPayoutDelaySeconds: 72 * 3600,
  };
}

/** Reads a deposit straight from the Portaldot mainnet node: the block body, its finality and its events. */
export async function readBridgeDeposit(api: ApiPromise, id: DepositId): Promise<BridgeDeposit | null> {
  const hash = await api.rpc.chain.getBlockHash(id.block);
  if (hash.isEmpty) return null;
  const [block, finalizedHash] = await Promise.all([api.rpc.chain.getBlock(hash), api.rpc.chain.getFinalizedHead()]);
  const ex = block.block.extrinsics[id.index];
  if (!ex) return null;
  const finalizedNumber = (await api.rpc.chain.getHeader(finalizedHash)).number.toNumber();
  // Canonical at its height and at or below the finalized head means final.
  const finalized = id.block <= finalizedNumber && (await api.rpc.chain.getBlockHash(id.block)).eq(hash);

  // Block time from the body's timestamp.set inherent, which old blocks keep after their state is gone.
  const set = block.block.extrinsics.find((e) => e.method.section === "timestamp" && e.method.method === "set");
  const time = set ? Number(BigInt(set.method.args[0]?.toString() ?? "0") / 1000n) : 0;

  const call = `${ex.method.section}.${ex.method.method}`;
  const isTransfer = ex.method.section === "balances" && /^transfer(KeepAlive|AllowDeath)?$/.test(ex.method.method);
  let success: boolean | null = null;
  try {
    const events = (await (await api.at(hash)).query.system.events()) as unknown as {
      phase: { isApplyExtrinsic: boolean; asApplyExtrinsic: { toNumber(): number } };
      event: { section: string; method: string };
    }[];
    const own = events.filter((e) => e.phase.isApplyExtrinsic && e.phase.asApplyExtrinsic.toNumber() === id.index);
    success = own.some((e) => e.event.section === "system" && e.event.method === "ExtrinsicSuccess");
  } catch {
    // The node discarded this block's state; the result stays unknown rather than guessed.
  }
  return {
    id,
    blockHash: hash.toHex() as Hex,
    extrinsicHash: ex.hash.toHex() as Hex,
    time,
    finalized,
    signer: ex.isSigned ? ex.signer.toString() : null,
    call,
    destination: isTransfer ? (ex.method.args[0]?.toString() ?? null) : null,
    amount: isTransfer ? BigInt(ex.method.args[1]?.toString() ?? "0") : null,
    success,
  };
}

export function createBscClient(config: PortaldotBridgeConfig): PublicClient {
  return createPublicClient({ transport: http(config.bsc.rpcUrl, { retryCount: 4, retryDelay: 1_500, timeout: 60_000 }) });
}

const TRANSFER = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");
/** Public BSC nodes cap a log search at 50,000 blocks. */
const BSC_LOG_SPAN = 49_999n;
/**
 * A block time faster than BSC's (0.75 s in October 2026, 0.45 s since). It only sizes the first step
 * back and how far past the deposit to search; where the search starts is found from block timestamps.
 */
const BSC_FAST_BLOCK_SECONDS = 0.4;

/**
 * The public BSC endpoint balances requests across nodes, and some of them answer a search of older
 * blocks with no logs at all: on 2026-10-29 the same search came back empty 7 times in 12, and on
 * 2026-11-02 about 4 times in 5. A log that is returned is real, since it names its transaction, so
 * each search is sent several times at once and the answers merged, and an empty answer is only
 * believed after every attempt in every round comes back empty. A missed payout is worse than a slow
 * check: the search would go on to match a later payout of the same amount to this deposit.
 */
const LOG_SEARCH_ATTEMPTS = 6;
const LOG_SEARCH_ROUNDS = 4;

async function searchLogs<T extends { transactionHash: Hex; logIndex: number }>(search: () => Promise<T[]>): Promise<T[]> {
  let answered = false;
  let firstError: unknown;
  for (let round = 0; round < LOG_SEARCH_ROUNDS; round++) {
    const answers = await Promise.allSettled(Array.from({ length: LOG_SEARCH_ATTEMPTS }, search));
    const found = answers.flatMap((a) => (a.status === "fulfilled" ? [a.value] : []));
    firstError ??= answers.find((a): a is PromiseRejectedResult => a.status === "rejected")?.reason;
    answered ||= found.length > 0;
    const logs = found.flat();
    if (logs.length > 0) {
      const unique = new Map<string, T>();
      for (const log of logs) unique.set(`${log.transactionHash}:${log.logIndex}`, log);
      return [...unique.values()];
    }
  }
  if (!answered) throw firstError;
  return [];
}

/**
 * The first block with a timestamp at or after `time` (the head when none is). Found from the blocks'
 * own timestamps rather than an assumed block time, which BSC has changed: with 0.45 s blocks, a search
 * that assumed 0.5 s started after the deposit and missed payouts made soon after it. Steps back from
 * the head, doubling the step until it passes `time`, then bisects: about twenty block reads.
 */
export async function firstBlockAtOrAfter(
  client: Pick<PublicClient, "getBlock">,
  time: number,
  head: { number: bigint; timestamp: number },
): Promise<bigint> {
  if (time > head.timestamp) return head.number;
  const timestampOf = async (blockNumber: bigint) => Number((await client.getBlock({ blockNumber })).timestamp);
  let hi = head.number; // timestamp >= time
  let step = BigInt(Math.ceil((head.timestamp - time) / BSC_FAST_BLOCK_SECONDS)) + 1n;
  let lo = hi > step ? hi - step : 0n;
  while (lo > 0n && (await timestampOf(lo)) >= time) {
    hi = lo;
    step *= 2n;
    lo = lo > step ? lo - step : 0n;
  }
  if (lo === 0n && (await timestampOf(0n)) >= time) return 0n;
  // Now timestamp(lo) < time <= timestamp(hi).
  while (hi - lo > 1n) {
    const mid = (lo + hi) / 2n;
    if ((await timestampOf(mid)) >= time) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * WPOT payouts from the bridge's reserve of exactly `amount`, from the deposit time onwards. Stops at
 * the first match, so a paid-out transfer costs one or two searches; a pending one searches the whole
 * window up to now.
 */
export async function findBridgePayouts(
  client: PublicClient,
  config: PortaldotBridgeConfig,
  query: { after: number; amount: bigint; recipient?: Hex | null },
): Promise<BridgePayout[]> {
  const [head, finalized] = await Promise.all([client.getBlock(), client.getBlock({ blockTag: "finalized" })]);
  let from = await firstBlockAtOrAfter(client, query.after, { number: head.number, timestamp: Number(head.timestamp) });
  const last = from + BigInt(Math.ceil(config.maxPayoutDelaySeconds / BSC_FAST_BLOCK_SECONDS));
  const until = last < head.number ? last : head.number;
  const found: BridgePayout[] = [];
  while (from <= until) {
    const to = from + BSC_LOG_SPAN < until ? from + BSC_LOG_SPAN : until;
    const logs = await searchLogs(() =>
      client.getLogs({
        address: config.bsc.token,
        event: TRANSFER,
        args: { from: config.bsc.reserve, ...(query.recipient && { to: query.recipient }) },
        fromBlock: from,
        toBlock: to,
      }),
    );
    for (const log of logs) {
      if (log.args.value !== query.amount || !log.args.to) continue;
      const block = await client.getBlock({ blockNumber: log.blockNumber });
      const time = Number(block.timestamp);
      if (time < query.after) continue;
      found.push({ txHash: log.transactionHash, blockNumber: log.blockNumber, time, recipient: log.args.to, amount: log.args.value, finalized: log.blockNumber <= finalized.number });
    }
    if (found.length > 0) break;
    from = to + 1n;
  }
  return found;
}
