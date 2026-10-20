import "@polkadot/api-augment";
import { ApiPromise, WsProvider } from "@polkadot/api";

export interface SubstrateChainInfo {
  chain: string;
  nodeVersion: string;
  specName: string;
  specVersion: number;
  ss58Format: number;
  tokenSymbol: string;
  tokenDecimals: number;
  bestBlock: number;
  finalizedBlock: number;
}

export interface ConnectOptions {
  timeoutMs?: number;
  /** Reconnect delay for long-running servers. 0 (default) fails fast instead of retrying forever, for scripts. */
  autoReconnectMs?: number;
}

export async function connectSubstrate(wsUrl: string, options: ConnectOptions = {}): Promise<ApiPromise> {
  const { timeoutMs = 30_000, autoReconnectMs = 0 } = options;
  const provider = new WsProvider(wsUrl, autoReconnectMs, {}, timeoutMs);
  // With auto-reconnect the provider connects on construction (calling connect() again throws);
  // otherwise connect explicitly so a bad URL fails fast. Either way, ApiPromise.create with
  // throwOnConnect rejects if the first connection fails.
  if (autoReconnectMs === 0) await provider.connect();
  return ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true });
}

export async function getSubstrateChainInfo(api: ApiPromise): Promise<SubstrateChainInfo> {
  const [chain, nodeVersion, best, finalizedHash] = await Promise.all([
    api.rpc.system.chain(),
    api.rpc.system.version(),
    api.rpc.chain.getHeader(),
    api.rpc.chain.getFinalizedHead(),
  ]);
  const finalized = await api.rpc.chain.getHeader(finalizedHash);
  const decimals = api.registry.chainDecimals[0];
  const symbol = api.registry.chainTokens[0];
  if (decimals === undefined || symbol === undefined) {
    throw new Error("Chain did not report token decimals/symbol");
  }

  return {
    chain: chain.toString(),
    nodeVersion: nodeVersion.toString(),
    specName: api.runtimeVersion.specName.toString(),
    specVersion: api.runtimeVersion.specVersion.toNumber(),
    ss58Format: api.registry.chainSS58 ?? 42,
    tokenSymbol: symbol,
    tokenDecimals: decimals,
    bestBlock: best.number.toNumber(),
    finalizedBlock: finalized.number.toNumber(),
  };
}

export async function getFreeBalance(api: ApiPromise, address: string | Uint8Array): Promise<bigint> {
  const account = await api.query.system.account(address);
  return account.data.free.toBigInt();
}
