"use client";

import { ArrowSquareOut, CircleNotch, FileArrowUp, HourglassMedium, SealCheck, SealWarning, Question } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createPublicClient, http, type Hex } from "viem";
import { intentRegistryAbi } from "@relaymesh/contracts/abi/IntentRegistry";
import { isChainId } from "@relaymesh/core";
import { CopyButton } from "./copy-button";
import { Badge, Button, inputClass, Mono, Panel } from "./ui";
import { findBatchLog } from "@/lib/batch-log";
import { explorerBlockUrl, formatAmount, formatDateTime, shortHash, type Tone } from "@/lib/format";
import {
  parseReceipt,
  ReceiptFormatError,
  verifyReceipt,
  type BatchProofClaim,
  type BatchReader,
  type ParsedReceipt,
  type RegistryReader,
  type Verdict,
  type Verification,
} from "@/lib/verify-receipt";

/** One of RelayMesh's batch contracts; both emit the same BatchRecorded event, which is what is checked. */
export interface BatchContract {
  address: Hex;
  name: "ReceiptBatchLog" | "ReceiptBatchRegistry";
}

export interface VerifierExample {
  intentId: string;
  label: string;
}

type Mode = "id" | "json";
type Step = "fetching" | "hashing" | "reading";
type State =
  | { kind: "idle" }
  | { kind: "working"; step: Step }
  | { kind: "done"; receipt: ParsedReceipt; result: Verification }
  | { kind: "error"; message: string };

const INTENT_ID = /^0x[0-9a-fA-F]{32}$/;

const STEP_TEXT: Record<Step, string> = {
  fetching: "Fetching the receipt",
  hashing: "Hashing it in your browser",
  reading: "Reading the registries on PortalDot V3",
};

const VERDICT: Record<Verdict, { tone: Tone; title: string; body: string; icon: ReactNode }> = {
  match: {
    tone: "positive",
    title: "Matches the chain",
    body: "The hash your browser computed is the receipt hash recorded on PortalDot V3. This receipt is exactly what RelayMesh committed to.",
    icon: <SealCheck size={22} weight="fill" />,
  },
  mismatch: {
    tone: "critical",
    title: "Does not match the chain",
    body: "This intent is anchored with a different receipt hash, so this receipt is not the one RelayMesh committed to. Something in it was changed.",
    icon: <SealWarning size={22} weight="fill" />,
  },
  proof_invalid: {
    tone: "critical",
    title: "Batch proof does not check out",
    body: "RelayMesh supplied a batch proof for this intent, but from this receipt it leads to no root recorded on PortalDot V3. Treat the receipt as unverified.",
    icon: <SealWarning size={22} weight="fill" />,
  },
  receipt_pending: {
    tone: "caution",
    title: "Receipt not anchored yet",
    body: "The intent is recorded on chain, but its receipt hash is not yet. RelayMesh writes it after settlement, when the relayer can pay for the write.",
    icon: <HourglassMedium size={22} weight="fill" />,
  },
  not_anchored: {
    tone: "neutral",
    title: "Not anchored on chain",
    body: "Neither registry holds anything for this intent. Receipts are anchored once a transfer settles, in batches, so a receipt that settled minutes ago may still be waiting for its batch.",
    icon: <Question size={22} weight="fill" />,
  },
};

const VERDICT_RING: Record<Tone, string> = {
  positive: "border-positive/30 bg-positive-soft text-positive",
  critical: "border-critical/30 bg-critical-soft text-critical",
  caution: "border-caution/30 bg-caution-soft text-caution",
  neutral: "border-line bg-raised text-muted",
  accent: "border-accent/30 bg-accent-soft text-accent",
};

const BATCH_MATCH_BODY =
  "Your browser computed this receipt’s leaf and folded RelayMesh’s Merkle proof up to a batch root recorded on PortalDot V3. This receipt is exactly what RelayMesh committed to.";

