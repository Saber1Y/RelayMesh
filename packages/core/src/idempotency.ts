import type { Hex } from "viem";
import { hashCanonical } from "./canonical";
import { RelayMeshError } from "./errors";

export const REQUEST_HASH_DOMAIN = "relaymesh.request.v1";

const KEY_FORMAT = /^[A-Za-z0-9_-]{8,128}$/;

export interface IdempotencyRecord {
  key: string;
  requestHash: Hex;
  intentId: Hex;
}

export type IdempotencyResolution = { kind: "new" } | { kind: "replay"; intentId: Hex };

export function assertIdempotencyKey(key: string): void {
  if (!KEY_FORMAT.test(key)) {
    throw new RelayMeshError("IDEMPOTENCY_KEY_INVALID", "Idempotency key must be 8-128 characters of A-Z, a-z, 0-9, _ or -", "idempotencyKey");
  }
}

/** Hash of the raw request body, so a replay with a different body under the same key is detected. */
export function hashRequest(body: unknown): Hex {
  return hashCanonical(REQUEST_HASH_DOMAIN, body);
}

/**
 * Same key + same body returns the original intent; same key + different body is a conflict.
 * The caller must store the record atomically (unique key constraint) for this to be race-free.
 */
export function resolveIdempotency(existing: IdempotencyRecord | undefined, key: string, requestHash: Hex): IdempotencyResolution {
  assertIdempotencyKey(key);
  if (!existing) return { kind: "new" };
  if (existing.key !== key) throw new RelayMeshError("INTEGRITY_ERROR", "Looked-up idempotency record has a different key");
  if (existing.requestHash !== requestHash) {
    throw new RelayMeshError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with a different request", "idempotencyKey");
  }
  return { kind: "replay", intentId: existing.intentId };
}
