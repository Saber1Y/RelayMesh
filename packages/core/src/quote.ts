import type { Hex } from "viem";
import type { ChainId } from "./chains";
import { RelayMeshError } from "./errors";
import type { Intent } from "./intent";

export type FeeKind = "network" | "provider" | "storage_deposit";

export interface Fee {
  kind: FeeKind;
  chain: ChainId;
  asset: string;
  amount: bigint;
  /** "estimate" when computed before submission (e.g. payment_queryInfo); "quoted" when the provider committed to it. */
  basis: "estimate" | "quoted";
  /** The account a fee is paid to, for a fee paid in the same signed call (RelayMesh's own fee). */
  recipient?: string;
}

export interface Quote {
  quoteId: string;
  intentId: Hex;
  provider: string;
  routeId: string;
  /** Destination amount in destination-chain base units. */
  expectedOutput: bigint;
  fees: Fee[];
  retrievedAt: number;
  expiresAt: number;
  /** Provider-reported estimate; never a guarantee. */
  estimatedSeconds?: number;
}

/** Sum of fees charged in the intent's source asset, which is what constraints.maxFee limits. */
export function sourceFeeTotal(quote: Quote, intent: Intent): bigint {
  return quote.fees
    .filter((fee) => fee.chain === intent.source.chain && fee.asset === intent.source.asset)
    .reduce((sum, fee) => sum + fee.amount, 0n);
}

/**
 * RelayMesh's own fee: a provider fee in the source asset, paid to a named account in the same signed
 * call as the transfer. It funds anchoring receipts on chain. Null when the quote carries none.
 */
export function serviceFee(quote: Quote): { amount: bigint; recipient: string } | null {
  const fee = quote.fees.find((f) => f.kind === "provider" && f.recipient !== undefined);
  return fee?.recipient ? { amount: fee.amount, recipient: fee.recipient } : null;
}

/** Fees in any other chain/asset cannot be compared against maxFee and must be disclosed separately. */
export function otherFees(quote: Quote, intent: Intent): Fee[] {
  return quote.fees.filter((fee) => fee.chain !== intent.source.chain || fee.asset !== intent.source.asset);
}

/**
 * Throws unless the quote may be shown for signing right now: it belongs to this intent, neither the
 * quote nor the intent deadline has passed, and it satisfies the user's constraints.
 */
export function assertQuoteUsable(quote: Quote, intent: Intent, now: number): void {
  if (quote.intentId !== intent.intentId) {
    throw new RelayMeshError("QUOTE_MISMATCH", "Quote belongs to a different intent");
  }
  if (now >= quote.expiresAt) {
    throw new RelayMeshError("QUOTE_EXPIRED", "Quote has expired; request a fresh quote");
  }
  if (now >= intent.constraints.deadline) {
    throw new RelayMeshError("QUOTE_EXPIRED", "Intent deadline has passed");
  }
  if (quote.expectedOutput <= 0n) {
    throw new RelayMeshError("CONSTRAINT_VIOLATION", "Quote has no positive expected output");
  }
  const { minOutput, maxFee } = intent.constraints;
  if (minOutput !== undefined && quote.expectedOutput < minOutput) {
    throw new RelayMeshError("CONSTRAINT_VIOLATION", "Expected output is below the minimum output constraint", "constraints.minOutput");
  }
  if (maxFee !== undefined && sourceFeeTotal(quote, intent) > maxFee) {
    throw new RelayMeshError("CONSTRAINT_VIOLATION", "Fees exceed the maximum fee constraint", "constraints.maxFee");
  }
}
