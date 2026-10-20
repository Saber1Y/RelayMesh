import { json } from "@/server/http";
import { getSubstrateApi, v3Config } from "@/server/services";

export const runtime = "nodejs";

/** Live chain status for the header. Errors are reported as unreachable rather than hidden. */
export async function GET() {
  try {
    const api = await getSubstrateApi();
    const hash = await api.rpc.chain.getFinalizedHead();
    const header = await api.rpc.chain.getHeader(hash);
    return json({ reachable: true, finalized: header.number.toNumber(), specVersion: api.runtimeVersion.specVersion.toNumber(), chainId: v3Config.evmChainId });
  } catch (error) {
    console.error("[relaymesh] network status failed", error);
    return json({ reachable: false, chainId: v3Config.evmChainId }, { status: 503 });
  }
}
