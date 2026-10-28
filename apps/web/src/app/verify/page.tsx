import type { Metadata } from "next";
import type { Hex } from "viem";
import { listRecentIntents } from "@relaymesh/db";
import { PageShell } from "@/components/page-shell";
import { ReceiptVerifier, type VerifierExample } from "@/components/receipt-verifier";
import { stagger } from "@/components/ui";
import { formatAmount } from "@/lib/format";
import { HEX16 } from "@/server/http";
import { getDb, v3Config } from "@/server/services";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Verify a receipt | RelayMesh" };

const HEX_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Where the registry lives, from the same environment the watcher anchors with. */
function registryConfig(): { address: Hex; fromBlock: bigint | null } | null {
  const address = process.env.INTENT_REGISTRY_ADDRESS;
  if (!address || !HEX_ADDRESS.test(address)) return null;
  const from = process.env.INTENT_REGISTRY_DEPLOY_BLOCK;
  return { address: address as Hex, fromBlock: from && /^\d+$/.test(from) ? BigInt(from) : null };
}

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ intent?: string }> }) {
  const { intent } = await searchParams;
  const registry = registryConfig();
  const recent = await listRecentIntents(getDb(), 40).catch(() => []);
  const examples: VerifierExample[] = recent
    .filter((i) => i.status === "SETTLED")
    .slice(0, 3)
    .map((i) => ({ intentId: i.intentId, label: formatAmount(i.sourceAmount, i.sourceChain) }));

  return (
    <PageShell narrow>
      <div className="grid gap-6">
        <div className="enter grid gap-3" style={stagger(0)}>
          <p className="text-sm font-medium text-accent">Verify</p>
          <h1 className="text-3xl font-semibold tracking-[-0.03em] sm:text-4xl">Check a receipt against the chain</h1>
          <p className="max-w-[60ch] text-muted">
            Your browser hashes the receipt and reads <span className="text-ink">IntentRegistry</span> on PortalDot V3 itself. RelayMesh’s server is never asked whether
            it matches.
          </p>
        </div>
        <ReceiptVerifier
          rpcUrl={v3Config.evmRpcUrl}
          explorerUrl={v3Config.explorerUrl}
          registry={registry && { address: registry.address, fromBlock: registry.fromBlock?.toString() ?? null }}
          initialIntentId={intent && HEX16.test(intent) ? intent : null}
          examples={examples}
        />
      </div>
    </PageShell>
  );
}
