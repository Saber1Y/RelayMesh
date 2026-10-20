"use client";

import { CheckCircle, PenNib, WarningCircle } from "@phosphor-icons/react";
import { u8aEq } from "@polkadot/util";
import { decodeAddress } from "@polkadot/util-crypto";
import { useEffect, useRef, useState } from "react";
import type { Hex } from "viem";
import type { ExecutionPlanRecord } from "@relaymesh/db";
import { ApiRequestError, apiFetch, type Wire } from "@/lib/api";
import { formatAmount, formatDuration, shortHash } from "@/lib/format";
import { connectWallets, decodeCall, signAndSubmit, type DecodedCall, type SubmitPhase } from "@/lib/wallet";
import type { WireView } from "./intent-workspace";
import { Button, Mono, Panel, Skeleton } from "./ui";

type Phase =
  | { kind: "idle" }
  | { kind: "connecting" }
  | { kind: SubmitPhase }
  | { kind: "verifying" }
  | { kind: "error"; message: string };

/** Give up on decoding after this long and offer a retry, rather than leaving the button disabled silently. */
const DECODE_TIMEOUT_SECONDS = 45;

const PHASE_LABEL: Record<string, string> = {
  connecting: "Opening wallet",
  "awaiting-wallet": "Confirm in your wallet",
  broadcast: "Broadcasting",
  "in-block": "Included, verifying",
  verifying: "Verifying on chain",
};

function sameAccount(a: string, b: string): boolean {
  try {
    return u8aEq(decodeAddress(a), decodeAddress(b));
  } catch {
    return false;
  }
}

/** Checks the browser-decoded call against the intent, so a wrong plan from the server is caught before signing. */
function checkCall(decoded: DecodedCall, view: WireView, plan: Wire<ExecutionPlanRecord>): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (decoded.section !== "balances" || decoded.method !== "transferKeepAlive") problems.push(`Unexpected call ${decoded.section}.${decoded.method}`);
  const value = decoded.args.value?.replace(/[^0-9]/g, "");
  if (value !== view.intent.source.amount) problems.push("The amount in the call does not match the intent");
  const dest = decoded.args.dest ?? "";
  if (!dest.includes(plan.destinationAccount)) problems.push("The destination in the call does not match the plan");
  return { ok: problems.length === 0, problems };
}

async function reportInclusion(intentId: string, txHash: Hex, blockHash: Hex): Promise<void> {
  // The node serving the API can lag the one the wallet used by a block, so retry briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      await apiFetch(`/api/intents/${intentId}/source`, { method: "POST", body: JSON.stringify({ txHash, blockHash }) });
      return;
    } catch (error) {
      const retriable = error instanceof ApiRequestError && (error.error.code === "SOURCE_NOT_FOUND" || error.status === 0);
      if (!retriable || attempt >= 4) throw error;
      await new Promise((r) => setTimeout(r, 2_000));
    }
  }
}

