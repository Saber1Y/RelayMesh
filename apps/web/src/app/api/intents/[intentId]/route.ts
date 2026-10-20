import type { Hex } from "viem";
import { errorResponse, handleError, HEX16, json } from "@/server/http";
import { getIntentView } from "@/server/intent-view";
import { nowSeconds } from "@/server/services";

export const runtime = "nodejs";

export async function GET(_request: Request, ctx: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await ctx.params;
  if (!HEX16.test(intentId)) return errorResponse("INVALID_INTENT", "Malformed intent ID", 400);
  try {
    const view = await getIntentView(intentId as Hex, nowSeconds());
    return view ? json(view) : errorResponse("NOT_FOUND", "Intent not found", 404);
  } catch (error) {
    return handleError(error);
  }
}
