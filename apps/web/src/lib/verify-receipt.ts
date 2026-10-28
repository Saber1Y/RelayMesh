import { keccak256, stringToBytes, type Hex } from "viem";
import { hashCanonical, RECEIPT_HASH_DOMAIN } from "@relaymesh/core";

/**
 * Independent receipt verification, run in the visitor's browser. The receipt is re-hashed here with
 * the same canonical encoding the server uses, and compared with the hash RelayMesh's relayer wrote
 * to IntentRegistry, read straight from the PortalDot V3 EVM RPC. Where the receipt came from does
 * not matter: a single changed byte changes the hash.
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

/** What the checker reads from the chain. In the browser this is viem against the V3 EVM RPC. */
export interface RegistryReader {
  getIntent(intentHash: Hex): Promise<AnchorState>;
  /** The transaction that recorded this receipt, if the RPC can search that far back. */
  findReceiptTx(intentHash: Hex): Promise<AnchorTx | null>;
}

export type Verdict =
  /** The on-chain receipt hash equals the hash of this receipt. */
  | "match"
  /** The intent is anchored with a different receipt hash: the receipt was changed. */
  | "mismatch"
  /** The intent is recorded but its receipt is not yet. */
  | "receipt_pending"
  /** Nothing is recorded for this intent hash. */
  | "not_anchored";

export interface Verification {
  verdict: Verdict;
  computedHash: Hex;
  onChain: AnchorState;
  /** The on-chain route ID equals keccak256 of the receipt's route ID. */
  routeMatches: boolean | null;
  anchorTx: AnchorTx | null;
}

export async function verifyReceipt(receipt: ParsedReceipt, reader: RegistryReader): Promise<Verification> {
  const computedHash = receiptHashOf(receipt);
  const onChain = await reader.getIntent(receipt.intentHash);
  const recorded = onChain.recorder.toLowerCase() !== ZERO_ADDRESS;
  const anchored = onChain.receiptHash !== ZERO_HASH;
  const verdict: Verdict = !recorded ? "not_anchored" : !anchored ? "receipt_pending" : onChain.receiptHash.toLowerCase() === computedHash.toLowerCase() ? "match" : "mismatch";
  const routeMatches = recorded ? onChain.routeId.toLowerCase() === keccak256(stringToBytes(receipt.routeId)).toLowerCase() : null;
  // The transaction is supporting detail: a failed search never changes the verdict.
  const anchorTx = anchored ? await reader.findReceiptTx(receipt.intentHash).catch(() => null) : null;
  return { verdict, computedHash, onChain, routeMatches, anchorTx };
}
