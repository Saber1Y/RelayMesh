import { RelayMeshError } from "@relaymesh/core";
import type { ExecutionPlan, ProviderStatus, QuoteResult, RouteProvider } from "../types";

export const IBRIDGE_PROVIDER_ID = "portaldot-ibridge";

const UNAVAILABLE_REASON =
  "PortalDot has confirmed iBridge stays closed to third parties through demo day, and the V3 testnet runtime has no bridge pallet. " +
  "This slot will be implemented once PortalDot opens a programmatic interface; transfers through PortalDot's public bridge can already be checked on the Bridge page.";

/**
 * Placeholder for PortalDot's iBridge. It is listed so the UI can show the route honestly as
 * unavailable. It never returns quotes, fixtures or simulated data.
 */
export class IBridgeProvider implements RouteProvider {
  readonly id = IBRIDGE_PROVIDER_ID;
  readonly name = "PortalDot iBridge";
  readonly description = "Cross-chain transfers between PortalDot and EVM networks. Awaiting a public interface from PortalDot.";

  status(): ProviderStatus {
    return { available: false, reason: UNAVAILABLE_REASON, checkedOn: "2026-10-24" };
  }

  supports(): boolean {
    return false;
  }

  async quote(): Promise<QuoteResult> {
    return { ok: false, code: "PROVIDER_UNAVAILABLE", reason: UNAVAILABLE_REASON };
  }

  async buildExecution(): Promise<ExecutionPlan> {
    throw new RelayMeshError("UNSUPPORTED_ROUTE", UNAVAILABLE_REASON);
  }
}
