import { keccak256, stringToBytes, type Hex } from "viem";
import { batchLeaf, hashCanonical, merkleRootFromProof, RECEIPT_HASH_DOMAIN } from "@relaymesh/core";
import type { BatchOnChain } from "./batch-log";

/**
 * Independent receipt verification, run in the visitor's browser. The receipt is re-hashed here with
 * the same canonical encoding the server uses, and compared with what RelayMesh's relayer committed
 * to on chain, read straight from the PortalDot V3 EVM RPC. Where the receipt came from does not
 * matter: a single changed byte changes the hash.
 *
 * Receipts anchored before batching sit in IntentRegistry, one receipt hash per intent. Later ones are
 * part of a Merkle root recorded by ReceiptBatchRegistry or ReceiptBatchLog: the browser recomputes
 * the receipt's leaf, folds RelayMesh's proof up to a root, and checks that exact root is in the
 * BatchRecorded log of the recording transaction. The proof and the transaction hash come from
 * RelayMesh's API, but neither can be forged to reach a recorded root, so they need no trust.
 */

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const HEX16 = /^0x[0-9a-fA-F]{32}$/;
const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
const ZERO_ADDRESS = `0x${"0".repeat(40)}`;

/** The fields the checker reads; the hash always covers the whole parsed receipt. */
export interface ParsedReceipt {
  raw: Record<string, unknown>;
  intentId: Hex;
  intentHash: Hex;
  routeId: string;
  status: string;
  sourceAmount: string;
  sourceChain: string;
  sourceBlock: string | null;
  observedAmount: string | null;
  destinationChain: string;
}

export class ReceiptFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptFormatError";
  }
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ReceiptFormatError(`${what} is missing`);
  return value as Record<string, unknown>;
}

function text(value: unknown, what: string): string {
  if (typeof value !== "string") throw new ReceiptFormatError(`${what} is missing`);
  return value;
}

/** Parses receipt JSON as downloaded from RelayMesh, rejecting anything that is not a version 1 receipt. */
export function parseReceipt(json: string): ParsedReceipt {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new ReceiptFormatError("This is not valid JSON");
  }
  const raw = record(value, "The receipt");
  if (raw.version !== 1) throw new ReceiptFormatError("This is not a RelayMesh version 1 receipt");
  const intentId = text(raw.intentId, "intentId");
  const intentHash = text(raw.intentHash, "intentHash");
  if (!HEX16.test(intentId)) throw new ReceiptFormatError("intentId is not a 16-byte hex value");
  if (!HEX32.test(intentHash)) throw new ReceiptFormatError("intentHash is not a 32-byte hex value");
  const route = record(raw.route, "route");
  const source = record(raw.source, "source");
  const destination = record(raw.destination, "destination");
  return {
    raw,
    intentId: intentId as Hex,
    intentHash: intentHash as Hex,
    routeId: text(route.routeId, "route.routeId"),
    status: text(raw.status, "status"),
    sourceAmount: text(source.amount, "source.amount"),
    sourceChain: text(source.chain, "source.chain"),
    sourceBlock: typeof source.blockNumber === "string" ? source.blockNumber : null,
    observedAmount: typeof destination.observedAmount === "string" ? destination.observedAmount : null,
    destinationChain: text(destination.chain, "destination.chain"),
  };
}

/** keccak256 of the receipt domain and its canonical JSON: the value IntentRegistry stores. */
export function receiptHashOf(receipt: ParsedReceipt): Hex {
  try {
    return hashCanonical(RECEIPT_HASH_DOMAIN, receipt.raw);
  } catch {
    throw new ReceiptFormatError("This receipt holds values RelayMesh never writes, so it cannot be hashed");
  }
}

export interface AnchorState {
  recorder: Hex;
  routeId: Hex;
  receiptHash: Hex;
}

export interface AnchorTx {
  txHash: Hex;
  blockNumber: bigint;
}

/** What the checker reads from IntentRegistry. In the browser this is viem against the V3 EVM RPC. */
export interface RegistryReader {
  getIntent(intentHash: Hex): Promise<AnchorState>;
  /** The transaction that recorded this receipt, if the RPC can search that far back. */
  findReceiptTx(intentHash: Hex): Promise<AnchorTx | null>;
}

/** RelayMesh's claim of where an intent's receipt is batched. Untrusted: every part is checked against the chain. */
export interface BatchProofClaim {
  receiptHash: Hex;
  proof: Hex[];
  /** The batch contract and the transaction that recorded the root. */
  contractAddress: Hex;
  txHash: Hex;
}

export type BatchState = BatchOnChain;

/** What the checker reads for batched receipts: the proof from RelayMesh, everything else from the chain. */
export interface BatchReader {
  /** RelayMesh's batch contracts, from this deployment's configuration; a claim naming any other is rejected. */
  contracts: readonly Hex[];
  fetchProof(intentId: Hex): Promise<BatchProofClaim | null>;
  /** The batch `contract` recorded with this root in transaction `txHash`, or null if it holds no such record (see batch-log.ts). */
  findBatch(contract: Hex, txHash: Hex, root: Hex): Promise<BatchState | null>;
}

export type Verdict =
  /** The chain commits to this receipt's hash, directly or through a batch root. */
  | "match"
  /** The chain commits to a different receipt hash for this intent: the receipt was changed. */
  | "mismatch"
  /** RelayMesh offered a batch proof, but it leads to no root recorded on chain. */
  | "proof_invalid"
  /** The intent is recorded in IntentRegistry but its receipt is not yet. */
  | "receipt_pending"
  /** Nothing is recorded for this intent hash. */
  | "not_anchored";

