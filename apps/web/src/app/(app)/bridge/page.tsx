import type { Metadata } from "next";
import { BridgeChecker } from "@/components/bridge-checker";
import { PageShell } from "@/components/page-shell";
import { stagger } from "@/components/ui";
import { batchContracts, v3Config } from "@/server/services";

export const metadata: Metadata = { title: "Bridge checker | RelayMesh" };

const DEPOSIT_ID = /^\d{1,12}-\d{1,6}$/;

export default async function BridgePage({ searchParams }: { searchParams: Promise<{ deposit?: string }> }) {
  const { deposit } = await searchParams;
  return (
    <PageShell narrow>
      <div className="grid gap-6">
        <div className="enter grid gap-3" style={stagger(0)}>
          <p className="text-sm font-medium text-accent">Bridge checker · Portaldot mainnet to BSC</p>
          <h1 className="text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Did the bridge pay out?</h1>
          <p className="max-w-[62ch] text-muted">
            The PortalDot bridge takes POT on Portaldot and pays WPOT on BSC, hours later. RelayMesh reads both chains to check a transfer: the deposit landed and succeeded,
            and the exact amount after the fee arrived on BSC. Each verified transfer is then anchored on PortalDot V3. Read-only: it never touches your funds or the bridge.
          </p>
        </div>
        <BridgeChecker initialDeposit={deposit && DEPOSIT_ID.test(deposit) ? deposit : null} v3={{ rpcUrl: v3Config.evmRpcUrl, explorerUrl: v3Config.explorerUrl, batchContracts: batchContracts().all }} />
      </div>
    </PageShell>
  );
}
