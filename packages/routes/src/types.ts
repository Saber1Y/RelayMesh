import type { Hex } from "viem";
import type { ChainId, Intent, Quote } from "@relaymesh/core";

export type RouteRejectionCode =
  | "UNSUPPORTED_ROUTE"
  | "PROVIDER_UNAVAILABLE"
  | "INSUFFICIENT_BALANCE"
  | "AMOUNT_TOO_SMALL"
  | "INVALID_RECIPIENT"
  | "PROVIDER_ERROR";

export type QuoteResult = { ok: true; quotes: Quote[] } | { ok: false; code: RouteRejectionCode; reason: string };

export type ProviderStatus =
  | { available: true }
  | { available: false; reason: string; /** ISO date the status was last confirmed. */ checkedOn: string };

/** Unsigned work the user's wallet must sign. RelayMesh never signs or submits on the user's behalf. */
export interface SubstrateCallPlan {
  kind: "substrate_call";
  chain: ChainId;
  /** SS58 address that must sign. */
  signer: string;
  /** SCALE-encoded call; the wallet signs exactly this, and the verifier compares the included extrinsic against it. */
  callHex: Hex;
  /** Human-readable form of callHex for review screens. Amounts are base-unit strings. */
  call: { section: string; method: string; args: Record<string, string> };
  quoteId: string;
  /** Unix seconds after which the plan must not be submitted (the quote's expiry). */
  submitBefore: number;
  /** Fee estimate at plan time, in the source chain's base units. */
  estimatedFee: bigint;
  /** The native account whose balance change proves delivery. */
  destinationAccount: string;
}

export type ExecutionPlan = SubstrateCallPlan;

export interface QuoteContext {
  /** Unix seconds. */
  now: number;
}

export interface RouteProvider {
  id: string;
  name: string;
  description: string;
  status(): ProviderStatus;
  /** Whether this provider handles the intent's chain/asset pair at all (no network calls). */
  supports(intent: Intent): boolean;
  quote(intent: Intent, ctx: QuoteContext): Promise<QuoteResult>;
  /** Re-validates the quote against live state and returns the unsigned call. Throws RelayMeshError when it cannot. */
  buildExecution(intent: Intent, quote: Quote, ctx: QuoteContext): Promise<ExecutionPlan>;
}
