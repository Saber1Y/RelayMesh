"use client";

import { ArrowRight, ArrowSquareOut, CircleNotch, HourglassMedium, MagnifyingGlass, SealCheck, SealWarning, Clock } from "@phosphor-icons/react";
import { receiptBatchRegistryAbi } from "@relaymesh/contracts/abi/ReceiptBatchRegistry";
import { BRIDGE_CHECK_DOMAIN, bridgeCheckLeaf, formatBaseUnits, hashCanonical, merkleRootFromProof } from "@relaymesh/core";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPublicClient, http, type Hex } from "viem";
import { CopyButton } from "./copy-button";
import { Button, inputClass, Mono, Panel } from "./ui";
import { explorerBlockUrl, shortHash, type Tone } from "@/lib/format";

type Verdict = "verified" | "payout_pending" | "not_final" | "not_a_deposit";

interface CheckResult {
  deposit: {
    id: { block: number; index: number };
    blockHash: string;
    extrinsicHash: string;
    time: number;
    finalized: boolean;
    signer: string | null;
    call: string;
    destination: string | null;
    amount: string | null;
    success: boolean | null;
  };
  assessment: {
    verdict: Verdict;
    expected: string | null;
    payout: { txHash: string; blockNumber: string; time: number; recipient: string; amount: string; finalized: boolean } | null;
    problems: string[];
  };
  checkHash: string;
  /** Where RelayMesh's record of this verified transfer stands in ReceiptBatchRegistry; null when not recorded. */
  anchor:
    | ({ checkHash: Hex; contract: Hex } & (
        | { status: "queued" }
        | { status: "batching"; root: Hex; leafHash: Hex; proof: Hex[] }
        | { status: "anchored"; root: Hex; leafHash: Hex; proof: Hex[]; leafCount: number; txHash: Hex; blockNumber: string }
      ))
    | null;
  bridge: { depositAddress: string; token: string; reserve: string; feeBps: number; mainnetExplorerUrl: string; bscExplorerUrl: string };
}

interface RecentDeposit {
  id: string;
  from: string;
  amount: string;
  time: number;
}

const VERDICT: Record<Verdict, { tone: Tone; title: string; body: string; icon: ReactNode }> = {
  verified: {
    tone: "positive",
    title: "Bridge transfer verified on both chains",
    body: "The POT deposit is final and succeeded on Portaldot, and the bridge paid the exact amount after its fee in WPOT on BSC, in a finalized block.",
    icon: <SealCheck size={22} weight="fill" />,
  },
  payout_pending: {
    tone: "caution",
    title: "Deposit confirmed, payout pending",
    body: "The POT reached the bridge on Portaldot, but no matching WPOT payout is on BSC yet. The bridge pays out in batches, often hours after a deposit.",
    icon: <HourglassMedium size={22} weight="fill" />,
  },
  not_final: {
    tone: "accent",
    title: "Waiting for finality",
    body: "The transfer looks right, but a block involved is not final yet. Check again in a minute.",
    icon: <Clock size={22} weight="fill" />,
  },
  not_a_deposit: {
    tone: "critical",
    title: "Not a bridge deposit",
    body: "This extrinsic is not a successful POT transfer into the bridge's deposit address, so the bridge owes nothing for it.",
    icon: <SealWarning size={22} weight="fill" />,
  },
};

const RING: Record<Tone, string> = {
  positive: "border-positive/30 bg-positive-soft text-positive",
  caution: "border-caution/30 bg-caution-soft text-caution",
  critical: "border-critical/30 bg-critical-soft text-critical",
  accent: "border-accent/30 bg-accent-soft text-accent",
  neutral: "border-line bg-raised text-muted",
};

const pot = (v: string) => `${formatBaseUnits(BigInt(v), 14)} POT`;
const wpot = (v: string) => `${formatBaseUnits(BigInt(v), 18)} WPOT`;
const utc = (t: number) => `${new Date(t * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`;

function since(t: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - t) / 60));
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`;
}

function gap(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  return minutes < 60 ? `${minutes} min` : `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** Checks a PortalDot bridge transfer by reading Portaldot mainnet and BSC, through RelayMesh's server. */
interface V3 {
  rpcUrl: string;
  explorerUrl: string;
}

