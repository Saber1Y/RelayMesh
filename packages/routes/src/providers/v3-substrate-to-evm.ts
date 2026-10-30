import { u8aEq } from "@polkadot/util";
import { decodeAddress, encodeAddress } from "@polkadot/util-crypto";
import type { Hex } from "viem";
import { fallbackAccountIdForH160, type V3NativeClient } from "@relaymesh/chains";
import { assertQuoteUsable, getAsset, RelayMeshError, serviceFee as serviceFeeOf, type Intent, type Quote } from "@relaymesh/core";
import type { ExecutionPlan, ProviderStatus, QuoteContext, QuoteResult, RouteProvider } from "../types";

export const V3_SUBSTRATE_TO_EVM_PROVIDER_ID = "portaldot-v3-native";
export const V3_SUBSTRATE_TO_EVM_ROUTE_ID = "v3-substrate-to-evm";

/**
 * How long a quote may be selected and signed. It must cover reading the quote, the browser decoding
 * the call (slow on a first visit) and approving in the wallet. Safety does not depend on it being
 * short: chain state is re-read before a plan is issued, and settlement measures what actually arrived.
 */
export const QUOTE_TTL_SECONDS = 120;

/**
 * Inclusion plus GRANDPA finality. On 2026-10-20 finality trailed the best block by about 2 blocks,
 * so 3 expected block times is the estimate shown. It is a display estimate, never a guarantee.
 */
const ESTIMATED_BLOCKS_TO_FINALITY = 3;

interface TransferAnalysis {
  destinationAccount: Uint8Array;
  expectedOutput: bigint;
  /** Network fee estimate for the whole call. */
  fee: bigint;
  /** RelayMesh's fee and the account it is paid to, or null when none is charged. */
  serviceFee: { amount: bigint; account: string } | null;
  callHex: Hex;
}

/** RelayMesh's per-transfer fee, paid to the account behind an EVM address (the relayer that anchors receipts). */
export interface ServiceFeeConfig {
  amount: bigint;
  recipient: Hex;
}

type Analysis = { ok: true; value: TransferAnalysis } | Extract<QuoteResult, { ok: false }>;

/** Amount the account could spend while staying alive: free minus max(frozen, existential deposit), floored at 0. */
function reducible(free: bigint, frozen: bigint, existentialDeposit: bigint): bigint {
  const locked = frozen > existentialDeposit ? frozen : existentialDeposit;
  return free > locked ? free - locked : 0n;
}

/**
 * Moves native tPOT from a Substrate account to the account that controls an EVM (H160) address on
 * the same PortalDot V3 chain, using balances.transferKeepAlive.
 *
 * The H160's controlling account is the one Revive maps it to (revive.originalAccount), or, when
 * unmapped, its fallback account h160 ++ 0xEE*12. eth_getBalance reports that account's reducible
 * balance times nativeToEthRatio (verified on V3 on 2026-10-20, see docs/devlog.md), so the expected
 * EVM-side delta is computed from that rule. Settlement still measures the actual delta independently.
 */
export class V3SubstrateToEvmProvider implements RouteProvider {
  readonly id = V3_SUBSTRATE_TO_EVM_PROVIDER_ID;
  readonly name = "PortalDot V3 native transfer";
  readonly description = "Transfers tPOT from a PortalDot V3 Substrate account to an EVM address on the same chain via Revive account mapping.";

  /**
   * With `serviceFee`, each transfer also pays that fee to the account behind `serviceFee.recipient`,
   * in the same signed call, so the transfers fund the anchoring of their own receipts.
   */
  constructor(
    private readonly client: V3NativeClient,
    private readonly serviceFee: ServiceFeeConfig | null = null,
  ) {}

  status(): ProviderStatus {
    return { available: true };
  }

  supports(intent: Intent): boolean {
    return (
      intent.source.chain === "portaldot-v3-substrate" &&
      intent.destination.chain === "portaldot-v3-evm" &&
      intent.source.asset === "native" &&
      intent.destination.asset === "native"
    );
  }

  async quote(intent: Intent, ctx: QuoteContext): Promise<QuoteResult> {
    if (!this.supports(intent)) return { ok: false, code: "UNSUPPORTED_ROUTE", reason: "Only native tPOT from Substrate to EVM on V3" };
    const analysis = await this.analyze(intent);
    if (!analysis.ok) return analysis;

    const quote: Quote = {
      quoteId: `${this.id}-${crypto.randomUUID()}`,
      intentId: intent.intentId,
      provider: this.id,
      routeId: V3_SUBSTRATE_TO_EVM_ROUTE_ID,
      expectedOutput: analysis.value.expectedOutput,
      fees: [
        { kind: "network", chain: "portaldot-v3-substrate", asset: "native", amount: analysis.value.fee, basis: "estimate" },
        ...(analysis.value.serviceFee
          ? [{ kind: "provider" as const, chain: "portaldot-v3-substrate" as const, asset: "native", amount: analysis.value.serviceFee.amount, basis: "quoted" as const, recipient: analysis.value.serviceFee.account }]
          : []),
      ],
      retrievedAt: ctx.now,
      expiresAt: ctx.now + QUOTE_TTL_SECONDS,
      estimatedSeconds: Math.ceil((ESTIMATED_BLOCKS_TO_FINALITY * this.client.expectedBlockTimeMs) / 1000),
    };
    return { ok: true, quotes: [quote] };
  }

