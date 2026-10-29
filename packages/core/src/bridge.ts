import type { Hex } from "viem";
import { hashCanonical } from "./canonical";
import { RelayMeshError } from "./errors";

/**
 * Independent checks of PortalDot bridge transfers (Portaldot mainnet POT to BSC WPOT).
 *
 * The bridge is custodial: a user sends POT to the bridge's deposit address on Portaldot, tells the
 * bridge's server where to pay, and the bridge later sends WPOT from its reserve on BSC. Nothing on
 * either chain links the two transactions, so a payout is matched to a deposit by being an exact
 * post-fee amount, from the bridge's reserve, made after the deposit (and to the recipient, when the
 * user names one). These functions are pure; the chain reads live in @relaymesh/chains.
 */

export const BRIDGE_CHECK_DOMAIN = "relaymesh.bridge.v1";

/** A Portaldot extrinsic as the explorer names it: block number and index within the block. */
export interface DepositId {
  block: number;
  index: number;
}

/** Accepts "844578-1", "#844578-1" or an explorer link ending in "/extrinsics/844578-1". */
export function parseDepositId(input: string): DepositId {
  const match = /(?:^|[/#\s])(\d{1,12})-(\d{1,6})\s*$/.exec(input.trim());
  if (!match) throw new RelayMeshError("INVALID_INPUT", "Enter the deposit as block-index, for example 844578-1, or paste its explorer link");
  return { block: Number(match[1]), index: Number(match[2]) };
}

export interface BridgeFee {
  /** The bridge's fee in basis points (300 = 3%). */
  feeBps: number;
  /** Decimals of POT on Portaldot and of WPOT on BSC. */
  sourceDecimals: number;
  targetDecimals: number;
}

/** The WPOT a deposit should pay out: the deposit less the fee, rescaled to the token's decimals. */
export function expectedPayout(depositBaseUnits: bigint, fee: BridgeFee): bigint {
  if (!Number.isInteger(fee.feeBps) || fee.feeBps < 0 || fee.feeBps >= 10_000) throw new RelayMeshError("INVALID_INPUT", `Invalid bridge fee: ${fee.feeBps} bps`);
  const scaled =
    fee.targetDecimals >= fee.sourceDecimals
      ? depositBaseUnits * 10n ** BigInt(fee.targetDecimals - fee.sourceDecimals)
      : depositBaseUnits / 10n ** BigInt(fee.sourceDecimals - fee.targetDecimals);
  return (scaled * BigInt(10_000 - fee.feeBps)) / 10_000n;
}

export interface BridgeDeposit {
  id: DepositId;
  blockHash: Hex;
  extrinsicHash: Hex;
  /** Unix seconds, from the block's own timestamp. */
  time: number;
  finalized: boolean;
  signer: string | null;
  call: string;
  /** Destination and amount as signed; null when the call is not a balances transfer. */
  destination: string | null;
  amount: bigint | null;
  /** From the extrinsic's events; null when the node no longer holds that block's state. */
  success: boolean | null;
}

export interface BridgePayout {
  txHash: Hex;
  blockNumber: bigint;
  /** Unix seconds, from the BSC block. */
  time: number;
  recipient: Hex;
  amount: bigint;
  finalized: boolean;
}

export type BridgeVerdict =
  /** Deposit proven on Portaldot and a matching payout found on BSC. */
  | "verified"
  /** Deposit proven; no matching payout yet. The bridge pays out in batches, hours later. */
  | "payout_pending"
  /** The deposit is fine but its block, or the payout's, is not final yet. */
  | "not_final"
  /** The extrinsic is not a successful transfer into the bridge's deposit address. */
  | "not_a_deposit";

export interface BridgeAssessment {
  verdict: BridgeVerdict;
  expected: bigint | null;
  payout: BridgePayout | null;
  /** Why the verdict is not "verified", in plain words. */
  problems: string[];
}

const TRANSFER_CALLS = new Set(["balances.transferKeepAlive", "balances.transferAllowDeath", "balances.transfer"]);

/**
 * Judges a deposit against payout candidates already filtered by the chain reader to the bridge's
 * reserve and token. The first candidate after the deposit with the exact expected amount (and the
 * named recipient, if any) is the match.
 */
export function assessBridgeTransfer(input: {
  deposit: BridgeDeposit;
  depositAddress: string;
  fee: BridgeFee;
  candidates: BridgePayout[];
  recipient?: Hex | null;
  sameAccount: (a: string, b: string) => boolean;
}): BridgeAssessment {
  const { deposit, depositAddress, fee, candidates, recipient } = input;
  const problems: string[] = [];
  if (!TRANSFER_CALLS.has(deposit.call)) problems.push(`The extrinsic is ${deposit.call}, not a balances transfer`);
  else if (!deposit.destination || !input.sameAccount(deposit.destination, depositAddress)) problems.push("The transfer does not go to the bridge's deposit address");
  if (deposit.success === false) problems.push("The transfer failed on chain, so no POT reached the bridge");
  if (problems.length > 0 || deposit.amount === null) return { verdict: "not_a_deposit", expected: null, payout: null, problems };

  const expected = expectedPayout(deposit.amount, fee);
  const payout =
    candidates
      .filter((c) => c.time >= deposit.time && c.amount === expected && (!recipient || c.recipient.toLowerCase() === recipient.toLowerCase()))
      .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0))[0] ?? null;

  if (deposit.success === null) problems.push("The node no longer holds this block's state, so the transfer's result could not be read");
  if (!deposit.finalized) problems.push("The deposit's Portaldot block is not finalized yet");
  if (!payout) {
    problems.push(recipient ? "No payout of the expected amount to this BSC address yet" : "No payout of the expected amount after the deposit yet");
    return { verdict: deposit.finalized ? "payout_pending" : "not_final", expected, payout: null, problems };
  }
  if (!payout.finalized) problems.push("The payout's BSC block is not finalized yet");
  const verdict: BridgeVerdict = !deposit.finalized || !payout.finalized ? "not_final" : "verified";
  return { verdict, expected, payout, problems };
}

/** A stable fingerprint of a bridge check's facts, in the same canonical form as RelayMesh receipts. */
export function hashBridgeCheck(deposit: BridgeDeposit, payout: BridgePayout | null): Hex {
  return hashCanonical(BRIDGE_CHECK_DOMAIN, {
    deposit: { ...deposit, id: `${deposit.id.block}-${deposit.id.index}` },
    payout,
  });
}
