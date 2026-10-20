import { bytesToHex, type Hex } from "viem";
import { z } from "zod";
import { parseBaseUnits } from "./amount.js";
import { hashCanonical } from "./canonical.js";
import { getAsset, getChain, normalizeAddress, type ChainId } from "./chains.js";
import { RelayMeshError } from "./errors.js";

export const INTENT_HASH_DOMAIN = "relaymesh.intent.v1";

/** Longest allowed gap between creation and deadline. Quotes and testnet finality are minutes, not days. */
export const MAX_DEADLINE_SECONDS = 24 * 60 * 60;
/** Shortest allowed gap, so there is time to quote, sign and confirm. */
export const MIN_DEADLINE_SECONDS = 60;

const baseUnits = z.string().regex(/^(0|[1-9]\d*)$/, "must be an integer amount in base units");

/** Wire format: what the API accepts. Amounts are base-unit strings, times are unix seconds. */
export const IntentInputSchema = z
  .object({
    requester: z.string().min(1),
    source: z.object({ chain: z.string(), asset: z.string(), amount: baseUnits }).strict(),
    destination: z.object({ chain: z.string(), asset: z.string(), recipient: z.string().min(1) }).strict(),
    constraints: z
      .object({
        minOutput: baseUnits.optional(),
        maxFee: baseUnits.optional(),
        deadline: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type IntentInput = z.infer<typeof IntentInputSchema>;

export interface Intent {
  version: 1;
  intentId: Hex;
  createdAt: number;
  /** Requester address in the source chain's canonical format. */
  requester: string;
  source: { chain: ChainId; asset: string; amount: bigint };
  destination: { chain: ChainId; asset: string; recipient: string };
  constraints: { minOutput?: bigint; maxFee?: bigint; deadline: number };
}

export interface CreateIntentOptions {
  /** Current unix time in seconds. Injected so validation is deterministic and testable. */
  now: number;
  /** 16-byte random ID; generated when omitted. */
  intentId?: Hex;
}

export function newIntentId(): Hex {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

/** Validates wire input and returns a normalized intent and its hash. Throws RelayMeshError. */
export function createIntent(input: unknown, options: CreateIntentOptions): { intent: Intent; intentHash: Hex } {
  const parsed = IntentInputSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = issue?.path.join(".") || undefined;
    throw new RelayMeshError("INVALID_INTENT", `${field ?? "intent"}: ${issue?.message ?? "invalid"}`, field);
  }
  const data = parsed.data;
  const { now } = options;

  const sourceChain = getChain(data.source.chain).id as ChainId;
  const destinationChain = getChain(data.destination.chain).id as ChainId;
  getAsset(sourceChain, data.source.asset);
  getAsset(destinationChain, data.destination.asset);
  if (sourceChain === destinationChain) {
    throw new RelayMeshError("UNSUPPORTED_ROUTE", "Source and destination must be different chains", "destination.chain");
  }

  const amount = parseBaseUnits(data.source.amount, "source.amount");
  if (amount === 0n) throw new RelayMeshError("INVALID_AMOUNT", "source.amount must be greater than zero", "source.amount");
  const minOutput = data.constraints.minOutput === undefined ? undefined : parseBaseUnits(data.constraints.minOutput, "constraints.minOutput");
  const maxFee = data.constraints.maxFee === undefined ? undefined : parseBaseUnits(data.constraints.maxFee, "constraints.maxFee");

  const { deadline } = data.constraints;
  if (deadline < now + MIN_DEADLINE_SECONDS) {
    throw new RelayMeshError("DEADLINE_INVALID", `deadline must be at least ${MIN_DEADLINE_SECONDS}s in the future`, "constraints.deadline");
  }
  if (deadline > now + MAX_DEADLINE_SECONDS) {
    throw new RelayMeshError("DEADLINE_INVALID", `deadline must be within ${MAX_DEADLINE_SECONDS}s`, "constraints.deadline");
  }

  const intentId = options.intentId ?? newIntentId();
  if (!/^0x[0-9a-f]{32}$/.test(intentId)) throw new RelayMeshError("INVALID_INTENT", "intentId must be 16 lowercase hex bytes", "intentId");

  const intent: Intent = {
    version: 1,
    intentId,
    createdAt: now,
    requester: normalizeAddress(sourceChain, data.requester, "requester"),
    source: { chain: sourceChain, asset: data.source.asset, amount },
    destination: {
      chain: destinationChain,
      asset: data.destination.asset,
      recipient: normalizeAddress(destinationChain, data.destination.recipient, "destination.recipient"),
    },
    constraints: {
      deadline,
      ...(minOutput !== undefined && { minOutput }),
      ...(maxFee !== undefined && { maxFee }),
    },
  };

  return { intent, intentHash: hashIntent(intent) };
}

/** The bytes32 recorded in IntentRegistry. Covers every field, including intentId, so equal requests get distinct hashes. */
export function hashIntent(intent: Intent): Hex {
  return hashCanonical(INTENT_HASH_DOMAIN, intent);
}
