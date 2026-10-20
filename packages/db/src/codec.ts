import type { Hex } from "viem";
import { isChainId, RelayMeshError, type ChainId, type Evidence, type Fee } from "@relaymesh/core";

// JSONB cannot hold bigint, so amounts are stored as decimal strings and validated on the way back.

export interface FeeJson {
  kind: Fee["kind"];
  chain: string;
  asset: string;
  amount: string;
  basis: Fee["basis"];
}

export interface EvidenceJson {
  kind: Evidence["kind"];
  chain?: string;
  method: string;
  txHash?: string;
  blockNumber?: string;
  blockHash?: string;
  finalized: boolean;
  amount?: string;
  observedAt: number;
  details?: Record<string, string>;
}

const INTEGER = /^(0|[1-9]\d*)$/;
const HEX32 = /^0x[0-9a-f]{64}$/;

function corrupt(what: string): never {
  throw new RelayMeshError("INTEGRITY_ERROR", `Stored ${what} is malformed`);
}

function toBigInt(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !INTEGER.test(value)) corrupt(what);
  return BigInt(value);
}

function toChainId(value: unknown, what: string): ChainId {
  if (typeof value !== "string" || !isChainId(value)) corrupt(what);
  return value;
}

export function feesToJson(fees: readonly Fee[]): FeeJson[] {
  return fees.map((fee) => ({ ...fee, amount: fee.amount.toString() }));
}

export function feesFromJson(value: unknown): Fee[] {
  if (!Array.isArray(value)) corrupt("fees");
  return value.map((raw: unknown) => {
    const fee = raw as Partial<FeeJson>;
    if (!fee || !["network", "provider", "storage_deposit"].includes(fee.kind ?? "")) corrupt("fee kind");
    if (!["estimate", "quoted"].includes(fee.basis ?? "") || typeof fee.asset !== "string") corrupt("fee");
    return {
      kind: fee.kind as Fee["kind"],
      chain: toChainId(fee.chain, "fee chain"),
      asset: fee.asset,
      amount: toBigInt(fee.amount, "fee amount"),
      basis: fee.basis as Fee["basis"],
    };
  });
}

export function evidenceToJson(evidence: Evidence): EvidenceJson {
  const { blockNumber, amount, ...rest } = evidence;
  return {
    ...rest,
    ...(blockNumber !== undefined && { blockNumber: blockNumber.toString() }),
    ...(amount !== undefined && { amount: amount.toString() }),
  };
}

export function evidenceFromJson(value: unknown): Evidence {
  const raw = value as Partial<EvidenceJson> | null;
  if (!raw || typeof raw !== "object") corrupt("evidence");
  if (!["source_transaction", "destination_state", "provider_status"].includes(raw.kind ?? "")) corrupt("evidence kind");
  if (typeof raw.method !== "string" || typeof raw.finalized !== "boolean" || !Number.isSafeInteger(raw.observedAt)) {
    corrupt("evidence");
  }
  if (raw.txHash !== undefined && !HEX32.test(raw.txHash)) corrupt("evidence txHash");
  if (raw.blockHash !== undefined && !HEX32.test(raw.blockHash)) corrupt("evidence blockHash");
  if (raw.details !== undefined && (typeof raw.details !== "object" || Object.values(raw.details).some((v) => typeof v !== "string"))) {
    corrupt("evidence details");
  }

  return {
    kind: raw.kind as Evidence["kind"],
    method: raw.method,
    finalized: raw.finalized,
    observedAt: raw.observedAt as number,
    ...(raw.chain !== undefined && { chain: toChainId(raw.chain, "evidence chain") }),
    ...(raw.txHash !== undefined && { txHash: raw.txHash as Hex }),
    ...(raw.blockHash !== undefined && { blockHash: raw.blockHash as Hex }),
    ...(raw.blockNumber !== undefined && { blockNumber: toBigInt(raw.blockNumber, "evidence blockNumber") }),
    ...(raw.amount !== undefined && { amount: toBigInt(raw.amount, "evidence amount") }),
    ...(raw.details !== undefined && { details: raw.details }),
  };
}
