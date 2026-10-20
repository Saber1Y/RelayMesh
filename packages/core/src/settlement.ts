import type { Intent } from "./intent.js";
import type { Quote } from "./quote.js";
import type { Evidence } from "./status.js";

export type SettlementDecision =
  | { decision: "settled"; reason: string }
  | { decision: "pending"; reason: string }
  | { decision: "needs_review"; reason: string };

export interface SettlementInput {
  intent: Intent;
  quote: Quote;
  /** RelayMesh's own read of the destination chain, if any. */
  destination?: Evidence;
  /** What the route provider says, if it reports status. */
  providerStatus?: "pending" | "completed" | "failed";
}

/**
 * Decides what the watcher may conclude from the evidence it has. It never declares success when
 * independent chain evidence and the provider disagree; that becomes needs_review with both kept.
 */
export function assessSettlement({ intent, quote, destination, providerStatus }: SettlementInput): SettlementDecision {
  const required = intent.constraints.minOutput ?? quote.expectedOutput;
  const observed = destination?.kind === "destination_state" ? destination.amount : undefined;

  if (destination && destination.chain !== intent.destination.chain) {
    return { decision: "needs_review", reason: `destination evidence read from ${destination.chain}, expected ${intent.destination.chain}` };
  }

  if (observed === undefined || observed === 0n) {
    if (providerStatus === "completed") {
      return { decision: "needs_review", reason: "provider reports completion but no funds were observed on the destination chain" };
    }
    if (providerStatus === "failed") {
      return { decision: "needs_review", reason: "provider reports failure after the source transaction confirmed" };
    }
    return { decision: "pending", reason: "no destination funds observed yet" };
  }

  if (observed < required) {
    return { decision: "needs_review", reason: `observed ${observed} is below the required ${required}` };
  }
  if (providerStatus === "failed") {
    return { decision: "needs_review", reason: "funds observed on destination but provider reports failure" };
  }
  if (!destination?.finalized) {
    return { decision: "pending", reason: "destination funds observed but not yet finalized" };
  }
  return { decision: "settled", reason: `observed ${observed} on ${intent.destination.chain}, required ${required}` };
}
