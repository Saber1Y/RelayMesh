import { createPublicClient, defineChain, http, type PublicClient } from "viem";
import type { PortaldotV3Config } from "./config.js";

export function portaldotV3EvmChain(config: PortaldotV3Config) {
  return defineChain({
    id: config.evmChainId,
    name: "PortalDot V3 Testnet",
    nativeCurrency: { name: "Test POT", symbol: "tPOT", decimals: 18 },
    rpcUrls: { default: { http: [config.evmRpcUrl] } },
    testnet: true,
  });
}

export function createV3PublicClient(config: PortaldotV3Config): PublicClient {
  return createPublicClient({ chain: portaldotV3EvmChain(config), transport: http(config.evmRpcUrl) });
}

// Guards against pointing the app at the wrong network: the RPC must report the configured chain ID.
export async function assertEvmChainId(client: PublicClient, expected: number): Promise<void> {
  const actual = await client.getChainId();
  if (actual !== expected) {
    throw new Error(`EVM RPC reports chain ID ${actual}, expected ${expected}`);
  }
}