  async buildExecution(intent: Intent, quote: Quote, ctx: QuoteContext): Promise<ExecutionPlan> {
    if (quote.provider !== this.id || quote.routeId !== V3_SUBSTRATE_TO_EVM_ROUTE_ID) {
      throw new RelayMeshError("QUOTE_MISMATCH", `Quote was not issued by ${this.id}`);
    }
    assertQuoteUsable(quote, intent, ctx.now);

    // Balances, mapping or fees may have changed since quoting; never hand out a plan that no longer matches.
    const analysis = await this.analyze(intent);
    if (!analysis.ok) throw new RelayMeshError("CONSTRAINT_VIOLATION", analysis.reason);
    const { destinationAccount, expectedOutput, fee, serviceFee, callHex } = analysis.value;
    if (expectedOutput !== quote.expectedOutput) {
      throw new RelayMeshError("QUOTE_MISMATCH", "Destination state changed since the quote; request a fresh quote");
    }
    const quoted = serviceFeeOf(quote);
    if (quoted?.amount !== serviceFee?.amount || quoted?.recipient !== serviceFee?.account) {
      throw new RelayMeshError("QUOTE_MISMATCH", "RelayMesh's fee changed since the quote; request a fresh quote");
    }
    if (intent.constraints.maxFee !== undefined && fee + (serviceFee?.amount ?? 0n) > intent.constraints.maxFee) {
      throw new RelayMeshError("CONSTRAINT_VIOLATION", "Current fee estimate exceeds the maximum fee constraint", "constraints.maxFee");
    }

    const destination = encodeAddress(destinationAccount, this.client.ss58Prefix);
    return {
      kind: "substrate_call",
      chain: "portaldot-v3-substrate",
      signer: intent.requester,
      callHex,
      call: serviceFee
        ? {
            section: "utility",
            method: "batchAll",
            args: { dest: destination, value: intent.source.amount.toString(), feeDest: serviceFee.account, fee: serviceFee.amount.toString() },
          }
        : { section: "balances", method: "transferKeepAlive", args: { dest: destination, value: intent.source.amount.toString() } },
      quoteId: quote.quoteId,
      submitBefore: quote.expiresAt,
      estimatedFee: fee,
      destinationAccount: destination,
    };
  }

  private async analyze(intent: Intent): Promise<Analysis> {
    const { client } = this;
    const sourceDecimals = getAsset(intent.source.chain, intent.source.asset).decimals;
    const destinationDecimals = getAsset(intent.destination.chain, intent.destination.asset).decimals;
    if (client.nativeToEthRatio !== 10n ** BigInt(destinationDecimals - sourceDecimals)) {
      throw new RelayMeshError(
        "INTEGRITY_ERROR",
        `Chain nativeToEthRatio ${client.nativeToEthRatio} does not match the registry decimals ${sourceDecimals} -> ${destinationDecimals}`,
      );
    }

    const h160 = intent.destination.recipient.toLowerCase() as Hex;
    const sender = decodeAddress(intent.requester);
    const destinationAccount = (await client.originalAccount(h160)) ?? fallbackAccountIdForH160(h160);
    if (u8aEq(destinationAccount, sender)) {
      return { ok: false, code: "INVALID_RECIPIENT", reason: "This EVM address is mapped to the sender's own account" };
    }

    const amount = intent.source.amount;
    const ed = client.existentialDeposit;
    const serviceFee = await this.serviceFeeFor(destinationAccount, sender);
    const [senderBalance, destinationBalance, estimate] = await Promise.all([
      client.balance(sender),
      client.balance(destinationAccount),
      client.estimateTransferKeepAlive(intent.requester, destinationAccount, amount, serviceFee ? { to: decodeAddress(serviceFee.account), amount: serviceFee.amount } : undefined),
    ]);

    const spendable = reducible(senderBalance.free, senderBalance.frozen, ed);
    const needed = amount + (serviceFee?.amount ?? 0n) + estimate.partialFee;
    if (needed > spendable) {
      return {
        ok: false,
        code: "INSUFFICIENT_BALANCE",
        reason: `Needs ${needed} base units (amount${serviceFee ? " + RelayMesh fee" : ""} + estimated network fee) but only ${spendable} is spendable while keeping the account alive`,
      };
    }
    if (destinationBalance.free === 0n && amount < ed) {
      return { ok: false, code: "AMOUNT_TOO_SMALL", reason: `A new destination account needs at least the existential deposit (${ed} base units)` };
    }

    const before = reducible(destinationBalance.free, destinationBalance.frozen, ed);
    const after = reducible(destinationBalance.free + amount, destinationBalance.frozen, ed);
    const expectedOutput = (after - before) * client.nativeToEthRatio;
    if (expectedOutput <= 0n) {
      return { ok: false, code: "AMOUNT_TOO_SMALL", reason: "The transfer would not increase the EVM-visible balance (it is absorbed by the existential deposit or frozen funds)" };
    }

    return { ok: true, value: { destinationAccount, expectedOutput, fee: estimate.partialFee, serviceFee, callHex: estimate.callHex } };
  }

  /**
   * The fee and the native account it is paid to. Waived when the transfer already goes to that
   * account (topping up the relayer) or comes from it.
   */
  private async serviceFeeFor(destinationAccount: Uint8Array, sender: Uint8Array): Promise<{ amount: bigint; account: string } | null> {
    if (!this.serviceFee || this.serviceFee.amount === 0n) return null;
    const h160 = this.serviceFee.recipient.toLowerCase() as Hex;
    const account = (await this.client.originalAccount(h160)) ?? fallbackAccountIdForH160(h160);
    if (u8aEq(account, destinationAccount) || u8aEq(account, sender)) return null;
    return { amount: this.serviceFee.amount, account: encodeAddress(account, this.client.ss58Prefix) };
  }
}
