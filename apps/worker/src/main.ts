// RelayMesh watcher: confirms source finality, measures destination balance changes, settles or
// flags intents, expires unsigned ones, and anchors receipt hashes in batches (ReceiptBatchLog or ReceiptBatchRegistry).
import { connectSubstrate, createV3ChainReader, createV3PublicClient, assertEvmChainId, SERVER_RPC_TIMEOUT_MS } from "@relaymesh/chains";
import { connectDb } from "@relaymesh/db";
import { loadWorkerConfig } from "./config";
import { jsonLogger as log } from "./log";
import { createBatchRegistryClient, type BatchRegistryClient } from "./registry";
import { runPass } from "./watcher";

const config = loadWorkerConfig();
const { db, close } = connectDb(config.databaseUrl, { max: 4 });
const api = await connectSubstrate(config.v3.wsUrl, { autoReconnectMs: 2_500, timeoutMs: SERVER_RPC_TIMEOUT_MS });
const evm = createV3PublicClient(config.v3);
await assertEvmChainId(evm, config.v3.evmChainId);

let registry: BatchRegistryClient | null = config.registry ? createBatchRegistryClient(config.v3, evm, config.registry.address, config.registry.privateKey, config.registry.kind) : null;
// A relayer key without a batch registry is a server upgraded from per-intent IntentRegistry writes.
let anchoringOff = process.env.RELAYER_PRIVATE_KEY
  ? "no RECEIPT_BATCH_LOG_ADDRESS or RECEIPT_BATCH_REGISTRY_ADDRESS set; IntentRegistry is no longer written"
  : "no batch contract address and no RELAYER_PRIVATE_KEY set";
if (registry) {
  // Writes from any account but the contract's recorder revert, so a wrong key would only burn fees.
  const contractRecorder = await registry.contractRecorder().catch((error: unknown) => {
    log.warn("could not read the batch contract's recorder; writes are still simulated before sending", { error });
    return null;
  });
  if (contractRecorder && contractRecorder !== registry.recorder) {
    anchoringOff = `RELAYER_PRIVATE_KEY is for ${registry.recorder}, but the batch contract's recorder is ${contractRecorder}`;
    registry = null;
  }
}
log.info("watcher started", {
  ws: config.v3.wsUrl,
  evmChainId: config.v3.evmChainId,
  anchoring: registry ? { contract: registry.address, kind: registry.kind, recorder: registry.recorder, ...config.batching } : `disabled (${anchoringOff})`,
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
    batching: config.batching,
  },
};

// A node connection can go bad in a way auto-reconnect does not cure: every block read fails with
// "disconnected (1006)" while a fresh connection works (seen on V3 on 2026-10-29, for 13 hours).
// After this many passes in a row that fail without moving the scan, exit so PM2 starts a fresh process.
const STALLED_PASSES_BEFORE_RESTART = 12;
let stalledPasses = 0;
let lastScannedTo: bigint | null = null;

while (!stopping) {
  const started = Date.now();
  let behind = false;
  let stalled: boolean;
  try {
    const summary = await runPass(ctx);
    behind = !summary.caughtUp && summary.errors === 0;
    stalled = summary.errors > 0 && !summary.caughtUp && summary.scannedTo === lastScannedTo;
    lastScannedTo = summary.scannedTo;
    const changed = summary.found + summary.confirmed + summary.settled + summary.flagged + summary.expired + summary.anchored + summary.errors;
    if (changed > 0) log.info("pass", { ...summary, ms: Date.now() - started });
  } catch (error) {
    stalled = true;
    log.error("pass failed", { error });
  }
  stalledPasses = stalled ? stalledPasses + 1 : 0;
  if (stalledPasses >= STALLED_PASSES_BEFORE_RESTART) {
    log.error("restarting: passes keep failing without progress", { passes: stalledPasses, scannedTo: lastScannedTo?.toString() ?? null });
    process.exitCode = 1;
    break;
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
