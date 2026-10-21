import { describe, expect, it } from "vitest";
import { scanRanges } from "./watcher";

const NOW = 1_800_000_000;
const LIFETIME = 1_800;

describe("scanRanges", () => {
  it("returns nothing when no plans are pending", () => {
    expect(scanRanges([], 10_000n, NOW, LIFETIME)).toEqual([]);
  });

  it("keeps a window that is still open running to the finalized head", () => {
    // Plan 60 s old: start = 10_000 - ceil(60 / 3) - 50.
    expect(scanRanges([NOW - 60], 10_000n, NOW, LIFETIME)).toEqual([{ start: 9_930n, end: 10_000n }]);
  });

  it("bounds a closed window with slow-block ends and fast-block starts", () => {
    // Created 1 day ago: start = 100_000 - 86_400 / 3 - 50; the window closed 84_600 s ago, 7_050 blocks back at 12 s, plus 50.
    expect(scanRanges([NOW - 86_400], 100_000n, NOW, LIFETIME)).toEqual([{ start: 71_150n, end: 93_000n }]);
  });

  it("merges overlapping windows and keeps separate ones apart", () => {
    const ranges = scanRanges([NOW - 86_400, NOW - 86_300, NOW - 60], 100_000n, NOW, LIFETIME);
    expect(ranges).toHaveLength(2);
    expect(ranges[0]?.end).toBeLessThan(ranges[1]?.start ?? 0n);
    expect(ranges[1]?.end).toBe(100_000n);
  });

  it("never returns negative heights", () => {
    expect(scanRanges([NOW - 1_000_000], 100n, NOW, LIFETIME)[0]?.start).toBe(0n);
  });
});
