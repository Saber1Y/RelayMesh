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

export async function connectSubstrate(wsUrl: string, timeoutMs = 30_000): Promise<ApiPromise> {
  // autoConnectMs = 0 so a bad endpoint fails fast instead of retrying forever.
  const provider = new WsProvider(wsUrl, 0, {}, timeoutMs);
  await provider.connect();
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
