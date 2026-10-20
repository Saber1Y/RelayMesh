import type { Hex } from "viem";
import { buildReceipt, hashReceipt, serializeReceipt } from "@relaymesh/core";
import { listQuotes, loadIntent } from "@relaymesh/db";
import { errorResponse, handleError, HEX16 } from "@/server/http";
import { getDb } from "@/server/services";

export const runtime = "nodejs";

/** Canonical receipt JSON. Re-hashing the body with the relaymesh.receipt.v1 domain reproduces X-Receipt-Hash. */
export async function GET(request: Request, ctx: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await ctx.params;
  if (!HEX16.test(intentId)) return errorResponse("INVALID_INTENT", "Malformed intent ID", 400);
  const db = getDb();
  try {
    const stored = await loadIntent(db, intentId as Hex);
    if (!stored) return errorResponse("NOT_FOUND", "Intent not found", 404);
    const quote = (await listQuotes(db, intentId as Hex)).find((q) => q.quoteId === stored.selectedQuoteId);
    if (!quote) return errorResponse("INVALID_TRANSITION", "No route has been selected yet, so there is no receipt", 409);

    const receipt = buildReceipt({ intent: stored.intent, intentHash: stored.intentHash, quote, history: stored.history });
    const download = new URL(request.url).searchParams.get("download") === "1";
    return new Response(serializeReceipt(receipt), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-receipt-hash": hashReceipt(receipt),
        ...(download && { "content-disposition": `attachment; filename="relaymesh-receipt-${intentId}.json"` }),
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
