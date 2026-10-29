import { describe, expect, it } from "vitest";
import { firstBlockAtOrAfter, mergeRanges } from "./watcher";

describe("mergeRanges", () => {
  it("returns nothing for no ranges", () => {
    expect(mergeRanges([])).toEqual([]);
  });

  it("sorts, merges overlapping and touching ranges, and keeps separate ones apart", () => {
    const ranges = [
      { start: 500n, end: 600n },
      { start: 10n, end: 20n },
      { start: 15n, end: 30n },
      { start: 31n, end: 40n },
    ];
    expect(mergeRanges(ranges)).toEqual([
      { start: 10n, end: 40n },
      { start: 500n, end: 600n },
    ]);
  });

  it("does not modify its input", () => {
    const input = [{ start: 1n, end: 5n }, { start: 3n, end: 9n }];
    mergeRanges(input);
    expect(input[0]).toEqual({ start: 1n, end: 5n });
  });
});

describe("firstBlockAtOrAfter", () => {
  const GENESIS = 1_790_000_000;
  /** A chain whose block n was produced at `time(n)`, counting the reads the search makes. */
  function chain(time: (n: bigint) => number) {
    const reads: bigint[] = [];
    return {
      reads,
      timeOf: async (n: bigint) => {
        reads.push(n);
        return time(n);
      },
    };
  }
  const regular = (n: bigint) => GENESIS + Number(n) * 6;

  it("finds the exact block on a regular chain, even far back, in a bounded number of reads", async () => {
    const c = chain(regular);
    expect(await firstBlockAtOrAfter(GENESIS + 122_911 * 6, 160_000n, c.timeOf)).toBe(122_911n);
    expect(await firstBlockAtOrAfter(GENESIS + 122_911 * 6 - 5, 160_000n, c.timeOf)).toBe(122_911n);
    // Two lookups ~37,000 blocks back: about 11 strides each to get below, then a few to land.
    expect(c.reads.length).toBeLessThan(40);
  });

  it("stays logarithmic when block times are irregular", async () => {
    // A long stall after block 1_000 (an hour without blocks), then 2 s blocks.
    const c = chain((n) => (n <= 1_000n ? GENESIS + Number(n) * 6 : GENESIS + 6_000 + 3_600 + Number(n - 1_000n) * 2));
    const target = GENESIS + 6_000 + 3_600 + 50_000 * 2;
    expect(await firstBlockAtOrAfter(target, 200_000n, c.timeOf)).toBe(51_000n);
    expect(c.reads.length).toBeLessThan(40);
  });

  it("returns the head plus one for a time no block has reached yet", async () => {
    const c = chain(regular);
    expect(await firstBlockAtOrAfter(GENESIS + 1_000_000, 1_000n, c.timeOf)).toBe(1_001n);
    expect(c.reads).toEqual([1_000n]);
  });

  it("finds a recent time without reading anywhere near the start of the chain", async () => {
    const c = chain(regular);
    expect(await firstBlockAtOrAfter(GENESIS + 231_000 * 6, 235_566n, c.timeOf)).toBe(231_000n);
    expect(c.reads.every((n) => n > 200_000n)).toBe(true);
    expect(c.reads.length).toBeLessThan(20);
  });

  it("returns block 1 for times before the chain started, never genesis", async () => {
    const c = chain(regular);
    expect(await firstBlockAtOrAfter(GENESIS - 100, 1_000n, c.timeOf)).toBe(1n);
    expect(c.reads).not.toContain(0n);
  });
});
