import { u8aEq } from "@polkadot/util";
import { decodeAddress } from "@polkadot/util-crypto";
import { findBridgePayouts, readBridgeDeposit } from "@relaymesh/chains";
import { assessBridgeTransfer, expectedPayout, hashBridgeCheck, parseDepositId } from "@relaymesh/core";
import type { Hex } from "viem";
import { errorResponse, handleError, json } from "@/server/http";
import { bridgeConfig, getBscClient, getMainnetApi } from "@/server/services";

export const runtime = "nodejs";

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

function sameAccount(a: string, b: string): boolean {
  try {
    return u8aEq(decodeAddress(a), decodeAddress(b));
  } catch {
    return false;
  }
}

/**
 * Checks one PortalDot bridge transfer from the chains themselves: the deposit from the Portaldot
 * mainnet node, the payout from BSC. No bridge API is used, so the bridge's own records are not trusted.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const recipientParam = params.get("recipient")?.trim() || null;
  if (recipientParam && !EVM_ADDRESS.test(recipientParam)) return errorResponse("INVALID_INPUT", "The BSC address must be a 0x address", 400, "recipient");
  try {
    const id = parseDepositId(params.get("deposit") ?? "");
    const deposit = await readBridgeDeposit(await getMainnetApi(), id);
    if (!deposit) return errorResponse("NOT_FOUND", `Portaldot mainnet has no extrinsic ${id.block}-${id.index}`, 404, "deposit");
    const recipient = recipientParam as Hex | null;
    const expected = deposit.amount !== null ? expectedPayout(deposit.amount, bridgeConfig.fee) : null;
    const candidates = expected !== null ? await findBridgePayouts(getBscClient(), bridgeConfig, { after: deposit.time, amount: expected, recipient }) : [];
    const assessment = assessBridgeTransfer({ deposit, depositAddress: bridgeConfig.depositAddress, fee: bridgeConfig.fee, candidates, recipient, sameAccount });
    return json({
      deposit,
      assessment,
      checkHash: hashBridgeCheck(deposit, assessment.payout),
      bridge: {
        depositAddress: bridgeConfig.depositAddress,
        token: bridgeConfig.bsc.token,
        reserve: bridgeConfig.bsc.reserve,
        feeBps: bridgeConfig.fee.feeBps,
        mainnetExplorerUrl: bridgeConfig.mainnetExplorerUrl,
        bscExplorerUrl: bridgeConfig.bsc.explorerUrl,
      },
    });
  } catch (error) {
    return handleError(error);
  }
}
