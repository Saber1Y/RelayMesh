import "server-only";
import type { ApiPromise } from "@polkadot/api";
import type { Hex } from "viem";
import { connectSubstrate, createV3NativeClient, loadPortaldotV3Config, SERVER_RPC_TIMEOUT_MS } from "@relaymesh/chains";
import { connectDb, type DbHandle } from "@relaymesh/db";
import { IBridgeProvider, V3SubstrateToEvmProvider, type RouteProvider } from "@relaymesh/routes";

// Long-lived connections are cached on globalThis so Next.js dev reloads do not leak sockets.
const cache = globalThis as typeof globalThis & {
  __relaymeshDb?: DbHandle;
  __relaymeshApi?: Promise<ApiPromise>;
};

export const v3Config = loadPortaldotV3Config();

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

export async function getProviders(): Promise<RouteProvider[]> {
  const api = await getSubstrateApi();
  return [new V3SubstrateToEvmProvider(createV3NativeClient(api)), new IBridgeProvider()];
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
