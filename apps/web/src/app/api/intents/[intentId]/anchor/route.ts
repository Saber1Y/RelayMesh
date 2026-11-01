import type { Hex } from "viem";
import { getReceiptBatchProof, loadIntent } from "@relaymesh/db";
import { errorResponse, handleError, HEX16, json } from "@/server/http";
import { batchContracts, getDb } from "@/server/services";

export const runtime = "nodejs";

/**
 * Where this intent's receipt is anchored in ReceiptBatchRegistry: the receipt hash, the Merkle proof
 * from its leaf to the batch root, and the recording transaction. `batch` is null until the batch
 * holding it is mined. Nothing here needs trusting: the receipt checker recomputes the leaf and
 * reads the root from the chain.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await ctx.params;
  if (!HEX16.test(intentId)) return errorResponse("INVALID_INTENT", "Malformed intent ID", 400);
  const db = getDb();
  try {
    if (!(await loadIntent(db, intentId as Hex))) return errorResponse("NOT_FOUND", "Intent not found", 404);
    return json({ batch: await getReceiptBatchProof(db, intentId as Hex, batchContracts().all) });
  } catch (error) {
    return handleError(error);
  }
}
