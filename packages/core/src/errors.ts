export type RelayMeshErrorCode =
  | "INVALID_AMOUNT"
  | "INVALID_ADDRESS"
  | "INVALID_INTENT"
  | "UNSUPPORTED_CHAIN"
  | "UNSUPPORTED_ASSET"
  | "UNSUPPORTED_ROUTE"
  | "DEADLINE_INVALID"
  | "NOT_CANONICAL"
  | "INVALID_TRANSITION"
  | "MISSING_EVIDENCE"
  | "QUOTE_EXPIRED"
  | "QUOTE_MISMATCH"
  | "CONSTRAINT_VIOLATION"
  | "IDEMPOTENCY_KEY_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "INTEGRITY_ERROR"
  | "INVALID_BATCH";

export class RelayMeshError extends Error {
  readonly code: RelayMeshErrorCode;
  readonly field: string | undefined;

  constructor(code: RelayMeshErrorCode, message: string, field?: string) {
    super(message);
    this.name = "RelayMeshError";
    this.code = code;
    this.field = field;
  }
}

export function isRelayMeshError(error: unknown, code?: RelayMeshErrorCode): error is RelayMeshError {
  return error instanceof RelayMeshError && (code === undefined || error.code === code);
}
