import { describe, expect, it } from "vitest";
import { convertDecimals, formatBaseUnits, parseBaseUnits, parseDecimalAmount } from "./amount.js";
import { isRelayMeshError } from "./errors.js";

describe("amounts", () => {
  it("parses decimal strings exactly, without floating point", () => {
    expect(parseDecimalAmount("1", 14)).toBe(100_000_000_000_000n);
    expect(parseDecimalAmount("0.1", 18)).toBe(100_000_000_000_000_000n);
    // 0.1 + 0.2 style inputs stay exact
    expect(parseDecimalAmount("0.30000000000000004", 18)).toBe(300_000_000_000_000_040n);
    expect(parseDecimalAmount("123456789.00000000000001", 14)).toBe(12_345_678_900_000_000_000_001n);
  });

  it("rejects excess precision, signs, exponents and junk", () => {
    for (const bad of ["0.000000000000001", "-1", "1e3", "1.", ".5", "01", "abc", ""]) {
      expect(() => parseDecimalAmount(bad, 14), bad).toThrow();
    }
    try {
      parseDecimalAmount("1.000000000000001", 14);
    } catch (error) {
      expect(isRelayMeshError(error, "INVALID_AMOUNT")).toBe(true);
    }
  });

  it("parses base-unit integer strings only", () => {
    expect(parseBaseUnits("0")).toBe(0n);
    expect(parseBaseUnits("99998479235636654")).toBe(99_998_479_235_636_654n);
    for (const bad of ["1.5", "-1", "007", " 1", "1e18"]) expect(() => parseBaseUnits(bad), bad).toThrow();
  });

  it("formats base units without trailing zeros", () => {
    expect(formatBaseUnits(100_000_000_000_000n, 14)).toBe("1");
    expect(formatBaseUnits(10_000_000_000_000n, 14)).toBe("0.1");
    expect(formatBaseUnits(1n, 18)).toBe("0.000000000000000001");
    expect(formatBaseUnits(0n, 14)).toBe("0");
    expect(formatBaseUnits(-15n, 1)).toBe("-1.5");
  });

  it("round-trips parse and format", () => {
    for (const value of ["0", "1", "0.5", "1234.00000000000001"]) {
      expect(formatBaseUnits(parseDecimalAmount(value, 14), 14)).toBe(value);
    }
  });

  it("converts between the V3 native (14) and EVM (18) precisions", () => {
    // nativeToEthRatio on V3 is 10^4
    expect(convertDecimals(1n, 14, 18)).toEqual({ value: 10_000n, remainder: 0n });
    expect(convertDecimals(10_001n, 18, 14)).toEqual({ value: 1n, remainder: 1n });
    expect(convertDecimals(5n, 18, 18)).toEqual({ value: 5n, remainder: 0n });
  });
});
