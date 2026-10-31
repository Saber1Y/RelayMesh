import { createV3NativeClient } from "@relaymesh/chains";
import { normalizeAddress } from "@relaymesh/core";
import { handleError, json } from "@/server/http";
import { getSubstrateApi } from "@/server/services";

export const runtime = "nodejs";

/**
 * A PortalDot V3 account's native balance, read from the chain at the best block: `free`, and
 * `spendable`, what it can send while staying alive (free less the larger of its frozen funds and the
 * existential deposit). The quote re-checks this with the fees, so it is shown as a guide only.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ address: string }> }) {
  try {
    const address = normalizeAddress("portaldot-v3-substrate", decodeURIComponent((await ctx.params).address), "address");
    const client = createV3NativeClient(await getSubstrateApi());
    const { free, frozen } = await client.balance(address);
    const locked = frozen > client.existentialDeposit ? frozen : client.existentialDeposit;
    return json({ address, free, spendable: free > locked ? free - locked : 0n, existentialDeposit: client.existentialDeposit });
  } catch (error) {
    return handleError(error);
  }
}