export function SignPanel({
  view,
  plan,
  now,
  wsUrl,
  onSubmitted,
}: {
  view: WireView;
  plan: Wire<ExecutionPlanRecord>;
  now: number;
  wsUrl: string;
  onSubmitted: () => void;
}) {
  const [decoded, setDecoded] = useState<{ state: "loading" } | { state: "ok"; call: DecodedCall } | { state: "error"; message: string }>({ state: "loading" });
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [inclusion, setInclusion] = useState<{ txHash: Hex; blockHash: Hex }>();

  const [attempt, setAttempt] = useState(0);
  const [decodeStartedAt, setDecodeStartedAt] = useState(now);
  // Latest clock value, read inside the effect without re-running it every second.
  const nowRef = useRef(now);
  nowRef.current = now;

  useEffect(() => {
    let cancelled = false;
    setDecoded({ state: "loading" });
    setDecodeStartedAt(nowRef.current);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`no answer from the V3 node after ${DECODE_TIMEOUT_SECONDS}s`)), DECODE_TIMEOUT_SECONDS * 1000),
    );
    Promise.race([decodeCall(wsUrl, plan.callHex as Hex), timeout])
      .then((call) => !cancelled && setDecoded({ state: "ok", call }))
      .catch((e: unknown) => !cancelled && setDecoded({ state: "error", message: e instanceof Error ? e.message : "Could not reach the V3 node" }));
    return () => {
      cancelled = true;
    };
  }, [wsUrl, plan.callHex, attempt]);

  const check = decoded.state === "ok" ? checkCall(decoded.call, view, plan) : undefined;
  const remaining = plan.submitBefore - now;
  const expired = remaining <= 0;
  const busy = phase.kind !== "idle" && phase.kind !== "error";

  async function sign() {
    setPhase({ kind: "connecting" });
    try {
      const wallet = await connectWallets();
      if (wallet.state === "no-extension") {
        setPhase({ kind: "error", message: "No Polkadot wallet extension found. Install Talisman, SubWallet or polkadot.js, then try again." });
        return;
      }
      const account = wallet.accounts.find((a) => a.kind === "substrate" && sameAccount(a.address, plan.signer));
      if (!account) {
        setPhase({ kind: "error", message: `None of your wallet accounts is ${shortHash(plan.signer, 8, 6)}. Import it into your wallet, or create a new intent from an account you hold.` });
        return;
      }
      const included = await signAndSubmit(wsUrl, account, plan.callHex as Hex, (p) => setPhase({ kind: p }));
      setInclusion(included);
      setPhase({ kind: "verifying" });
      await reportInclusion(view.intent.intentId, included.txHash, included.blockHash);
      setPhase({ kind: "idle" });
      onSubmitted();
    } catch (error) {
      setPhase({ kind: "error", message: error instanceof Error ? error.message : "Signing failed." });
    }
  }

  return (
    <Panel title="Review and sign" description="Check the call below. Your wallet will ask you to sign exactly these bytes." index={2}>
      <div className="grid gap-6">
        <dl className="grid gap-x-6 gap-y-4 text-sm sm:grid-cols-2">
          <div className="grid gap-1">
            <dt className="text-muted">Signer</dt>
            <dd>
              <Mono title={plan.signer}>{shortHash(plan.signer, 8, 6)}</Mono>
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-muted">Credited account</dt>
            <dd>
              <Mono title={plan.destinationAccount}>{shortHash(plan.destinationAccount, 8, 6)}</Mono>
              <span className="block text-muted">controls {shortHash(view.intent.destination.recipient)}</span>
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-muted">Network fee</dt>
            <dd>
              <Mono>{formatAmount(plan.estimatedFee, view.intent.source.chain)}</Mono> <span className="text-muted">estimate</span>
            </dd>
          </div>
          <div className="grid gap-1">
            <dt className="text-muted">Sign before</dt>
            <dd className={remaining <= 15 ? "text-critical" : ""}>{expired ? "Expired" : `${formatDuration(remaining)} left`}</dd>
          </div>
        </dl>

        <div className="grid gap-3 rounded-xl border border-line bg-raised/60 p-4">
          <p className="text-sm font-medium">Call your wallet will sign</p>
          {decoded.state === "loading" && (
            <div className="grid gap-2" role="status">
              <Skeleton className="h-14" />
              <p className="text-[13px] text-muted">
                Connecting your browser to PortalDot V3 to decode the call
                <span className="tabular-nums"> ({Math.max(0, now - decodeStartedAt)}s)</span>. The first visit downloads chain metadata;
                later visits reuse it.
              </p>
            </div>
          )}
          {decoded.state === "error" && (
            <div className="flex flex-wrap items-center gap-3" role="alert">
              <p className="text-sm text-critical">Could not decode the call: {decoded.message}.</p>
              <Button variant="secondary" onClick={() => setAttempt((n) => n + 1)} className="px-3 py-1.5">
                Try again
              </Button>
            </div>
          )}
          {decoded.state === "ok" && (
            <>
              <Mono className="block rounded-lg bg-surface px-3 py-2.5 text-[12.5px] leading-relaxed break-all shadow-[0_1px_0_rgb(20_32_72/0.03)]">
                {decoded.call.section}.{decoded.call.method}({Object.entries(decoded.call.args).map(([k, v], i) => `${i ? ", " : ""}${k}: ${v}`)})
              </Mono>
              <p className={`flex items-start gap-2 text-sm ${check?.ok ? "text-positive" : "text-critical"}`}>
                {check?.ok ? <CheckCircle size={16} className="mt-0.5 shrink-0" /> : <WarningCircle size={16} className="mt-0.5 shrink-0" />}
                {check?.ok ? "Decoded in your browser from PortalDot V3 metadata. It matches this intent." : check?.problems.join(". ")}
              </p>
            </>
          )}
        </div>

        {expired ? (
          <p className="rounded-lg bg-caution-soft px-3 py-2 text-sm text-caution">This signing window closed. Refresh quotes above to get a new route.</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={sign} disabled={busy || !check?.ok} className="px-5 py-2.5">
              <PenNib size={16} />
              {busy ? PHASE_LABEL[phase.kind] : decoded.state === "ok" ? "Sign in wallet" : "Waiting for the decoded call"}
            </Button>
            {inclusion && (
              <span className="text-sm text-muted">
                Tx <Mono title={inclusion.txHash}>{shortHash(inclusion.txHash)}</Mono>
              </span>
            )}
          </div>
        )}

        {phase.kind === "error" && (
          <p role="alert" className="rounded-lg bg-critical-soft px-3 py-2 text-sm text-critical">
            {phase.message}
          </p>
        )}
      </div>
    </Panel>
  );
}
