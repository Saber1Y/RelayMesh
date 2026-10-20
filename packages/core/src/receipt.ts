import type { Hex } from "viem";
import { canonicalJson, hashCanonical } from "./canonical";
import type { ChainId } from "./chains";
import { RelayMeshError } from "./errors";
import { hashIntent, type Intent } from "./intent";
import type { Quote } from "./quote";
import { currentStatus, type Evidence, type IntentStatus, type StatusEvent, type VerificationMode } from "./status";

export const RECEIPT_HASH_DOMAIN = "relaymesh.receipt.v1";

export interface ReceiptLeg {
  chain: ChainId;
  asset: string;
  txHash: Hex | null;
  blockNumber: bigint | null;
  blockHash: Hex | null;
  finalized: boolean;
  /** How this leg was observed, e.g. "substrate_extrinsic_events"; null if not observed yet. */
  verifiedBy: string | null;
}

export interface Receipt {
  version: 1;
  intentId: Hex;
  intentHash: Hex;
  status: IntentStatus;
  verificationMode: VerificationMode | null;
  route: { provider: string; routeId: string; quoteId: string };
  source: ReceiptLeg & { requester: string; amount: bigint };
  destination: ReceiptLeg & { recipient: string; expectedOutput: bigint; observedAmount: bigint | null };
  timeline: { seq: number; status: IntentStatus; at: number; reason: string }[];
}

export interface BuildReceiptInput {
  intent: Intent;
  intentHash: Hex;
  quote: Quote;
  history: readonly StatusEvent[];
}

function latestEvidence(history: readonly StatusEvent[], kind: Evidence["kind"]): Evidence | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const evidence = history[i]?.evidence;
    if (evidence?.kind === kind) return evidence;
  }
  return undefined;
}

function leg(chain: ChainId, asset: string, evidence: Evidence | undefined): ReceiptLeg {
  return {
    chain,
    asset,
    txHash: evidence?.txHash ?? null,
    blockNumber: evidence?.blockNumber ?? null,
    blockHash: evidence?.blockHash ?? null,
    finalized: evidence?.finalized ?? false,
    verifiedBy: evidence?.method ?? null,
  };
}

/** Builds a receipt from recorded facts only. Works for any status; fields not yet observed are null. */
export function buildReceipt({ intent, intentHash, quote, history }: BuildReceiptInput): Receipt {
  if (hashIntent(intent) !== intentHash) throw new RelayMeshError("INTEGRITY_ERROR", "intentHash does not match the intent");
  if (quote.intentId !== intent.intentId) throw new RelayMeshError("QUOTE_MISMATCH", "Quote belongs to a different intent");
  const status = currentStatus(history);

  const sourceEvidence = latestEvidence(history, "source_transaction");
  const destinationEvidence = latestEvidence(history, "destination_state");
  const settled = history.find((event) => event.status === "SETTLED");

  return {
    version: 1,
    intentId: intent.intentId,
    intentHash,
    status,
    verificationMode: settled?.verificationMode ?? null,
    route: { provider: quote.provider, routeId: quote.routeId, quoteId: quote.quoteId },
    source: {
      ...leg(intent.source.chain, intent.source.asset, sourceEvidence),
      requester: intent.requester,
      amount: intent.source.amount,
    },
    destination: {
      ...leg(intent.destination.chain, intent.destination.asset, destinationEvidence),
      recipient: intent.destination.recipient,
      expectedOutput: quote.expectedOutput,
      observedAmount: destinationEvidence?.amount ?? null,
    },
    timeline: history.map(({ seq, status: s, at, reason }) => ({ seq, status: s, at, reason })),
  };
}

/** Deterministic hash of the receipt; this is the value written to IntentRegistry.recordReceipt. */
export function hashReceipt(receipt: Receipt): Hex {
  return hashCanonical(RECEIPT_HASH_DOMAIN, receipt);
}

/** Canonical JSON export (bigints as decimal strings), suitable for download and independent re-hashing. */
export function serializeReceipt(receipt: Receipt): string {
  return canonicalJson(receipt);
}
