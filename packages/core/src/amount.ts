import { RelayMeshError } from "./errors";

// All token amounts are integer base units (bigint). Decimal strings are only accepted at the edges
// (user input, display) and are converted exactly, never through floating point.

const BASE_UNITS = /^(0|[1-9]\d*)$/;
const DECIMAL = /^(0|[1-9]\d*)(\.(\d+))?$/;

function assertDecimals(decimals: number): void {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new RelayMeshError("INVALID_AMOUNT", `Unsupported decimals: ${decimals}`);
  }
}

export function parseBaseUnits(value: string, field = "amount"): bigint {
  if (!BASE_UNITS.test(value)) {
    throw new RelayMeshError("INVALID_AMOUNT", `${field} must be a non-negative integer in base units`, field);
  }
  return BigInt(value);
}

/** Converts a human decimal string such as "1.25" into base units. Rejects excess precision. */
export function parseDecimalAmount(value: string, decimals: number, field = "amount"): bigint {
  assertDecimals(decimals);
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new RelayMeshError("INVALID_AMOUNT", `${field} must be a plain decimal number`, field);
  const whole = match[1] ?? "0";
  const fraction = match[3] ?? "";
  if (fraction.length > decimals) {
    throw new RelayMeshError("INVALID_AMOUNT", `${field} has more than ${decimals} decimal places`, field);
  }
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0");
}

/** Formats base units as a decimal string without trailing zeros. */
export function formatBaseUnits(value: bigint, decimals: number): string {
  assertDecimals(decimals);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const fraction = (abs % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}

/**
 * Re-expresses an amount in a different decimal precision. Scaling down truncates and reports the
 * dropped remainder (in the source precision) so callers can decide whether the loss is acceptable.
 */
export function convertDecimals(
  value: bigint,
  fromDecimals: number,
  toDecimals: number,
): { value: bigint; remainder: bigint } {
  assertDecimals(fromDecimals);
  assertDecimals(toDecimals);
  if (toDecimals >= fromDecimals) {
    return { value: value * 10n ** BigInt(toDecimals - fromDecimals), remainder: 0n };
  }
  const divisor = 10n ** BigInt(fromDecimals - toDecimals);
  return { value: value / divisor, remainder: value % divisor };
}