/** RelayMesh's batch proof for an intent. Only its shape is checked here; verifyReceipt checks it against the chain. */
async function fetchBatchProof(intentId: string): Promise<BatchProofClaim | null> {
  const response = await fetch(`/api/intents/${intentId}/anchor`, { cache: "no-store" });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error("RelayMesh could not load this receipt’s batch proof right now. Try again in a moment.");
  const body = (await response.json().catch(() => null)) as {
    batch?: { receiptHash?: unknown; proof?: unknown; contractAddress?: unknown; txHash?: unknown } | null;
  } | null;
  const batch = body?.batch;
  if (!batch) return null;
  const { receiptHash, proof, contractAddress, txHash } = batch;
  if (
    typeof receiptHash !== "string" ||
    typeof contractAddress !== "string" ||
    typeof txHash !== "string" ||
    !Array.isArray(proof) ||
    !proof.every((p) => typeof p === "string")
  ) {
    throw new Error("RelayMesh returned a malformed batch proof for this intent.");
  }
  return { receiptHash: receiptHash as Hex, proof: proof as Hex[], contractAddress: contractAddress as Hex, txHash: txHash as Hex };
}

async function fetchReceipt(intentId: string): Promise<string> {
  const response = await fetch(`/api/intents/${intentId}/receipt`, { cache: "no-store" });
  if (response.ok) return response.text();
  if (response.status === 404) throw new Error("RelayMesh has no intent with this ID.");
  if (response.status >= 500) throw new Error("RelayMesh could not load this receipt right now. If you have the receipt file, paste it under Receipt JSON instead.");
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  throw new Error(body?.error?.message ?? `RelayMesh returned ${response.status} for this intent`);
}

function amount(value: string | null, chain: string): string {
  if (value === null) return "Not observed";
  return isChainId(chain) ? formatAmount(value, chain) : value;
}

/**
 * Checks a receipt against IntentRegistry from the visitor's browser: the receipt is hashed locally
 * and the registry is read straight from the V3 EVM RPC, so the verdict does not rely on RelayMesh.
 */
