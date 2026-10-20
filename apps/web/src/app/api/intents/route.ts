import { createIntent, hashRequest } from "@relaymesh/core";
import { insertIntent } from "@relaymesh/db";
import { errorResponse, handleError, json, readJson } from "@/server/http";
import { getDb, nowSeconds } from "@/server/services";

export const runtime = "nodejs";

/** Creates an intent. Requires an Idempotency-Key header so retries never create duplicates. */
export async function POST(request: Request) {
  const key = request.headers.get("idempotency-key");
  if (!key) return errorResponse("IDEMPOTENCY_KEY_INVALID", "Idempotency-Key header is required", 400, "idempotencyKey");
  const body = await readJson(request);
  if (body === undefined) return errorResponse("INVALID_INTENT", "Request body must be JSON", 400);

  try {
    const { intent, intentHash } = createIntent(body, { now: nowSeconds() });
    const result = await insertIntent(getDb(), { intent, intentHash, idempotencyKey: key, requestHash: hashRequest(body) });
    return json({ intentId: result.intentId, replayed: result.kind === "replayed" }, { status: result.kind === "created" ? 201 : 200 });
  } catch (error) {
    return handleError(error);
  }
}
