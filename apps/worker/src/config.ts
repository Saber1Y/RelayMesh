import type { Hex } from "viem";
import { z } from "zod";
import { loadPortaldotV3Config, type PortaldotV3Config } from "@relaymesh/chains";

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX_KEY = /^0x[0-9a-fA-F]{64}$/;

const Env = z.object({
  DATABASE_URL: z.string().regex(/^postgres(ql)?:\/\//, "must be a postgres:// URL"),
  WATCHER_POLL_MS: z.coerce.number().int().min(1_000).default(6_000),
  /** On first start, how far behind the finalized head to begin scanning. Must stay inside the node's state window. */
  WATCHER_SCAN_BACKFILL_BLOCKS: z.coerce.number().int().min(0).max(250).default(150),
  WATCHER_MAX_BLOCKS_PER_PASS: z.coerce.number().int().min(1).max(1_000).default(100),
  /**
   * How long after a plan is issued a signed extrinsic could still be included. polkadot.js defaults
   * to a 64-block mortal era (about 6.4 minutes on V3); 30 minutes leaves room for wallets that pick
   * a longer era. An awaiting intent is only expired after this window has been fully scanned.
   */
  WATCHER_SIGNED_TX_LIFETIME_SECONDS: z.coerce.number().int().min(60).default(1_800),
  INTENT_REGISTRY_ADDRESS: z.string().regex(HEX_ADDRESS).optional(),
  RELAYER_PRIVATE_KEY: z.string().regex(HEX_KEY).optional(),
});

export interface WorkerConfig {
  databaseUrl: string;
  v3: PortaldotV3Config;
  pollMs: number;
  scanBackfillBlocks: number;
  maxBlocksPerPass: number;
  signedTxLifetimeSeconds: number;
  /** Registry anchoring is enabled only when both the contract and a relayer key are configured. */
  registry: { address: Hex; privateKey: Hex } | null;
}

export function loadWorkerConfig(env: NodeJS.ProcessEnv = process.env): WorkerConfig {
  const parsed = Env.safeParse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== "")));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid worker configuration: ${issues}`);
  }
  const e = parsed.data;
  if (!!e.INTENT_REGISTRY_ADDRESS !== !!e.RELAYER_PRIVATE_KEY) {
    throw new Error("Set both INTENT_REGISTRY_ADDRESS and RELAYER_PRIVATE_KEY to enable anchoring, or neither to disable it");
  }
  return {
    databaseUrl: e.DATABASE_URL,
    v3: loadPortaldotV3Config(env),
    pollMs: e.WATCHER_POLL_MS,
    scanBackfillBlocks: e.WATCHER_SCAN_BACKFILL_BLOCKS,
    maxBlocksPerPass: e.WATCHER_MAX_BLOCKS_PER_PASS,
    signedTxLifetimeSeconds: e.WATCHER_SIGNED_TX_LIFETIME_SECONDS,
    registry:
      e.INTENT_REGISTRY_ADDRESS && e.RELAYER_PRIVATE_KEY
        ? { address: e.INTENT_REGISTRY_ADDRESS.toLowerCase() as Hex, privateKey: e.RELAYER_PRIVATE_KEY as Hex }
        : null,
  };
}