export function ReceiptVerifier({
  rpcUrl,
  explorerUrl,
  registry,
  batchContracts,
  initialIntentId,
  examples,
}: {
  rpcUrl: string;
  explorerUrl: string;
  registry: { address: Hex; fromBlock: string | null } | null;
  /** RelayMesh's batch contracts from this deployment's configuration, newest first. */
  batchContracts: BatchContract[];
  initialIntentId: string | null;
  examples: VerifierExample[];
}) {
  const [mode, setMode] = useState<Mode>("id");
  const [intentId, setIntentId] = useState(initialIntentId ?? "");
  const [json, setJson] = useState("");
  const [dragging, setDragging] = useState(false);
  const [state, setState] = useState<State>({ kind: "idle" });
  const fileInput = useRef<HTMLInputElement>(null);
  const ran = useRef(false);

  const client = useMemo(() => createPublicClient({ transport: http(rpcUrl) }), [rpcUrl]);

  const reader = useMemo<RegistryReader | null>(() => {
    if (!registry) return null;
    const contract = { address: registry.address, abi: intentRegistryAbi } as const;
    const receiptRecorded = intentRegistryAbi.find((item) => item.type === "event" && item.name === "ReceiptRecorded");
    return {
      async getIntent(intentHash) {
        const s = await client.readContract({ ...contract, functionName: "getIntent", args: [intentHash] });
        return { recorder: s.recorder, routeId: s.routeId, receiptHash: s.receiptHash };
      },
      async findReceiptTx(intentHash) {
        if (registry.fromBlock === null || receiptRecorded?.type !== "event") return null;
        const logs = await client.getLogs({ address: registry.address, event: receiptRecorded, args: { intentHash }, fromBlock: BigInt(registry.fromBlock), toBlock: "latest" });
        const log = logs.at(-1);
        return log?.transactionHash && log.blockNumber !== null ? { txHash: log.transactionHash, blockNumber: log.blockNumber } : null;
      },
    };
  }, [client, registry]);

  const batches = useMemo<BatchReader | null>(() => {
    if (batchContracts.length === 0) return null;
    return {
      contracts: batchContracts.map((c) => c.address),
      fetchProof: fetchBatchProof,
      findBatch: (contract, txHash, root) => findBatchLog(client, contract, txHash, root),
    };
  }, [client, batchContracts]);

  const run = useCallback(
    async (source: { intentId: string } | { json: string }) => {
      if (!reader && !batches) return;
      try {
        let text: string;
        if ("intentId" in source) {
          setState({ kind: "working", step: "fetching" });
          text = await fetchReceipt(source.intentId.toLowerCase());
        } else {
          text = source.json;
        }
        setState({ kind: "working", step: "hashing" });
        const receipt = parseReceipt(text);
        setState({ kind: "working", step: "reading" });
        const result = await verifyReceipt(receipt, reader, batches);
        setState({ kind: "done", receipt, result });
      } catch (error) {
        const message =
          error instanceof ReceiptFormatError
            ? error.message
            : error instanceof Error && /fetch|network|HTTP request failed/i.test(error.message)
              ? "Could not reach the PortalDot V3 RPC. Check your connection and try again."
              : error instanceof Error
                ? error.message
                : "Verification failed";
        setState({ kind: "error", message });
      }
    },
    [reader, batches],
  );

  // A link with ?intent= verifies straight away.
  useEffect(() => {
    if (ran.current || !initialIntentId) return;
    ran.current = true;
    void run({ intentId: initialIntentId });
  }, [initialIntentId, run]);

  const idValid = INTENT_ID.test(intentId.trim());
  const working = state.kind === "working";

  function submit(event: FormEvent) {
    event.preventDefault();
    if (mode === "id" && idValid) void run({ intentId: intentId.trim() });
    if (mode === "json" && json.trim()) void run({ json });
  }

  async function loadFile(file: File | undefined) {
    if (!file) return;
    setJson(await file.text());
    setMode("json");
  }

  if (!reader && !batches) {
    return (
      <Panel index={1}>
        <p className="text-sm text-muted">This deployment has no registry address configured, so there is nothing on chain to check against.</p>
      </Panel>
    );
  }

  return (
    <>
      <Panel index={1}>
        <form onSubmit={submit} className="grid gap-4">
          <div className="flex w-fit gap-1 rounded-full border border-line bg-raised/60 p-1" role="group" aria-label="What to check">
            {(
              [
                ["id", "Intent ID"],
                ["json", "Receipt JSON"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={mode === value}
                onClick={() => setMode(value)}
                className={`press rounded-full px-4 py-1.5 text-sm transition-colors ${mode === value ? "bg-surface text-ink shadow-panel" : "text-muted hover:text-ink"}`}
              >
                {label}
              </button>
            ))}
          </div>

          {mode === "id" ? (
            <div className="grid gap-2">
              <label htmlFor="verify-intent" className="text-sm font-medium">
                Intent ID
              </label>
              <input
                id="verify-intent"
                value={intentId}
                onChange={(e) => setIntentId(e.target.value)}
                placeholder="0x28987e8f6976957c3e030479cbe5fe64"
                spellCheck={false}
                autoComplete="off"
                aria-invalid={intentId.trim() !== "" && !idValid}
                className={`${inputClass} font-mono`}
              />
              <p className="text-[13px] text-muted">The receipt is fetched from RelayMesh, then hashed here, so a server that served a changed receipt would be caught.</p>
            </div>
          ) : (
            <div className="grid gap-2">
              <label htmlFor="verify-json" className="text-sm font-medium">
                Receipt JSON
              </label>
              <textarea
                id="verify-json"
                value={json}
                onChange={(e) => setJson(e.target.value)}
                onDragOver={(e) => {
                  e.preventDefault();
                  setDragging(true);
                }}
                onDragLeave={() => setDragging(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setDragging(false);
                  void loadFile(e.dataTransfer.files[0]);
                }}
                rows={7}
                spellCheck={false}
                placeholder='Paste a downloaded receipt, or drop the .json file here: {"destination":…}'
                className={`${inputClass} resize-y font-mono text-[13px] leading-relaxed ${dragging ? "border-accent ring-4 ring-accent/15" : ""}`}
              />
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
                <button type="button" onClick={() => fileInput.current?.click()} className="press inline-flex items-center gap-1.5 rounded-full px-2 py-1 text-accent hover:bg-accent-soft">
                  <FileArrowUp size={15} />
                  Choose a file
                </button>
                <span>Nothing is uploaded: the file is read in your browser.</span>
                <input ref={fileInput} type="file" accept="application/json,.json" className="hidden" onChange={(e) => void loadFile(e.target.files?.[0])} />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center justify-between gap-3">
            {examples.length > 0 ? (
              <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted">
                <span>Try a settled transfer:</span>
                {examples.map((ex) => (
                  <button
                    key={ex.intentId}
                    type="button"
                    disabled={working}
                    onClick={() => {
                      setMode("id");
                      setIntentId(ex.intentId);
                      void run({ intentId: ex.intentId });
                    }}
                    className="press rounded-full border border-line bg-surface px-3 py-1 text-ink tabular-nums hover:border-accent-tint disabled:opacity-45"
                  >
                    {ex.label}
                  </button>
                ))}
              </div>
            ) : (
              <span />
            )}
            <Button type="submit" disabled={working || (mode === "id" ? !idValid : !json.trim())}>
              {working ? <CircleNotch size={16} className="animate-spin" /> : <SealCheck size={16} />}
              {working ? "Checking" : "Verify"}
            </Button>
          </div>
        </form>
      </Panel>

      <div aria-live="polite">
        {state.kind === "working" && (
          <Panel index={2}>
            <p className="flex items-center gap-2.5 text-sm text-muted">
              <CircleNotch size={16} className="animate-spin text-accent" />
              {STEP_TEXT[state.step]}…
            </p>
          </Panel>
        )}
        {state.kind === "error" && (
          <Panel index={2}>
            <p className="text-sm text-critical">{state.message}</p>
          </Panel>
        )}
        {state.kind === "done" && (
          <Result receipt={state.receipt} result={state.result} rpcUrl={rpcUrl} explorerUrl={explorerUrl} registry={registry?.address ?? null} batchContracts={batchContracts} />
        )}
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 py-3 sm:grid-cols-[11rem_minmax(0,1fr)] sm:gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

function HashValue({ value, label }: { value: string; label: string }) {
  return (
    <span className="flex min-w-0 items-start gap-1">
      <Mono className="break-all">{value}</Mono>
      <CopyButton value={value} label={label} />
    </span>
  );
}

function ProofSteps({ proof }: { proof: Hex[] }) {
  if (proof.length === 0) return <span className="text-muted">Empty: the batch holds only this receipt, so its leaf is the root</span>;
  return (
    <details className="group">
      <summary className="press w-fit cursor-pointer list-none rounded-full text-accent hover:underline">
        {proof.length} sibling {proof.length === 1 ? "hash" : "hashes"}, leaf to root
      </summary>
      <ol className="mt-2 grid gap-1.5" aria-label="Sibling hashes, from the leaf up to the root">
        {proof.map((step, i) => (
          <li key={`${i}-${step}`}>
            <HashValue value={step} label={`Copy proof hash ${i + 1}`} />
          </li>
        ))}
      </ol>
    </details>
  );
}

function Result({
  receipt,
  result,
  rpcUrl,
  explorerUrl,
  registry,
  batchContracts,
}: {
  receipt: ParsedReceipt;
  result: Verification;
  rpcUrl: string;
  explorerUrl: string;
  registry: Hex | null;
  batchContracts: BatchContract[];
}) {
  const verdict = VERDICT[result.verdict];
  const batch = result.batch;
  const inBatch = result.anchoredIn === "batch" || result.verdict === "proof_invalid";
  const body = result.verdict === "match" && result.anchoredIn === "batch" ? BATCH_MATCH_BODY : verdict.body;
  const batchContract = result.batch && batchContracts.find((c) => c.address.toLowerCase() === result.batch?.contract.toLowerCase());
  const contract = inBatch ? (batchContract?.address ?? result.batch?.contract ?? null) : registry;
  const contractName = inBatch ? (batchContract?.name ?? "not a RelayMesh contract") : "IntentRegistry";
  return (
    <section className="enter rounded-[18px] border border-line bg-surface shadow-panel" style={{ "--i": 2 } as React.CSSProperties}>
      <div className={`flex items-start gap-3 rounded-t-[18px] border-b px-5 py-4 sm:px-6 ${VERDICT_RING[verdict.tone]}`}>
        <span className="mt-0.5 shrink-0">{verdict.icon}</span>
        <div className="grid gap-1">
          <h2 className="text-base font-semibold">{verdict.title}</h2>
          <p className="text-sm text-ink/80">{body}</p>
        </div>
      </div>
      <dl className="divide-y divide-line px-5 sm:px-6">
        <Row label="Receipt">
          <span className="flex flex-wrap items-center gap-2">
            <span className="tabular-nums">
              {amount(receipt.sourceAmount, receipt.sourceChain)} sent, {amount(receipt.observedAmount, receipt.destinationChain)} observed
            </span>
            <Badge tone={receipt.status === "SETTLED" ? "positive" : "neutral"}>{receipt.status.toLowerCase().replace(/_/g, " ")}</Badge>
          </span>
          <span className="mt-1 block text-[13px] text-muted">
            Intent <Mono>{shortHash(receipt.intentId, 10, 6)}</Mono>
            {receipt.sourceBlock && (
              <>
                {" · source block "}
                <a href={explorerBlockUrl(explorerUrl, receipt.sourceBlock)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent hover:underline">
                  #{receipt.sourceBlock}
                  <ArrowSquareOut size={11} />
                </a>
              </>
            )}
          </span>
        </Row>
        <Row label="Hash in your browser">
          <HashValue value={result.computedHash} label="Copy computed hash" />
        </Row>
        {inBatch && batch ? (
          <>
            {result.verdict === "mismatch" && result.anchoredHash && (
              <Row label="Hash in the batch">
                <HashValue value={result.anchoredHash} label="Copy the batched receipt hash" />
              </Row>
            )}
            <Row label="Leaf in your browser">
              <span className="grid gap-1">
                <HashValue value={batch.leaf} label="Copy computed leaf" />
                {result.verdict !== "match" && <span className="text-[13px] text-critical">With this proof, leads to no root recorded on chain</span>}
              </span>
            </Row>
            <Row label="Merkle proof">
              <ProofSteps proof={batch.proof} />
            </Row>
            <Row label="Batch root on chain">
              {batch.root && batch.onChain ? (
                <span className="grid gap-1">
                  <HashValue value={batch.root} label="Copy batch root" />
                  <span className="text-[13px] text-muted tabular-nums">
                    {batch.onChain.leafCount} {batch.onChain.leafCount === 1 ? "receipt" : "receipts"} in this batch · recorded {formatDateTime(Number(batch.onChain.recordedAt))}
                  </span>
                  {result.verdict === "mismatch" && <span className="text-[13px] text-muted">Reached from the hash in the batch, not from this receipt</span>}
                </span>
              ) : (
                <span className="text-critical">No recorded root: the proof leads nowhere from this receipt</span>
              )}
            </Row>
          </>
        ) : (
          <Row label="Hash on chain">
            {result.anchoredHash ? <HashValue value={result.anchoredHash} label="Copy on-chain hash" /> : <span className="text-muted">Nothing recorded</span>}
          </Row>
        )}
        {result.routeMatches !== null && (
          <Row label="Recorded by">
            <span className="grid gap-1">
              <Mono className="break-all">{result.onChain.recorder}</Mono>
              <span className={`text-[13px] ${result.routeMatches ? "text-muted" : "text-critical"}`}>
                {result.routeMatches ? "Route on chain matches the receipt’s route" : "Route on chain differs from the receipt’s route"}
              </span>
            </span>
          </Row>
        )}
        {result.anchorTx && (
          <Row label={result.anchoredIn === "batch" ? "Batch transaction" : "Anchoring transaction"}>
            <span className="grid gap-1">
              <HashValue value={result.anchorTx.txHash} label="Copy transaction hash" />
              <span className="text-[13px] text-muted">EVM block #{result.anchorTx.blockNumber.toString()}</span>
            </span>
          </Row>
        )}
      </dl>
      <p className="border-t border-line px-5 py-4 text-[13px] text-muted sm:px-6">
        Read from <Mono className="text-[12px]">{rpcUrl.replace(/^https?:\/\//, "")}</Mono>
        {contract && (
          <>
            , contract <Mono className="text-[12px]">{shortHash(contract, 8, 6)}</Mono>
            {` (${contractName})`}
          </>
        )}
        . Hash = <Mono className="text-[12px]">keccak256(&quot;relaymesh.receipt.v1\n&quot; + canonical JSON)</Mono>
        {inBatch && (
          <>
            ; leaf = <Mono className="text-[12px]">keccak256(&quot;relaymesh.batch.leaf.v1\n&quot; + {"{intentHash, receiptHash}"})</Mono>, pairs hashed in sorted order under{" "}
            <Mono className="text-[12px]">relaymesh.batch.node.v1</Mono>
          </>
        )}
        .
      </p>
    </section>
  );
}
