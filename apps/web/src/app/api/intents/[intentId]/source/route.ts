import type { Hex } from "viem";
import { z } from "zod";
import { verifySubstrateExtrinsic } from "@relaymesh/chains";
import { currentStatus, type Evidence } from "@relaymesh/core";
import { appendStatusEvent, listExecutionPlans, loadIntent } from "@relaymesh/db";
import { errorResponse, handleError, HEX16, HEX32, json, readJson } from "@/server/http";
import { getDb, getSubstrateApi, nowSeconds } from "@/server/services";

export const runtime = "nodejs";

const Body = z.object({ txHash: z.string().regex(HEX32), blockHash: z.string().regex(HEX32) }).strict();

/**
 * The browser reports where its signed extrinsic was included. Nothing is recorded from that report
 * alone: the server reads the block from the chain and checks the extrinsic is the planned call,
 * signed by the requester, before moving the intent forward.
 */
export async function POST(request: Request, ctx: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await ctx.params;
  if (!HEX16.test(intentId)) return errorResponse("INVALID_INTENT", "Malformed intent ID", 400);
  const parsed = Body.safeParse(await readJson(request));
  if (!parsed.success) return errorResponse("INVALID_INTENT", "Body must be { txHash, blockHash } as 32-byte lowercase hex", 400);
  const txHash = parsed.data.txHash as Hex;
  const blockHash = parsed.data.blockHash as Hex;
  const db = getDb();

  try {
    const stored = await loadIntent(db, intentId as Hex);
    if (!stored) return errorResponse("NOT_FOUND", "Intent not found", 404);
    const status = currentStatus(stored.history);

    // Idempotent: the same report twice returns the recorded event.
    const recorded = stored.history.find((e) => e.evidence?.kind === "source_transaction" && e.evidence.txHash === txHash);
    if (recorded) return json({ event: recorded, replayed: true });
    if (status !== "AWAITING_SIGNATURE") return errorResponse("INVALID_TRANSITION", `Intent is ${status}, not awaiting a signature`, 409);

    const plans = (await listExecutionPlans(db, intentId as Hex)).filter((p) => p.quoteId === stored.selectedQuoteId);
    const first = plans[0];
    if (!first) return errorResponse("MISSING_EVIDENCE", "No execution plan was issued for the selected quote", 409);

    const api = await getSubstrateApi();
    const result = await verifySubstrateExtrinsic(api, { blockHash, txHash, expectedCallHex: first.callHex, expectedSigner: stored.intent.requester });
    if (!result.found) return errorResponse("SOURCE_NOT_FOUND", result.reason, 422);
    const plan = plans.find((p) => p.callHex === result.callHex);
    if (!plan) return errorResponse("SOURCE_MISMATCH", "The included extrinsic is not the call RelayMesh asked you to sign", 422);
    if (!result.signerMatches) return errorResponse("SOURCE_MISMATCH", "The extrinsic was not signed by the intent's requester", 422);

    const now = nowSeconds();
    const evidence: Evidence = {
      kind: "source_transaction",
      chain: stored.intent.source.chain,
      method: "substrate_block_extrinsic",
      txHash,
      blockHash,
      blockNumber: result.blockNumber,
      finalized: false,
      observedAt: now,
      details: { extrinsicIndex: String(result.extrinsicIndex), planId: plan.planId, events: result.events.join(",") },
    };
    const event = result.success
      ? await appendStatusEvent(db, intentId as Hex, {
          status: "SOURCE_SUBMITTED",
          at: now,
          reason: `included in block ${result.blockNumber}; awaiting finality`,
          evidence,
        })
      : await appendStatusEvent(db, intentId as Hex, {
          status: "FAILED_BEFORE_SOURCE",
          at: now,
          reason: `extrinsic failed on chain: ${result.dispatchError ?? "unknown error"}; no funds were transferred`,
          evidence,
        });
    return json({ event, replayed: false });
  } catch (error) {
    return handleError(error);
  }
}
