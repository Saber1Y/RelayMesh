import { ArrowRight, ArrowUpRight, Check, Eye, MagnifyingGlass, PaperPlaneTilt, PenNib, SealCheck } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import type { Hex } from "viem";
import { buildReceipt, hashReceipt, type Receipt } from "@relaymesh/core";
import { countAnchoredReceipts, countIntentsByStatus, listIntentIdsByStatus, listQuotes, loadIntent, recentSettlementSeconds } from "@relaymesh/db";
import { Badge, stagger } from "@/components/ui";
import { formatAmount, shortHash, type Tone } from "@/lib/format";
import { getDb } from "@/server/services";

export const dynamic = "force-dynamic";

const EVIDENCE_URL = "https://github.com/Saber1Y/RelayMesh/blob/main/docs/evidence.md";
const REGISTRY = process.env.INTENT_REGISTRY_ADDRESS ?? null;

const FLOW = [
  {
    icon: MagnifyingGlass,
    verb: "Quote",
    body: "Reads balances, account mapping and the real network fee from PortalDot V3, then predicts exactly what the EVM side will show.",
    detail: "payment_queryInfo",
  },
  {
    icon: Eye,
    verb: "Review",
    body: "Your browser decodes the call from chain metadata and checks the method, amount and destination before signing is allowed.",
    detail: "decoded in your browser",
  },
  {
    icon: PenNib,
    verb: "Sign",
    body: "Your wallet signs those exact bytes. The server only accepts an on-chain extrinsic that matches them, from you.",
    detail: "Talisman, SubWallet, polkadot.js",
  },
  {
    icon: SealCheck,
    verb: "Prove",
    body: "A watcher waits for finality, measures the recipient's balance across the block, then writes a receipt whose hash goes on chain.",
    detail: "eth_getBalance at N-1 and N",
  },
] as const;

const STATUS: { name: string; tone: Tone; label: string; body: string }[] = [
  { name: "Substrate to EVM transfers on V3", tone: "positive", label: "Live", body: "Quoted, signed, finalized and measured on chain, then receipted." },
  { name: "Receipts anchored in IntentRegistry", tone: "positive", label: "Live", body: "Every settled receipt's hash is written to a contract anyone can read." },
  { name: "Checks of PortalDot bridge transfers", tone: "positive", label: "Live", body: "Read-only: POT deposits on Portaldot mainnet against WPOT payouts on BSC." },
  { name: "Batched receipts", tone: "accent", label: "Built", body: "One contract write for many receipts instead of two per transfer. Awaiting deployment." },
  { name: "iBridge route", tone: "neutral", label: "Waiting", body: "PortalDot has confirmed iBridge stays closed to third parties through demo day." },
];

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : Math.round(((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2);
}

/** Real figures for the landing page. If the database is unreachable the page says so instead of inventing numbers. */
async function loadProof() {
  try {
    const db = getDb();
    const [counts, durations, settledIds, anchored] = await Promise.all([
      countIntentsByStatus(db),
      recentSettlementSeconds(db),
      listIntentIdsByStatus(db, ["SETTLED"], 500),
      countAnchoredReceipts(db),
    ]);
    const latestId = settledIds.at(-1);
    const stored = latestId ? await loadIntent(db, latestId as Hex) : undefined;
    const quote = stored ? (await listQuotes(db, stored.intent.intentId)).find((q) => q.quoteId === stored.selectedQuoteId) : undefined;
    const receipt = stored && quote ? buildReceipt({ intent: stored.intent, intentHash: stored.intentHash, quote, history: stored.history }) : undefined;
    return { ok: true as const, settled: counts.SETTLED, anchored, medianSeconds: median(durations), receipt, receiptHash: receipt ? hashReceipt(receipt) : undefined };
  } catch (error) {
    console.error("[relaymesh] landing proof unavailable", error);
    return { ok: false as const };
  }
}

function ReceiptCard({ receipt, receiptHash }: { receipt: Receipt; receiptHash: Hex }) {
  const { source, destination } = receipt;
  return (
    <div className="grid gap-5 rounded-[22px] border border-line bg-surface p-6 shadow-lift sm:p-7">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] font-medium text-muted">Latest settled transfer</span>
        <Badge tone="positive">Settled</Badge>
      </div>
      <div className="grid items-end gap-4 sm:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
        <div className="grid gap-1">
          <span className="text-[12px] text-muted">Sent on V3 Substrate</span>
          <span className="text-3xl font-semibold tracking-[-0.04em] tabular-nums">{formatAmount(source.amount, source.chain)}</span>
          <span className="font-mono text-[11px] text-muted">{shortHash(source.requester, 6, 6)}</span>
        </div>
        <ArrowRight size={18} className="mb-3 hidden text-muted sm:block" aria-hidden />
        <div className="grid gap-1 sm:text-right">
          <span className="text-[12px] text-muted">Measured on V3 EVM</span>
          <span className="text-3xl font-semibold tracking-[-0.04em] text-accent tabular-nums">
            {formatAmount(destination.observedAmount ?? destination.expectedOutput, destination.chain)}
          </span>
          <span className="font-mono text-[11px] text-muted">{shortHash(destination.recipient, 6, 6)}</span>
        </div>
      </div>
      <dl className="grid grid-cols-2 gap-x-6 gap-y-3 border-t border-line pt-4 text-[13px]">
        <div className="grid gap-0.5">
          <dt className="text-muted">Source block</dt>
          <dd className="font-mono tabular-nums">#{source.blockNumber?.toString() ?? "?"}</dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-muted">Verified by</dt>
          <dd className="font-mono">{destination.verifiedBy ?? "pending"}</dd>
        </div>
        <div className="col-span-2 grid gap-0.5">
          <dt className="text-muted">Receipt hash</dt>
          <dd className="font-mono break-all text-ink/80">{receiptHash}</dd>
        </div>
      </dl>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
        <Link href={`/verify?intent=${receipt.intentId}`} className="inline-flex items-center gap-1.5 font-medium text-accent hover:underline">
          <SealCheck size={15} />
          Check it against the chain
        </Link>
        <Link href={`/intents/${receipt.intentId}`} className="inline-flex items-center gap-1 text-muted hover:text-ink">
          Full timeline
          <ArrowUpRight size={12} />
        </Link>
      </div>
    </div>
  );
}

