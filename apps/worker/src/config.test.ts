import { describe, expect, it } from "vitest";
import { loadWorkerConfig } from "./config";

const BASE = { DATABASE_URL: "postgres://u:p@127.0.0.1:5432/relaymesh" };
const KEY = `0x${"11".repeat(32)}`;
const BATCH_REGISTRY = "0x00000000000000000000000000000000000000AA";

describe("worker configuration", () => {
  it("anchors in batches when the batch registry and relayer key are both set, with default thresholds", () => {
    const config = loadWorkerConfig({ ...BASE, RECEIPT_BATCH_REGISTRY_ADDRESS: BATCH_REGISTRY, RELAYER_PRIVATE_KEY: KEY });
    expect(config.registry).toEqual({ address: BATCH_REGISTRY.toLowerCase(), privateKey: KEY });
    expect(config.batching).toEqual({ size: 20, maxWaitSeconds: 1_800, maxLeaves: 256 });
  });

  it("keeps a server configured for per-intent IntentRegistry anchoring running, with anchoring off", () => {
    const config = loadWorkerConfig({ ...BASE, INTENT_REGISTRY_ADDRESS: "0xfcfc36e3ea951640d1e495a1e671d66c75eb5123", RELAYER_PRIVATE_KEY: KEY });
    expect(config.registry).toBeNull();
  });

  it("rejects a batch registry without a key to pay for it, and inconsistent thresholds", () => {
    expect(() => loadWorkerConfig({ ...BASE, RECEIPT_BATCH_REGISTRY_ADDRESS: BATCH_REGISTRY })).toThrow(/without RELAYER_PRIVATE_KEY/);
    expect(() => loadWorkerConfig({ ...BASE, ANCHOR_BATCH_SIZE: "300" })).toThrow(/ANCHOR_BATCH_MAX_LEAVES/);
    expect(() => loadWorkerConfig({ ...BASE, ANCHOR_BATCH_SIZE: "0" })).toThrow(/ANCHOR_BATCH_SIZE/);
  });

  it("reads batching thresholds from the environment", () => {
    const config = loadWorkerConfig({ ...BASE, ANCHOR_BATCH_SIZE: "5", ANCHOR_BATCH_MAX_WAIT_MINUTES: "10", ANCHOR_BATCH_MAX_LEAVES: "64" });
    expect(config.batching).toEqual({ size: 5, maxWaitSeconds: 600, maxLeaves: 64 });
  });
});