export interface BatchVerification {
  /** The batch contract RelayMesh named (always one of BatchReader.contracts when a root is found). */
  contract: Hex;
  /** The leaf computed here from the receipt's intent hash and the browser-computed receipt hash. */
  leaf: Hex;
  proof: Hex[];
  /** The recorded root the proof leads to: from this receipt for "match", from RelayMesh's claimed hash for "mismatch". */
  root: Hex | null;
  /** The batch as recorded on chain; null when no root the proof leads to is recorded. */
  onChain: BatchState | null;
}

export interface Verification {
  verdict: Verdict;
  computedHash: Hex;
  /** Which registry commits to the receipt, if one does. */
  anchoredIn: "registry" | "batch" | null;
  /** The receipt hash the chain commits to for this intent, if any. */
  anchoredHash: Hex | null;
  /** IntentRegistry's record of the intent (all zeros when it has none). */
  onChain: AnchorState;
  /** The on-chain route ID equals keccak256 of the receipt's route ID; null when IntentRegistry has no record. */
  routeMatches: boolean | null;
  batch: BatchVerification | null;
  anchorTx: AnchorTx | null;
}

const EMPTY_STATE: AnchorState = { recorder: ZERO_ADDRESS as Hex, routeId: ZERO_HASH, receiptHash: ZERO_HASH };

/** The root a proof leads to from this leaf, or null if the proof is malformed. */
function foldProof(leaf: Hex, proof: Hex[]): Hex | null {
  try {
    return merkleRootFromProof(leaf, proof);
  } catch {
    return null;
  }
}

/**
 * Checks a receipt against IntentRegistry first, then against RelayMesh's batch contracts. Either reader
 * may be null when this deployment has no such contract.
 */
export async function verifyReceipt(receipt: ParsedReceipt, reader: RegistryReader | null, batches: BatchReader | null = null): Promise<Verification> {
  const computedHash = receiptHashOf(receipt);
  const onChain = reader ? await reader.getIntent(receipt.intentHash) : EMPTY_STATE;
  const recorded = onChain.recorder.toLowerCase() !== ZERO_ADDRESS;
  const routeMatches = recorded ? onChain.routeId.toLowerCase() === keccak256(stringToBytes(receipt.routeId)).toLowerCase() : null;
  const base = { computedHash, onChain, routeMatches };

  if (reader && onChain.receiptHash !== ZERO_HASH) {
    const verdict: Verdict = onChain.receiptHash.toLowerCase() === computedHash.toLowerCase() ? "match" : "mismatch";
    // The transaction is supporting detail: a failed search never changes the verdict.
    const anchorTx = await reader.findReceiptTx(receipt.intentHash).catch(() => null);
    return { ...base, verdict, anchoredIn: "registry", anchoredHash: onChain.receiptHash, batch: null, anchorTx };
  }

  const pending: Verification = { ...base, verdict: recorded ? "receipt_pending" : "not_anchored", anchoredIn: null, anchoredHash: null, batch: null, anchorTx: null };
  const claim = batches && (await batches.fetchProof(receipt.intentId));
  if (!batches || !claim) return pending;
  // Only RelayMesh's own batch contracts count: a log from any other address proves nothing.
  const trusted = batches.contracts.some((c) => c.toLowerCase() === claim.contractAddress.toLowerCase());
  const lookup = (root: Hex) => (trusted ? batches.findBatch(claim.contractAddress, claim.txHash, root) : Promise.resolve(null));

  // The leaf comes from the receipt in hand, never from RelayMesh.
  const intentHash = receipt.intentHash.toLowerCase() as Hex;
  const leaf = batchLeaf(intentHash, computedHash);
  const root = foldProof(leaf, claim.proof);
  const batch = root && (await lookup(root));
  if (root && batch) {
    const anchorTx = { txHash: batch.txHash, blockNumber: batch.blockNumber };
    return { ...base, verdict: "match", anchoredIn: "batch", anchoredHash: computedHash, batch: { contract: claim.contractAddress, leaf, proof: claim.proof, root, onChain: batch }, anchorTx };
  }

  // This receipt is not in a recorded batch. If RelayMesh's own claimed receipt hash is, the chain
  // commits to a different receipt for this intent, so the one in hand was changed.
  const claimed = /^0x[0-9a-f]{64}$/.test(claim.receiptHash) ? claim.receiptHash : null;
  const claimedRoot = claimed && claimed !== computedHash ? foldProof(batchLeaf(intentHash, claimed), claim.proof) : null;
  const claimedBatch = claimedRoot && (await lookup(claimedRoot));
  if (claimed && claimedRoot && claimedBatch) {
    const anchorTx = { txHash: claimedBatch.txHash, blockNumber: claimedBatch.blockNumber };
    return { ...base, verdict: "mismatch", anchoredIn: "batch", anchoredHash: claimed, batch: { contract: claim.contractAddress, leaf, proof: claim.proof, root: claimedRoot, onChain: claimedBatch }, anchorTx };
  }
  return { ...base, verdict: "proof_invalid", anchoredIn: null, anchoredHash: null, batch: { contract: claim.contractAddress, leaf, proof: claim.proof, root: null, onChain: null }, anchorTx: null };
}
