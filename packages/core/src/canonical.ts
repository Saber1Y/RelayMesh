import { keccak256, stringToBytes, type Hex } from "viem";
import { RelayMeshError } from "./errors.js";

/**
 * Deterministic JSON: object keys sorted, undefined properties omitted, bigint written as a decimal
 * string. Anything without a single unambiguous encoding (non-finite numbers, functions, symbols,
 * Dates, Maps, undefined array items) is rejected rather than silently coerced.
 */
export function canonicalJson(value: unknown): string {
  return encode(value, "$");
}

function encode(value: unknown, path: string): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "bigint":
      return JSON.stringify(value.toString());
    case "number":
      if (!Number.isFinite(value)) throw notCanonical(path, "non-finite number");
      if (!Number.isSafeInteger(value)) throw notCanonical(path, "numbers must be safe integers; use bigint");
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return `[${value
          .map((item, i) => {
            if (item === undefined) throw notCanonical(`${path}[${i}]`, "undefined array item");
            return encode(item, `${path}[${i}]`);
          })
          .join(",")}]`;
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) throw notCanonical(path, "only plain objects are allowed");
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${encode(v, `${path}.${k}`)}`).join(",")}}`;
    }
    default:
      throw notCanonical(path, `unsupported type ${typeof value}`);
  }
}

function notCanonical(path: string, reason: string): RelayMeshError {
  return new RelayMeshError("NOT_CANONICAL", `Cannot canonicalize ${path}: ${reason}`, path);
}

/** keccak256 over `domain + "\n" + canonicalJson(value)`; the domain separates hash types and versions. */
export function hashCanonical(domain: string, value: unknown): Hex {
  if (!/^[a-z0-9.]+$/.test(domain)) throw new RelayMeshError("NOT_CANONICAL", `Invalid hash domain: ${domain}`);
  return keccak256(stringToBytes(`${domain}\n${canonicalJson(value)}`));
}
