import { json } from "@/server/http";
import { getSubstrateApi, nowSeconds, v3Config } from "@/server/services";

export const runtime = "nodejs";

/**
 * Live chain status for the header. `finalizedAgeSeconds` is how long ago the latest finalized block
 * was produced, so a chain that stopped making blocks shows as stalled rather than healthy. Errors are
 * reported as unreachable rather than hidden.
 */
export async function GET() {
  try {
    const api = await getSubstrateApi();
    const hash = await api.rpc.chain.getFinalizedHead();
    const [header, moment] = await Promise.all([api.rpc.chain.getHeader(hash), (await api.at(hash)).query.timestamp.now()]);
    const finalizedAt = Math.floor(moment.toNumber() / 1000);
    return json({
      reachable: true,
      finalized: header.number.toNumber(),
      finalizedAt,
      finalizedAgeSeconds: Math.max(0, nowSeconds() - finalizedAt),
      specVersion: api.runtimeVersion.specVersion.toNumber(),
      chainId: v3Config.evmChainId,
    });
  } catch (error) {
    console.error("[relaymesh] network status failed", error);
    return json({ reachable: false, chainId: v3Config.evmChainId }, { status: 503 });
  }
}
