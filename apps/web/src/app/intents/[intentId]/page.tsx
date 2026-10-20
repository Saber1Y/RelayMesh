import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { Hex } from "viem";
import { IntentWorkspace, type WireView } from "@/components/intent-workspace";
import { HEX16 } from "@/server/http";
import { getIntentView } from "@/server/intent-view";
import { describeProviders, nowSeconds, v3Config } from "@/server/services";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Intent | RelayMesh" };

export default async function IntentPage({ params }: { params: Promise<{ intentId: string }> }) {
  const { intentId } = await params;
  if (!HEX16.test(intentId)) notFound();
  const view = await getIntentView(intentId as Hex, nowSeconds());
  if (!view) notFound();

  // Same wire format as the API: bigint amounts become decimal strings.
  const wire = JSON.parse(JSON.stringify(view, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as WireView;
  const unavailable = describeProviders().flatMap((p) => (p.status.available ? [] : [{ name: p.name, reason: p.status.reason }]));

  return <IntentWorkspace initial={wire} wsUrl={v3Config.wsUrl} unavailableProviders={unavailable} />;
}
