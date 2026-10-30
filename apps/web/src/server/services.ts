import "server-only";
import type { ApiPromise } from "@polkadot/api";
import type { Hex, PublicClient } from "viem";
import { connectSubstrate, createBscClient, createV3NativeClient, loadPortaldotBridgeConfig, loadPortaldotV3Config, SERVER_RPC_TIMEOUT_MS } from "@relaymesh/chains";
import { connectDb, type DbHandle } from "@relaymesh/db";
import { parseDecimalAmount } from "@relaymesh/core";
import { IBridgeProvider, V3SubstrateToEvmProvider, type RouteProvider, type ServiceFeeConfig } from "@relaymesh/routes";

// Long-lived connections are cached on globalThis so Next.js dev reloads do not leak sockets.
const cache = globalThis as typeof globalThis & {
  __relaymeshDb?: DbHandle;
  __relaymeshApi?: Promise<ApiPromise>;
  __relaymeshMainnetApi?: Promise<ApiPromise>;
  __relaymeshBsc?: PublicClient;
};

export const v3Config = loadPortaldotV3Config();
export const bridgeConfig = loadPortaldotBridgeConfig();

export function getDb(): DbHandle["db"] {
  if (!cache.__relaymeshDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set (see .env.example)");
    cache.__relaymeshDb = connectDb(url);
  }
  return cache.__relaymeshDb.db;
}

export function getSubstrateApi(): Promise<ApiPromise> {
  if (!cache.__relaymeshApi) {
    cache.__relaymeshApi = connectSubstrate(v3Config.wsUrl, { autoReconnectMs: 2_500, timeoutMs: SERVER_RPC_TIMEOUT_MS }).catch((error: unknown) => {
      // Do not cache a failed connection; the next request retries.
      cache.__relaymeshApi = undefined;
      throw error;
    });
  }
  return cache.__relaymeshApi;
}

/** Portaldot mainnet, for checking bridge deposits. Connected on first use only. */
export function getMainnetApi(): Promise<ApiPromise> {
  if (!cache.__relaymeshMainnetApi) {
    cache.__relaymeshMainnetApi = connectSubstrate(bridgeConfig.mainnetWsUrl, { autoReconnectMs: 2_500, timeoutMs: SERVER_RPC_TIMEOUT_MS }).catch((error: unknown) => {
      cache.__relaymeshMainnetApi = undefined;
      throw error;
    });
  }
  return cache.__relaymeshMainnetApi;
}

export function getBscClient(): PublicClient {
  cache.__relaymeshBsc ??= createBscClient(bridgeConfig);
  return cache.__relaymeshBsc;
}

/**
 * RelayMesh's per-transfer fee: RELAYMESH_FEE in tPOT (for example 0.2), paid to the account behind
 * RELAYMESH_FEE_RECIPIENT, the relayer that pays for anchoring. Both unset means no fee; a half or
 * malformed setting is a startup error rather than a silently free route.
 */
export const serviceFeeConfig: ServiceFeeConfig | null = (() => {
  const amount = process.env.RELAYMESH_FEE?.trim();
  const recipient = process.env.RELAYMESH_FEE_RECIPIENT?.trim();
  if (!amount && !recipient) return null;
  if (!amount || !recipient || !/^0x[0-9a-fA-F]{40}$/.test(recipient)) {
    throw new Error("Set both RELAYMESH_FEE (tPOT, e.g. 0.2) and RELAYMESH_FEE_RECIPIENT (the relayer's 0x address), or neither");
  }
  return { amount: parseDecimalAmount(amount, 14, "RELAYMESH_FEE"), recipient: recipient as Hex };
})();

export async function getProviders(): Promise<RouteProvider[]> {
  const api = await getSubstrateApi();
  return [new V3SubstrateToEvmProvider(createV3NativeClient(api), serviceFeeConfig), new IBridgeProvider()];
}

/** Provider list without touching the network, for status display. */
export function describeProviders(): { id: string; name: string; description: string; status: ReturnType<RouteProvider["status"]> }[] {
  const ibridge = new IBridgeProvider();
  return [
    {
      id: "portaldot-v3-native",
      name: "PortalDot V3 native transfer",
      description: "Substrate account to EVM address on the V3 testnet, via Revive account mapping.",
      status: { available: true },
    },
    { id: ibridge.id, name: ibridge.name, description: ibridge.description, status: ibridge.status() },
  ];
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** ReceiptBatchRegistry, from the same environment the watcher anchors with; null when not deployed. */
export function batchRegistryAddress(): Hex | null {
  const address = process.env.RECEIPT_BATCH_REGISTRY_ADDRESS;
  return address && /^0x[0-9a-fA-F]{40}$/.test(address) ? (address.toLowerCase() as Hex) : null;
}
