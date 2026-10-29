import "server-only";
import { NextResponse } from "next/server";
import { isRelayMeshError, type RelayMeshErrorCode } from "@relaymesh/core";

const STATUS: Record<RelayMeshErrorCode, number> = {
  INVALID_AMOUNT: 400,
  INVALID_ADDRESS: 400,
  INVALID_INTENT: 400,
  INVALID_INPUT: 400,
  UNSUPPORTED_CHAIN: 400,
  UNSUPPORTED_ASSET: 400,
  UNSUPPORTED_ROUTE: 400,
  DEADLINE_INVALID: 400,
  NOT_CANONICAL: 400,
  IDEMPOTENCY_KEY_INVALID: 400,
  CONSTRAINT_VIOLATION: 409,
  INVALID_TRANSITION: 409,
  MISSING_EVIDENCE: 409,
  QUOTE_EXPIRED: 409,
  QUOTE_MISMATCH: 409,
  IDEMPOTENCY_CONFLICT: 409,
  INTEGRITY_ERROR: 500,
  INVALID_BATCH: 500,
};

/** JSON with bigint as decimal strings; the browser never sees a lossy number for an amount. */
export function json(body: unknown, init?: ResponseInit): NextResponse {
  return new NextResponse(JSON.stringify(body, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v)), {
    ...init,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...init?.headers },
  });
}

export interface ApiErrorBody {
  error: { code: string; message: string; field?: string };
}

export function errorResponse(code: string, message: string, status: number, field?: string): NextResponse {
  return json({ error: { code, message, ...(field && { field }) } } satisfies ApiErrorBody, { status });
}

/** Maps domain errors to HTTP. Unexpected errors are logged and returned as 500 without internals. */
export function handleError(error: unknown): NextResponse {
  if (isRelayMeshError(error)) {
    if (error.code === "INTEGRITY_ERROR") console.error("[relaymesh] integrity error", error);
    return errorResponse(error.code, error.message, STATUS[error.code], error.field);
  }
  console.error("[relaymesh] unexpected error", error);
  return errorResponse("INTERNAL", "Unexpected server error", 500);
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

export const HEX16 = /^0x[0-9a-f]{32}$/;
export const HEX32 = /^0x[0-9a-f]{64}$/;