export function BridgeChecker({ initialDeposit, v3 }: { initialDeposit: string | null; v3: V3 }) {
  const [deposit, setDeposit] = useState(initialDeposit ?? "");
  const [recipient, setRecipient] = useState("");
  const [state, setState] = useState<{ kind: "idle" } | { kind: "working" } | { kind: "done"; result: CheckResult } | { kind: "error"; message: string }>({ kind: "idle" });
  const [recent, setRecent] = useState<RecentDeposit[] | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const ran = useRef(false);

  useEffect(() => {
    fetch("/api/bridge/recent")
      .then((r) => (r.ok ? (r.json() as Promise<{ deposits: RecentDeposit[] }>) : Promise.reject(new Error())))
      .then((d) => setRecent(d.deposits.slice(0, 8)))
      .catch(() => setRecent([]));
    setNow(Math.floor(Date.now() / 1000));
  }, []);

  const run = useCallback(async (depositInput: string, recipientInput: string) => {
    setState({ kind: "working" });
    try {
      const qs = new URLSearchParams({ deposit: depositInput.trim(), ...(recipientInput.trim() && { recipient: recipientInput.trim() }) });
      const response = await fetch(`/api/bridge/check?${qs}`, { cache: "no-store" });
      const body = (await response.json().catch(() => null)) as (CheckResult & { error?: { message: string } }) | null;
      if (!response.ok || !body || body.error) throw new Error(body?.error?.message ?? "The check could not be completed. The Portaldot or BSC node may be slow; try again.");
      setState({ kind: "done", result: body });
    } catch (error) {
      setState({ kind: "error", message: error instanceof Error ? error.message : "The check failed" });
    }
  }, []);

  useEffect(() => {
    if (ran.current || !initialDeposit) return;
    ran.current = true;
    void run(initialDeposit, "");
  }, [initialDeposit, run]);

  const working = state.kind === "working";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (deposit.trim()) void run(deposit, recipient);
  }

  return (
    <>
      <Panel index={1}>
        <form onSubmit={submit} className="grid gap-4">
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <div className="grid gap-2">
              <label htmlFor="bridge-deposit" className="text-sm font-medium">
                Portaldot deposit
              </label>
              <input
                id="bridge-deposit"
                value={deposit}
                onChange={(e) => setDeposit(e.target.value)}
                placeholder="832820-1, or the explorer link"
                spellCheck={false}
                autoComplete="off"
                className={`${inputClass} font-mono`}
              />
              <p className="text-[13px] text-muted">The extrinsic ID from the Portaldot explorer: block, then index.</p>
            </div>
            <div className="grid gap-2">
              <label htmlFor="bridge-recipient" className="text-sm font-medium">
                Your BSC address <span className="font-normal text-muted">(optional)</span>
              </label>
              <input
                id="bridge-recipient"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="0x…"
                spellCheck={false}
                autoComplete="off"
                className={`${inputClass} font-mono`}
              />
              <p className="text-[13px] text-muted">Pins the match to payouts sent to you.</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-3">
            <Button type="submit" disabled={working || !deposit.trim()}>
              {working ? <CircleNotch size={16} className="animate-spin" /> : <MagnifyingGlass size={16} />}
              {working ? "Reading both chains" : "Check transfer"}
            </Button>
          </div>

          <div className="grid gap-2 border-t border-line pt-4">
            <p className="text-[13px] text-muted">Recent deposits into the bridge (listed by PortalDot’s explorer; each check reads the chains itself):</p>
            {recent === null ? (
              <p className="text-[13px] text-muted">Loading…</p>
            ) : recent.length === 0 ? (
              <p className="text-[13px] text-muted">The explorer did not answer. Paste a deposit ID above instead.</p>
            ) : (
              <div className="flex flex-wrap gap-2">
                {recent.map((d) => (
                  <button
                    key={d.id}
                    type="button"
                    disabled={working}
                    onClick={() => {
                      setDeposit(d.id);
                      setRecipient("");
                      void run(d.id, "");
                    }}
                    className="press rounded-full border border-line bg-surface px-3 py-1 text-[13px] text-ink tabular-nums hover:border-accent-tint disabled:opacity-45"
                  >
                    {pot(d.amount)} <span className="text-muted">· {since(d.time, now)}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </form>
      </Panel>

      <div aria-live="polite">
        {state.kind === "working" && (
          <Panel index={2}>
            <p className="flex items-center gap-2.5 text-sm text-muted">
              <CircleNotch size={16} className="animate-spin text-accent" />
              Reading the deposit from Portaldot mainnet, then searching BSC for the payout…
            </p>
          </Panel>
        )}
        {state.kind === "error" && (
          <Panel index={2}>
            <p className="text-sm text-critical">{state.message}</p>
          </Panel>
        )}
        {state.kind === "done" && <Result result={state.result} v3={v3} />}
      </div>
    </>
  );
}

function Leg({ title, chain, children }: { title: string; chain: string; children: ReactNode }) {
  return (
    <div className="grid content-start gap-3 rounded-xl border border-line bg-raised/40 p-4">
      <div className="grid gap-0.5">
        <p className="text-sm font-semibold">{title}</p>
        <p className="text-[13px] text-muted">{chain}</p>
      </div>
      <dl className="grid gap-2.5 text-sm">{children}</dl>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-[13px] text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Hash({ value, href, label }: { value: string; href?: string; label: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1">
      {href ? (
        <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
          <Mono>{shortHash(value, 10, 8)}</Mono>
          <ArrowSquareOut size={11} />
        </a>
      ) : (
        <Mono>{shortHash(value, 10, 8)}</Mono>
      )}
      <CopyButton value={value} label={label} />
    </span>
  );
}

function Result({ result, v3 }: { result: CheckResult; v3: V3 }) {
  const { deposit, assessment, bridge } = result;
  const verdict = VERDICT[assessment.verdict];
  const id = `${deposit.id.block}-${deposit.id.index}`;
  const payout = assessment.payout;
  return (
    <section className="enter rounded-[18px] border border-line bg-surface shadow-panel" style={{ "--i": 2 } as React.CSSProperties}>
      <div className={`flex items-start gap-3 rounded-t-[18px] border-b px-5 py-4 sm:px-6 ${RING[verdict.tone]}`}>
        <span className="mt-0.5 shrink-0">{verdict.icon}</span>
        <div className="grid gap-1">
          <h2 className="text-base font-semibold">{verdict.title}</h2>
          <p className="text-sm text-ink/80">{verdict.body}</p>
          {assessment.problems.length > 0 && (
            <ul className="mt-1 grid gap-0.5 text-[13px] text-ink/70">
              {assessment.problems.map((p) => (
                <li key={p}>{p}.</li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="grid items-stretch gap-3 p-5 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] sm:p-6">
        <Leg title="Deposit" chain="Portaldot mainnet">
          <Fact label="Amount">
            <span className="font-medium tabular-nums">{deposit.amount ? pot(deposit.amount) : "Not a transfer"}</span>
          </Fact>
          <Fact label="From">
            <Mono className="break-all">{deposit.signer ?? "Unsigned"}</Mono>
          </Fact>
          <Fact label="Extrinsic">
            <Hash value={deposit.extrinsicHash} href={`${bridge.mainnetExplorerUrl}/#/extrinsics/${id}`} label="Copy extrinsic hash" />
          </Fact>
          <Fact label="Result">
            <span className={deposit.success === true && deposit.finalized ? "text-positive" : deposit.success === false ? "text-critical" : "text-caution"}>
              {deposit.success === null ? "Unknown (state discarded)" : deposit.success ? "Succeeded" : "Failed"}
              {deposit.finalized ? ", finalized" : ", not final yet"}
            </span>
          </Fact>
          <Fact label="Time">
            <span className="tabular-nums">{utc(deposit.time)}</span>
          </Fact>
        </Leg>

        <span className="flex size-9 items-center justify-center self-center justify-self-center rounded-full border border-line bg-raised text-muted" aria-hidden>
          <ArrowRight size={16} className="rotate-90 sm:rotate-0" />
        </span>

        <Leg title="Payout" chain="BSC">
          <Fact label="Expected">
            <span className="tabular-nums">
              {assessment.expected ? wpot(assessment.expected) : "Nothing"}{" "}
              {assessment.expected && <span className="text-muted">(after the {bridge.feeBps / 100}% fee)</span>}
            </span>
          </Fact>
          {payout ? (
            <>
              <Fact label="Paid">
                <span className="font-medium tabular-nums text-positive">{wpot(payout.amount)}</span>
              </Fact>
              <Fact label="To">
                <Mono className="break-all">{payout.recipient}</Mono>
              </Fact>
              <Fact label="Transaction">
                <Hash value={payout.txHash} href={`${bridge.bscExplorerUrl}/tx/${payout.txHash}`} label="Copy BSC transaction hash" />
              </Fact>
              <Fact label="Time">
                <span className="tabular-nums">
                  {utc(payout.time)} <span className="text-muted">({gap(payout.time - deposit.time)} after the deposit)</span>
                </span>
              </Fact>
            </>
          ) : (
            <Fact label="Paid">
              <span className="text-muted">{assessment.expected ? "No matching payout yet" : "Nothing owed"}</span>
            </Fact>
          )}
        </Leg>
      </div>

      <div className="grid gap-1.5 border-t border-line px-5 py-4 text-[13px] text-muted sm:px-6">
        <p>
          Read directly from Portaldot mainnet and BSC; the bridge’s own API is never asked. The bridge does not link its two transactions on chain, so the payout is matched
          as the first WPOT transfer from its reserve <Mono className="text-[12px]">{shortHash(bridge.reserve, 6, 4)}</Mono> after the deposit, of exactly the expected
          amount{payout ? "" : ","} and to your address when you give one.
        </p>
        <p className="flex flex-wrap items-center gap-1">
          Check fingerprint <Mono className="text-[12px] break-all">{result.checkHash}</Mono>
          <CopyButton value={result.checkHash} label="Copy check fingerprint" />
        </p>
      </div>
      {result.anchor && <OnChain result={result} anchor={result.anchor} v3={v3} />}
    </section>
  );
}

type Anchor = NonNullable<CheckResult["anchor"]>;

type OnChainCheck =
  | { kind: "checking" }
  | { kind: "match"; leafCount: number; factsMatch: boolean }
  | { kind: "mismatch" }
  | { kind: "error" };

/**
 * Where the verified transfer stands in RelayMesh's batches on PortalDot V3. For an anchored check the
 * browser does the work: it hashes the facts shown above, computes the leaf, folds RelayMesh's proof
 * and reads the root from ReceiptBatchRegistry itself.
 */
function OnChain({ result, anchor, v3 }: { result: CheckResult; anchor: Anchor; v3: V3 }) {
  const client = useMemo(() => createPublicClient({ transport: http(v3.rpcUrl) }), [v3.rpcUrl]);
  const [check, setCheck] = useState<OnChainCheck>({ kind: "checking" });

  useEffect(() => {
    if (anchor.status !== "anchored") return;
    let live = true;
    (async () => {
      // The response's amounts are decimal strings, which canonical JSON writes exactly as the bigints hashed on the server.
      const facts = { deposit: { ...result.deposit, id: `${result.deposit.id.block}-${result.deposit.id.index}` }, payout: result.assessment.payout };
      const factsMatch = hashCanonical(BRIDGE_CHECK_DOMAIN, facts) === anchor.checkHash;
      const root = merkleRootFromProof(bridgeCheckLeaf(anchor.checkHash), anchor.proof);
      const batch = await client.readContract({ address: anchor.contract, abi: receiptBatchRegistryAbi, functionName: "getBatch", args: [root] });
      return batch.recordedAt === 0n ? ({ kind: "mismatch" } as const) : ({ kind: "match", leafCount: batch.leafCount, factsMatch } as const);
    })()
      .catch((): OnChainCheck => ({ kind: "error" }))
      .then((next) => live && setCheck(next));
    return () => {
      live = false;
    };
  }, [anchor, client, result]);

  return (
    <div className="grid gap-2 rounded-b-[18px] border-t border-line bg-raised/40 px-5 py-4 text-sm sm:px-6">
      <p className="font-semibold">On chain</p>
      {anchor.status === "queued" && (
        <p className="text-muted">
          RelayMesh recorded this check and queued it for its next batch on PortalDot V3. Batches go out every 30 minutes, or sooner once 20 entries are waiting.
        </p>
      )}
      {anchor.status === "batching" && <p className="text-muted">This check is in a batch being written to PortalDot V3 now. Check again in a minute.</p>}
      {anchor.status === "anchored" && (
        <>
          {check.kind === "checking" && (
            <p className="flex items-center gap-2 text-muted">
              <CircleNotch size={14} className="animate-spin text-accent" />
              Folding the Merkle proof and reading the root from ReceiptBatchRegistry…
            </p>
          )}
          {check.kind === "match" && (
            <p className="flex items-start gap-2 text-positive">
              <SealCheck size={16} weight="fill" className="mt-0.5 shrink-0" />
              <span>
                Anchored on PortalDot V3. Your browser folded the proof from this check’s fingerprint to a root ReceiptBatchRegistry holds, in a batch of {check.leafCount}{" "}
                {check.leafCount === 1 ? "entry" : "entries"}.
                {!check.factsMatch && <span className="text-caution"> The facts shown re-hash differently: the anchored fingerprint is from this deposit’s first check.</span>}
              </span>
            </p>
          )}
          {check.kind === "mismatch" && <p className="text-critical">The proof does not lead to a root recorded in ReceiptBatchRegistry. Do not rely on this anchor.</p>}
          {check.kind === "error" && <p className="text-caution">Could not read PortalDot V3 to confirm the batch. Try again in a moment.</p>}
          <dl className="grid gap-x-6 gap-y-2 text-[13px] sm:grid-cols-3">
            <Fact label="Batch root">
              <Hash value={anchor.root} label="Copy batch root" />
            </Fact>
            <Fact label="Transaction">
              <Hash value={anchor.txHash} label="Copy batch transaction hash" />
            </Fact>
            <Fact label="Block">
              <a href={explorerBlockUrl(v3.explorerUrl, anchor.blockNumber)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 tabular-nums text-accent hover:underline">
                #{anchor.blockNumber}
                <ArrowSquareOut size={11} />
              </a>
            </Fact>
          </dl>
        </>
      )}
    </div>
  );
}
