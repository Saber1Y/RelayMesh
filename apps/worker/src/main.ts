// RelayMesh watcher: confirms source finality, measures destination balance changes, settles or
// flags intents, expires unsigned ones, and anchors receipt hashes in IntentRegistry.
import { connectSubstrate, createV3ChainReader, createV3PublicClient, assertEvmChainId, SERVER_RPC_TIMEOUT_MS } from "@relaymesh/chains";
import { connectDb } from "@relaymesh/db";
import { loadWorkerConfig } from "./config";
import { jsonLogger as log } from "./log";
import { createRegistryClient } from "./registry";
import { runPass } from "./watcher";

const config = loadWorkerConfig();
const { db, close } = connectDb(config.databaseUrl, { max: 4 });
const api = await connectSubstrate(config.v3.wsUrl, { autoReconnectMs: 2_500, timeoutMs: SERVER_RPC_TIMEOUT_MS });
const evm = createV3PublicClient(config.v3);
await assertEvmChainId(evm, config.v3.evmChainId);

const registry = config.registry ? createRegistryClient(config.v3, evm, config.registry.address, config.registry.privateKey) : null;
log.info("watcher started", {
  ws: config.v3.wsUrl,
  evmChainId: config.v3.evmChainId,
  anchoring: registry ? { contract: registry.address, recorder: registry.recorder } : "disabled (INTENT_REGISTRY_ADDRESS and RELAYER_PRIVATE_KEY not set)",
});

let stopping = false;
let wake: (() => void) | undefined;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    log.info("stopping after the current pass", { signal });
    stopping = true;
    wake?.();
  });
}

const ctx = {
  db,
  chain: createV3ChainReader(api, evm),
  registry,
  log,
  now: () => Math.floor(Date.now() / 1000),
  config: {
    scanBackfillBlocks: config.scanBackfillBlocks,
    maxBlocksPerPass: config.maxBlocksPerPass,
    signedTxLifetimeSeconds: config.signedTxLifetimeSeconds,
  },
};

while (!stopping) {
  const started = Date.now();
  let behind = false;
  try {
    const summary = await runPass(ctx);
    behind = !summary.caughtUp && summary.errors === 0;
    const changed = summary.found + summary.confirmed + summary.settled + summary.flagged + summary.expired + summary.anchored + summary.errors;
    if (changed > 0) log.info("pass", { ...summary, ms: Date.now() - started });
  } catch (error) {
    log.error("pass failed", { error });
  }
  if (stopping) break;
  // A scan that is still behind the finalized head continues immediately.
  if (behind) continue;
  await new Promise<void>((resolve) => {
    wake = resolve;
    setTimeout(resolve, config.pollMs);
  });
}

await api.disconnect();
await close();
log.info("watcher stopped");
