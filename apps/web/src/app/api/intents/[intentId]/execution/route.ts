import type { Hex } from "viem";
import { z } from "zod";
import { currentStatus } from "@relaymesh/core";
import { addExecutionPlan, listQuotes, loadIntent, selectQuote, type ExecutionPlanRecord } from "@relaymesh/db";
import type { ExecutionPlan } from "@relaymesh/routes";
import { errorResponse, handleError, HEX16, json, readJson } from "@/server/http";
import { getDb, getProviders, nowSeconds } from "@/server/services";

export const runtime = "nodejs";

const Body = z.object({ quoteId: z.string().min(1).max(200) }).strict();

function toRecord(plan: ExecutionPlan, now: number): ExecutionPlanRecord {
  return {
    planId: `plan-${crypto.randomUUID()}`,
    quoteId: plan.quoteId,
    kind: plan.kind,
    chain: plan.chain,
    signer: plan.signer,
    callHex: plan.callHex,
    destinationAccount: plan.destinationAccount,
    estimatedFee: plan.estimatedFee,
    submitBefore: plan.submitBefore,
    createdAt: now,
  };
}

/**
 * Selects a quote and returns the unsigned call for the wallet. The provider re-reads chain state first,
 * so a plan is never issued for a quote that no longer holds. Re-opening the review for the selected
 * quote issues a fresh plan without changing status.
 */
export async function POST(request: Request, ctx: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await ctx.params;
  if (!HEX16.test(intentId)) return errorResponse("INVALID_INTENT", "Malformed intent ID", 400);
  const parsed = Body.safeParse(await readJson(request));
  if (!parsed.success) return errorResponse("INVALID_INTENT", "Body must be { quoteId }", 400, "quoteId");
  const { quoteId } = parsed.data;
  const db = getDb();

  try {
    const stored = await loadIntent(db, intentId as Hex);
    if (!stored) return errorResponse("NOT_FOUND", "Intent not found", 404);
    const quote = (await listQuotes(db, intentId as Hex)).find((q) => q.quoteId === quoteId);
    if (!quote) return errorResponse("QUOTE_MISMATCH", "Quote not found for this intent", 404, "quoteId");
    const provider = (await getProviders()).find((p) => p.id === quote.provider);
    if (!provider) return errorResponse("UNSUPPORTED_ROUTE", `Provider ${quote.provider} is not configured`, 409);

    const status = currentStatus(stored.history);
    const reopening = status === "AWAITING_SIGNATURE" && stored.selectedQuoteId === quoteId;
    if (status !== "QUOTED" && !reopening) {
      return errorResponse("INVALID_TRANSITION", `Cannot select a route while the intent is ${status}`, 409);
    }

    const now = nowSeconds();
    const plan = await provider.buildExecution(stored.intent, quote, { now });
    const record = toRecord(plan, now);
    if (reopening) await addExecutionPlan(db, intentId as Hex, record);
    else await selectQuote(db, intentId as Hex, quoteId, now, record);
    return json({ plan, planId: record.planId });
  } catch (error) {
    return handleError(error);
  }
}
