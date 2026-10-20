export interface PortaldotV3Config {
  wsUrl: string;
  evmRpcUrl: string;
  evmChainId: number;
}

// Defaults are the V3 testnet values confirmed by the PortalDot team on 2026-10-20.
const DEFAULTS: PortaldotV3Config = {
  wsUrl: "wss://test-node-v3.portaldot.dev",
  evmRpcUrl: "https://test-evm-rpc-v3.portaldot.dev",
  evmChainId: 420420777,
};

export function loadPortaldotV3Config(env: NodeJS.ProcessEnv = process.env): PortaldotV3Config {
  const wsUrl = env.PORTALDOT_V3_WS_URL || DEFAULTS.wsUrl;
  const evmRpcUrl = env.PORTALDOT_V3_EVM_RPC_URL || DEFAULTS.evmRpcUrl;
  const evmChainId = env.PORTALDOT_V3_EVM_CHAIN_ID
    ? Number(env.PORTALDOT_V3_EVM_CHAIN_ID)
    : DEFAULTS.evmChainId;

  if (!/^wss?:\/\//.test(wsUrl)) throw new Error(`PORTALDOT_V3_WS_URL must be a ws(s) URL, got "${wsUrl}"`);
  if (!/^https?:\/\//.test(evmRpcUrl)) throw new Error(`PORTALDOT_V3_EVM_RPC_URL must be an http(s) URL, got "${evmRpcUrl}"`);
  if (!Number.isSafeInteger(evmChainId) || evmChainId <= 0) {
    throw new Error(`PORTALDOT_V3_EVM_CHAIN_ID must be a positive integer, got "${env.PORTALDOT_V3_EVM_CHAIN_ID}"`);
  }

  return { wsUrl, evmRpcUrl, evmChainId };
}
