import { errorResponse, json } from "@/server/http";
import { bridgeConfig } from "@/server/services";

export const runtime = "nodejs";

interface ExplorerTransfer {
  indexer: { blockHeight: number; extrinsicIndex: number; blockTime: number };
  from: string;
  to: string;
  balance: string;
}

let cached: { at: number; body: unknown } | null = null;
const CACHE_MS = 60_000;

/**
 * Recent deposits into the bridge, as examples to check. The list comes from PortalDot's own block
 * explorer (an index RelayMesh does not run); every check of a deposit then reads the chains directly.
 */
export async function GET() {
  if (cached && Date.now() - cached.at < CACHE_MS) return json(cached.body);
  const api = bridgeConfig.mainnetExplorerApiUrl;
  try {
    const response = await fetch(`${api}/accounts/${bridgeConfig.depositAddress}/transfers?page=0&page_size=40`, {
      headers: { "user-agent": "RelayMesh" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return errorResponse("UPSTREAM", "PortalDot's explorer did not return recent deposits", 502);
    const { items } = (await response.json()) as { items: ExplorerTransfer[] };
    const deposits = items
      .filter((t) => t.to === bridgeConfig.depositAddress)
      .map((t) => ({ id: `${t.indexer.blockHeight}-${t.indexer.extrinsicIndex}`, from: t.from, amount: t.balance, time: Math.floor(t.indexer.blockTime / 1000) }));
    const body = { deposits, source: `${api}/accounts/${bridgeConfig.depositAddress}/transfers` };
    cached = { at: Date.now(), body };
    return json(body);
  } catch {
    return errorResponse("UPSTREAM", "PortalDot's explorer is not reachable right now", 502);
  }
}