export default async function LandingPage() {
  const proof = await loadProof();

  return (
    <>
      <section className="mx-auto grid w-full max-w-[1160px] items-center gap-14 px-5 pt-36 pb-24 md:px-10 lg:min-h-[min(calc(100dvh-2rem),54rem)] lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:pt-28">
        <div className="enter grid gap-7" style={stagger(0)}>
          <p className="text-sm font-semibold text-accent">Routing and proof for PortalDot V3</p>
          <h1 className="text-5xl font-semibold leading-[0.98] tracking-[-0.065em] md:text-7xl">
            Transfers you can{" "}
            <span className="text-accent underline decoration-accent-tint decoration-[0.09em] underline-offset-[0.14em]">prove</span>{" "}
            landed.
          </h1>
          <p className="max-w-[46ch] text-lg leading-relaxed text-muted">
            RelayMesh hands your wallet the exact call, reads both chains before calling a transfer settled, and anchors a receipt anyone can check.
          </p>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <Link
              href="/desk"
              className="press group inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-[15px] font-medium text-accent-ink shadow-glow hover:-translate-y-0.5 hover:shadow-glow-strong"
            >
              Open the app
              <ArrowRight size={16} className="transition-transform duration-200 group-hover:translate-x-0.5" />
            </Link>
            <Link href="/verify" className="inline-flex items-center gap-1.5 text-[15px] font-medium text-ink hover:text-accent">
              Verify a receipt
              <ArrowRight size={15} />
            </Link>
          </div>
        </div>

        <div className="enter relative" style={stagger(1)}>
          <div className="pointer-events-none absolute -inset-10 -z-10 rounded-[2.5rem] bg-[radial-gradient(closest-side,rgb(99_67_224/0.11),transparent)]" aria-hidden />
          {proof.ok && proof.receipt && proof.receiptHash ? (
            <ReceiptCard receipt={proof.receipt} receiptHash={proof.receiptHash} />
          ) : (
            <div className="rounded-[22px] border border-line bg-surface p-7 shadow-panel">
              <p className="text-sm font-semibold">Latest settled transfer</p>
              <p className="mt-3 text-sm text-muted">
                {proof.ok ? "No transfer has settled on this deployment yet. The first one will appear here." : "The ledger is unreachable right now, so no figures are shown."}
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1160px] px-5 pb-20 md:px-10" aria-label="Live figures">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-8 border-t border-line pt-8 md:grid-cols-4">
          {[
            { label: "Transfers settled on V3", value: proof.ok ? String(proof.settled) : "n/a", emphasis: true },
            { label: "Receipts anchored on chain", value: proof.ok ? String(proof.anchored) : "n/a" },
            { label: "Median, block to settled", value: proof.ok && proof.medianSeconds !== null ? `${proof.medianSeconds}s` : "n/a" },
            { label: "Keys or funds held", value: "0" },
          ].map((f, i) => (
            <div key={f.label} className="enter grid gap-2" style={stagger(i)}>
              <dt className="text-[13px] text-muted">{f.label}</dt>
              <dd className={`text-4xl font-semibold tracking-[-0.04em] tabular-nums ${f.emphasis ? "text-accent" : ""}`}>{f.value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section id="how" className="mx-auto w-full max-w-[1160px] scroll-mt-28 border-t border-line px-5 py-24 md:px-10 md:py-32">
        <div className="grid gap-14 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="grid content-start gap-5 lg:sticky lg:top-32">
            <p className="text-sm font-semibold text-accent">How it works</p>
            <h2 className="text-4xl font-semibold tracking-[-0.05em] md:text-5xl">Four checks between intent and receipt.</h2>
            <p className="max-w-[44ch] text-lg leading-relaxed text-muted">
              Status pages say a transfer completed. RelayMesh treats that as a claim, and checks it against the chain at every step.
            </p>
          </div>
          <ol className="grid">
            {FLOW.map(({ icon: Icon, verb, body, detail }, i) => (
              <li key={verb} className="enter grid grid-cols-[3rem_minmax(0,1fr)] gap-5 border-t border-line py-8 first:border-t-0 first:pt-0" style={stagger(i)}>
                <span className="flex size-12 items-center justify-center rounded-xl border border-line bg-surface text-accent shadow-panel">
                  <Icon size={20} />
                </span>
                <div className="grid gap-2">
                  <h3 className="text-xl font-semibold tracking-[-0.03em]">{verb}</h3>
                  <p className="leading-relaxed text-muted">{body}</p>
                  <p className="w-fit rounded-md bg-raised px-2 py-0.5 font-mono text-[11px] text-muted">{detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section id="tools" className="mx-auto w-full max-w-[1160px] scroll-mt-28 border-t border-line px-5 py-24 md:px-10 md:py-28">
        <div className="grid gap-4">
          <p className="text-sm font-semibold text-accent">The app</p>
          <h2 className="max-w-[24ch] text-4xl font-semibold tracking-[-0.05em] md:text-5xl">Send, verify, and check the bridge.</h2>
        </div>
        <div className="mt-12 grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:grid-rows-2">
          <Link
            href="/desk"
            className="press group grid content-between gap-10 rounded-[22px] border border-accent-tint bg-surface p-7 shadow-lift transition-shadow hover:shadow-glow lg:row-span-2"
          >
            <div className="grid gap-4">
              <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-accent-ink shadow-glow">
                <PaperPlaneTilt size={20} weight="bold" />
              </span>
              <h3 className="text-2xl font-semibold tracking-[-0.035em]">Desk</h3>
              <p className="max-w-[44ch] leading-relaxed text-muted">
                Send tPOT from a PortalDot account to an EVM address. Get a real quote, sign the exact call, and watch each check land in an append-only timeline that ends in a receipt.
              </p>
              <ul className="grid gap-2.5 text-[14px] text-ink/80">
                {["Real network fees from the V3 testnet", "Call decoded in your browser before you sign", "Settled only when the measured amount arrives"].map((item) => (
                  <li key={item} className="flex items-start gap-2.5">
                    <Check size={15} weight="bold" className="mt-0.5 shrink-0 text-accent" aria-hidden />
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <span className="inline-flex items-center gap-1.5 text-[15px] font-medium text-accent">
              Open the desk
              <ArrowRight size={16} className="transition-transform duration-200 group-hover:translate-x-0.5" />
            </span>
          </Link>
          <Link href="/verify" className="press group grid content-between gap-6 rounded-[22px] border border-line bg-surface p-7 shadow-panel transition-shadow hover:shadow-lift">
            <div className="grid gap-3">
              <span className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
                <SealCheck size={19} />
              </span>
              <h3 className="text-xl font-semibold tracking-[-0.03em]">Verify</h3>
              <p className="leading-relaxed text-muted">
                Paste a receipt or an intent ID. Your browser hashes it and reads IntentRegistry on V3 itself, so you never have to trust RelayMesh’s server.
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-accent">
              Verify a receipt
              <ArrowRight size={15} className="transition-transform duration-200 group-hover:translate-x-0.5" />
            </span>
          </Link>
          <Link href="/bridge" className="press group grid content-between gap-6 rounded-[22px] border border-line bg-surface p-7 shadow-panel transition-shadow hover:shadow-lift">
            <div className="grid gap-3">
              <span className="flex size-10 items-center justify-center rounded-xl bg-accent-soft text-accent">
                <MagnifyingGlass size={19} />
              </span>
              <h3 className="text-xl font-semibold tracking-[-0.03em]">Bridge</h3>
              <p className="leading-relaxed text-muted">
                Check a transfer through PortalDot’s bridge: the POT deposit on Portaldot mainnet, and the exact WPOT payout on BSC, read from both chains.
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 text-sm font-medium text-accent">
              Check a bridge transfer
              <ArrowRight size={15} className="transition-transform duration-200 group-hover:translate-x-0.5" />
            </span>
          </Link>
        </div>
      </section>

      <section id="proof" className="mx-auto w-full max-w-[1160px] scroll-mt-28 border-t border-line px-5 py-24 md:px-10 md:py-28">
        <div className="grid gap-12 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
          <div className="grid content-start gap-5">
            <p className="text-sm font-semibold text-accent">Proof</p>
            <h2 className="text-4xl font-semibold tracking-[-0.05em] md:text-5xl">What runs today, and what does not yet.</h2>
            <p className="max-w-[42ch] leading-relaxed text-muted">Every claim on this page links back to a transaction on PortalDot V3 or BSC.</p>
            <div className="flex flex-wrap gap-x-5 gap-y-2 text-[14px]">
              <a href={EVIDENCE_URL} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-medium text-accent hover:underline">
                Read the evidence
                <ArrowUpRight size={13} />
              </a>
              {REGISTRY && (
                <span className="inline-flex items-center gap-1.5 text-muted">
                  IntentRegistry <span className="font-mono text-[12px] text-ink">{shortHash(REGISTRY, 8, 6)}</span>
                </span>
              )}
            </div>
          </div>
          <ul className="grid">
            {STATUS.map((s, i) => (
              <li key={s.name} className="enter grid gap-1.5 border-t border-line py-5 first:border-t-0 first:pt-0" style={stagger(i)}>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold tracking-[-0.02em]">{s.name}</span>
                  <Badge tone={s.tone}>{s.label}</Badge>
                </div>
                <p className="text-sm leading-relaxed text-muted">{s.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1160px] px-5 pb-28 md:px-10">
        <div className="grid items-end gap-8 rounded-[28px] bg-accent px-7 py-12 text-accent-ink shadow-lift md:grid-cols-[minmax(0,1fr)_auto] md:px-12">
          <div className="grid gap-3">
            <h2 className="max-w-[20ch] text-4xl font-semibold tracking-[-0.05em] md:text-5xl">Send a transfer and keep the proof.</h2>
            <p className="max-w-[46ch] text-accent-ink/80">Free on the PortalDot V3 testnet. Your keys stay in your wallet.</p>
          </div>
          <Link
            href="/desk"
            className="press group inline-flex w-fit items-center gap-2 rounded-full bg-surface px-6 py-3 text-[15px] font-medium text-accent hover:-translate-y-0.5"
          >
            Open the app
            <ArrowRight size={16} className="transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
        </div>
      </section>
    </>
  );
}
