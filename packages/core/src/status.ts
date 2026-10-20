import type { Hex } from "viem";
import type { ChainId } from "./chains";
import { RelayMeshError } from "./errors";

export const INTENT_STATUSES = [
  "DRAFT",
  "QUOTED",
  "AWAITING_SIGNATURE",
  "SOURCE_SUBMITTED",
  "SOURCE_CONFIRMED",
  "DESTINATION_PENDING",
  "SETTLED",
  "EXPIRED",
  "FAILED_BEFORE_SOURCE",
  "NEEDS_REVIEW",
] as const;

export type IntentStatus = (typeof INTENT_STATUSES)[number];

const TRANSITIONS: Record<IntentStatus, readonly IntentStatus[]> = {
  DRAFT: ["QUOTED", "EXPIRED"],
  // QUOTED -> QUOTED is a re-quote; AWAITING_SIGNATURE -> QUOTED happens when the selected quote expires.
  QUOTED: ["QUOTED", "AWAITING_SIGNATURE", "EXPIRED"],
  AWAITING_SIGNATURE: ["QUOTED", "SOURCE_SUBMITTED", "EXPIRED", "FAILED_BEFORE_SOURCE"],
  SOURCE_SUBMITTED: ["SOURCE_CONFIRMED", "FAILED_BEFORE_SOURCE", "NEEDS_REVIEW"],
  SOURCE_CONFIRMED: ["DESTINATION_PENDING", "NEEDS_REVIEW"],
  DESTINATION_PENDING: ["SETTLED", "NEEDS_REVIEW"],
  // Terminal states. NEEDS_REVIEW is resolved by a human, outside this state machine.
  SETTLED: [],
  EXPIRED: [],
  FAILED_BEFORE_SOURCE: [],
  NEEDS_REVIEW: [],
};

export function allowedTransitions(status: IntentStatus): readonly IntentStatus[] {
  return TRANSITIONS[status];
}

export function isTerminal(status: IntentStatus): boolean {
  return TRANSITIONS[status].length === 0;
}

/** How a SETTLED claim was established. Only the first two involve RelayMesh reading the destination chain. */
export type VerificationMode =
  | "destination_rpc_state"
  | "provider_status_plus_destination_rpc"
  | "provider_report_only";

export type EvidenceKind = "source_transaction" | "destination_state" | "provider_status";

export interface Evidence {
  kind: EvidenceKind;
  /** Chain the observation was read from; absent only for provider_status. */
  chain?: ChainId;
  /** What was queried, e.g. "substrate_extrinsic_events" or "evm_balance_delta". */
  method: string;
  txHash?: Hex;
  blockNumber?: bigint;
  blockHash?: Hex;
  /** True only once the block is final under the chain's finality rule. */
  finalized: boolean;
  /** Amount actually observed moving, in the observed chain's base units. */
  amount?: bigint;
  observedAt: number;
  details?: Record<string, string>;
}

export interface StatusEvent {
  seq: number;
  status: IntentStatus;
  at: number;
  reason: string;
  evidence?: Evidence;
  verificationMode?: VerificationMode;
}

export type NewStatusEvent = Omit<StatusEvent, "seq">;

export function createHistory(at: number): StatusEvent[] {
  return [{ seq: 0, status: "DRAFT", at, reason: "intent created" }];
}

/** Returns a new history with `next` appended, or throws if the transition or its evidence is invalid. */
export function appendStatus(history: readonly StatusEvent[], next: NewStatusEvent): StatusEvent[] {
  const current = currentStatus(history);
  const last = history[history.length - 1] as StatusEvent;
  const event: StatusEvent = { ...next, seq: last.seq + 1 };
  assertTransition(current, last, event);
  return [...history, event];
}

/** Replays and validates the full history, then returns its latest status. */
export function currentStatus(history: readonly StatusEvent[]): IntentStatus {
  const first = history[0];
  if (!first || first.seq !== 0 || first.status !== "DRAFT") {
    throw new RelayMeshError("INTEGRITY_ERROR", "History must start with DRAFT at seq 0");
  }
  for (let i = 1; i < history.length; i++) {
    const prev = history[i - 1] as StatusEvent;
    const event = history[i] as StatusEvent;
    if (event.seq !== prev.seq + 1) throw new RelayMeshError("INTEGRITY_ERROR", `History seq gap at index ${i}`);
    assertTransition(prev.status, prev, event);
  }
  return (history[history.length - 1] as StatusEvent).status;
}

function assertTransition(from: IntentStatus, prev: StatusEvent, event: StatusEvent): void {
  const fail = (code: "INVALID_TRANSITION" | "MISSING_EVIDENCE", message: string): never => {
    throw new RelayMeshError(code, `${from} -> ${event.status}: ${message}`);
  };

  if (!TRANSITIONS[from].includes(event.status)) fail("INVALID_TRANSITION", "transition not allowed");
  if (!event.reason.trim()) fail("INVALID_TRANSITION", "reason is required");
  if (!Number.isSafeInteger(event.at) || event.at < prev.at) fail("INVALID_TRANSITION", "time must not go backwards");

  const evidence = event.evidence;
  switch (event.status) {
    case "SOURCE_SUBMITTED":
      if (evidence?.kind !== "source_transaction" || !evidence.txHash) {
        fail("MISSING_EVIDENCE", "requires source_transaction evidence with txHash");
      }
      break;
    case "SOURCE_CONFIRMED":
      if (evidence?.kind !== "source_transaction" || !evidence.txHash || !evidence.blockHash || !evidence.finalized) {
        fail("MISSING_EVIDENCE", "requires finalized source_transaction evidence with txHash and blockHash");
      }
      break;
    case "SETTLED": {
      if (!event.verificationMode) fail("MISSING_EVIDENCE", "requires verificationMode");
      if (!evidence?.finalized) fail("MISSING_EVIDENCE", "requires finalized evidence");
      const needsChainRead = event.verificationMode !== "provider_report_only";
      if (needsChainRead && (evidence?.kind !== "destination_state" || !evidence.chain || evidence.amount === undefined)) {
        fail("MISSING_EVIDENCE", `${event.verificationMode} requires destination_state evidence with chain and amount`);
      }
      if (!needsChainRead && evidence?.kind !== "provider_status") {
        fail("MISSING_EVIDENCE", "provider_report_only requires provider_status evidence");
      }
      break;
    }
    default:
      if (event.verificationMode) fail("INVALID_TRANSITION", "verificationMode is only valid on SETTLED");
  }
}
