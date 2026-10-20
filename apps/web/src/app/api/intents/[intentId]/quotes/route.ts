import type { Hex } from "viem";
import { currentStatus } from "@relaymesh/core";
import { appendStatusEvent, loadIntent, recordQuotes } from "@relaymesh/db";
import { collectQuotes } from "@relaymesh/routes";
import { errorResponse, handleError, HEX16, json } from "@/server/http";
import { getDb, getProviders, nowSeconds } from "@/server/services";

export const runtime = "nodejs";

const QUOTABLE = new Set(["DRAFT", "QUOTED", "AWAITING_SIGNATURE"]);

/** Asks every provider for fresh quotes. Rejections are always returned so the UI can explain them. */
export async function POST(_request: Request, ctx: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await ctx.params;
  if (!HEX16.test(intentId)) return errorResponse("INVALID_INTENT", "Malformed intent ID", 400);
  const db = getDb();
  try {
    const stored = await loadIntent(db, intentId as Hex);
    if (!stored) return errorResponse("NOT_FOUND", "Intent not found", 404);
    const status = currentStatus(stored.history);
    if (!QUOTABLE.has(status)) return errorResponse("INVALID_TRANSITION", `Cannot quote an intent in ${status}`, 409);

    const now = nowSeconds();
    if (now >= stored.intent.constraints.deadline) {
      await appendStatusEvent(db, intentId as Hex, { status: "EXPIRED", at: now, reason: "intent deadline passed before signing" });
      return errorResponse("DEADLINE_INVALID", "The intent deadline has passed", 409);
    }

    const { ranked, rejections } = await collectQuotes(await getProviders(), stored.intent, { now });
    if (ranked.length > 0) await recordQuotes(db, intentId as Hex, ranked, now);
    return json({ quotes: ranked, rejections });
  } catch (error) {
    return handleError(error);
  }
}
