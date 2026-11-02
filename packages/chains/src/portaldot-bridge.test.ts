import { describe, expect, it } from "vitest";
import { firstBlockAtOrAfter } from "./portaldot-bridge";

/** A chain whose block n was produced at genesis + n × blockSeconds, counting how many blocks were read. */
function chain(blockSeconds: number, headNumber: bigint, genesis = 1_700_000_000) {
  const timestampOf = (n: bigint) => genesis + Math.floor(Number(n) * blockSeconds);
  const reads = { count: 0 };
  const client = {
    getBlock: async ({ blockNumber }: { blockNumber?: bigint } = {}) => {
      reads.count++;
      return { timestamp: BigInt(timestampOf(blockNumber ?? headNumber)) };
    },
  } as unknown as Parameters<typeof firstBlockAtOrAfter>[0];
  return { client, reads, timestampOf, head: { number: headNumber, timestamp: timestampOf(headNumber) } };
}

describe("firstBlockAtOrAfter", () => {
  it.each([0.45, 0.75, 0.3, 3])("finds the exact first block at or after a time, at %s s per block", async (blockSeconds) => {
    const { client, reads, timestampOf, head } = chain(blockSeconds, 131_000_000n);
    for (const hoursAgo of [0.5, 1.6, 22, 72]) {
      const time = head.timestamp - Math.round(hoursAgo * 3600) + 0.2 * (hoursAgo % 1);
      const block = await firstBlockAtOrAfter(client, time, head);
      expect(timestampOf(block)).toBeGreaterThanOrEqual(time);
      expect(timestampOf(block - 1n)).toBeLessThan(time);
    }
    expect(reads.count).toBeLessThan(4 * 40);
  });

  it("returns the head for a time after it, and block 0 for one before the chain", async () => {
    const { client, head } = chain(0.45, 1_000n);
    expect(await firstBlockAtOrAfter(client, head.timestamp + 10, head)).toBe(1_000n);
    expect(await firstBlockAtOrAfter(client, 1_600_000_000, head)).toBe(0n);
  });

  it("starts before a payout made soon after the deposit, which a 0.5 s assumption missed", async () => {
    // 876352-1: deposited 12:52 UTC, paid 1.6 h later, checked about 24 h after the deposit, on 0.45 s blocks.
    const { client, timestampOf, head } = chain(0.45, 131_050_000n);
    const deposit = head.timestamp - 24 * 3600;
    const payoutBlock = head.number - BigInt(Math.round((24 - 1.6) * 3600 / 0.45));
    const assumed = head.number - BigInt(Math.ceil((head.timestamp - deposit) / 0.5));
    expect(assumed).toBeGreaterThan(payoutBlock); // the old start skipped the payout
    const start = await firstBlockAtOrAfter(client, deposit, head);
    expect(start).toBeLessThanOrEqual(payoutBlock);
    expect(timestampOf(start)).toBeGreaterThanOrEqual(deposit);
  });
});
