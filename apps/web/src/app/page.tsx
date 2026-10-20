import { ArrowRight, ArrowUpRight, Eye, MagnifyingGlass, PenNib, SealCheck, ShieldCheck } from "@phosphor-icons/react/dist/ssr";
import Link from "next/link";
import type { Hex } from "viem";
import type { StatusEvent } from "@relaymesh/core";
import { countIntentsByStatus, listIntentIdsByStatus, loadIntent, recentSettlementSeconds } from "@relaymesh/db";
import { Timeline } from "@/components/timeline";
import { Badge, stagger } from "@/components/ui";
import type { Wire } from "@/lib/api";
import { formatAmount, shortHash } from "@/lib/format";
import { describeProviders, getDb, v3Config } from "@/server/services";

export const dynamic = "force-dynamic";

const EVIDENCE_URL = "https://github.com/Saber1Y/RelayMesh/blob/main/docs/evidence.md";

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
    detail: "decoded client-side",
  },
  {
    icon: PenNib,
    verb: "Sign",
    body: "Your wallet signs those exact bytes. The server only accepts an on-chain extrinsic that matches them, from you.",
    detail: "Talisman / SubWallet / polkadot.js",
  },
  {
    icon: SealCheck,
    verb: "Verify",
    body: "A watcher waits for finality, measures the recipient's balance across the block, and only then writes a receipt.",
    detail: "eth_getBalance at N-1 and N",
  },
] as const;

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
    const [counts, durations, settledIds] = await Promise.all([countIntentsByStatus(db), recentSettlementSeconds(db), listIntentIdsByStatus(db, ["SETTLED"], 500)]);
    const latestId = settledIds.at(-1);
    const latest = latestId ? await loadIntent(db, latestId as Hex) : undefined;
    return { ok: true as const, settled: counts.SETTLED, medianSeconds: median(durations), latest };
  } catch (error) {
    console.error("[relaymesh] landing proof unavailable", error);
    return { ok: false as const };
  }
}

export default async function LandingPage() {
  const proof = await loadProof();
  const providers = describeProviders();
  const liveRoutes = providers.filter((p) => p.status.available).length;
  const ibridge = providers.find((p) => !p.status.available);
  const latest = proof.ok ? proof.latest : undefined;
  const settledBlock = latest?.history.find((e) => e.status === "SETTLED")?.evidence?.blockNumber;
  const history = latest ? (JSON.parse(JSON.stringify(latest.history, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v))) as Wire<StatusEvent>[]) : [];

  return (
    <>
      <section className="mx-auto grid w-full max-w-[1160px] items-center gap-12 px-5 pt-36 pb-20 md:px-10 lg:min-h-[min(calc(100dvh-4rem),54rem)] lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] lg:pt-32">
        <div className="enter grid gap-7" style={stagger(0)}>
          <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">PortalDot V3 routing and proof</p>
          <h1 className="text-5xl font-semibold leading-[0.98] tracking-[-0.065em] md:text-7xl">
            Transfers you can{" "}
            <span className="relative inline-block px-1 text-accent-ink before:absolute before:inset-x-0 before:inset-y-[0.08em] before:-z-10 before:-rotate-2 before:rounded-md before:bg-accent">
              prove
            </span>{" "}
            landed.
          </h1>
          <p className="max-w-[46ch] text-lg leading-relaxed text-muted">
            RelayMesh quotes a real route, hands your wallet the exact call, and reads the chain before calling anything settled.
          </p>
          <div className="flex flex-wrap items-center gap-3">
            <Link
              href="/desk"
              className="press group inline-flex items-center gap-2 rounded-full bg-accent px-6 py-3 text-[15px] font-medium text-accent-ink shadow-glow hover:-translate-y-0.5 hover:shadow-glow-strong"
            >
              Launch desk
              <ArrowRight size={16} className="transition-transform duration-200 group-hover:translate-x-0.5" />
            </Link>
            <a
              href={EVIDENCE_URL}
              target="_blank"
              rel="noreferrer"
              className="press inline-flex items-center gap-2 rounded-full border border-line-strong px-6 py-3 text-[15px] text-ink hover:bg-raised"
            >
              Read the evidence
              <ArrowUpRight size={15} />
            </a>
          </div>
        </div>

        <div className="enter relative" style={stagger(1)}>
          <div className="pointer-events-none absolute -inset-8 -z-10 rounded-[2rem] bg-[radial-gradient(closest-side,rgb(200_245_106/0.08),transparent)]" aria-hidden />
          {latest ? (
            <div className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-2 px-1">
                <span className="hud-label flex items-center gap-2 text-muted">
                  <ShieldCheck size={14} className="text-accent" /> Latest settled transfer
                </span>
                <Link href={`/intents/${latest.intent.intentId}`} className="font-mono text-[10px] text-accent hover:underline">
                  {formatAmount(latest.intent.source.amount, latest.intent.source.chain)} to {shortHash(latest.intent.destination.recipient)}
                </Link>
              </div>
              <Timeline history={history} wsUrl={v3Config.wsUrl} file={`intent_${shortHash(latest.intent.intentId, 6, 4)}.log`} />
            </div>
          ) : (
            <div className="rounded-2xl border border-line bg-surface/65 p-6 backdrop-blur-xl">
              <p className="hud-label text-muted">Settlement log</p>
              <p className="mt-4 text-sm text-muted">
                {proof.ok ? "No transfer has settled on this deployment yet. The first one will appear here, read from the database." : "The ledger is unreachable right now, so no figures are shown."}
              </p>
            </div>
          )}
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1160px] border-t border-line px-5 py-14 md:px-10" aria-label="Live figures">
        <dl className="grid grid-cols-2 gap-x-6 gap-y-8 md:grid-cols-4">
          <div className="enter grid gap-3 border-t border-line pt-3" style={stagger(0)}>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Transfers settled</dt>
            <dd className="text-4xl font-semibold tracking-[-0.04em] text-accent tabular-nums">{proof.ok ? proof.settled : "n/a"}</dd>
          </div>
          <div className="enter grid gap-3 border-t border-line pt-3" style={stagger(1)}>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Median, block to settled</dt>
            <dd className="text-4xl font-semibold tracking-[-0.04em] tabular-nums">{proof.ok && proof.medianSeconds !== null ? `${proof.medianSeconds}s` : "n/a"}</dd>
          </div>
          <div className="enter grid gap-3 border-t border-line pt-3" style={stagger(2)}>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Routes live</dt>
            <dd className="text-4xl font-semibold tracking-[-0.04em] tabular-nums">
              {liveRoutes}
              <span className="text-xl text-muted"> / {providers.length}</span>
            </dd>
          </div>
          <div className="enter grid gap-3 border-t border-line pt-3" style={stagger(3)}>
            <dt className="font-mono text-[10px] uppercase tracking-[0.14em] text-muted">Keys held by RelayMesh</dt>
            <dd className="text-4xl font-semibold tracking-[-0.04em] tabular-nums">0</dd>
          </div>
        </dl>
      </section>

      <section id="how" className="mx-auto w-full max-w-[1160px] scroll-mt-28 border-t border-line px-5 py-24 md:px-10 md:py-32">
        <div className="grid gap-14 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
          <div className="grid content-start gap-5 lg:sticky lg:top-32">
            <p className="font-mono text-[11px] uppercase tracking-[0.22em] text-accent">How it works</p>
            <h2 className="text-4xl font-semibold tracking-[-0.05em] md:text-5xl">Four checks between intent and receipt.</h2>
            <p className="max-w-[44ch] text-lg leading-relaxed text-muted">
              Status pages say a transfer completed. RelayMesh treats that as a claim, and checks it against the chain at every step.
            </p>
          </div>
          <ol className="grid">
            {FLOW.map(({ icon: Icon, verb, body, detail }, i) => (
              <li key={verb} className="enter grid grid-cols-[3rem_minmax(0,1fr)] gap-5 border-t border-line py-8 first:border-t-0 first:pt-0" style={stagger(i)}>
                <span className="flex size-12 items-center justify-center rounded-xl border border-line bg-surface/65 text-accent">
                  <Icon size={20} />
                </span>
                <div className="grid gap-2">
                  <h3 className="text-xl font-semibold tracking-[-0.03em]">{verb}</h3>
                  <p className="leading-relaxed text-muted">{body}</p>
                  <p className="font-mono text-[11px] text-ink/60">{detail}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1160px] border-t border-line px-5 py-24 md:px-10 md:py-28">
        <h2 className="max-w-[22ch] text-3xl font-semibold tracking-[-0.045em] md:text-4xl">What runs today, and what does not yet.</h2>
        <div className="mt-10 grid gap-5 md:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div className="rounded-2xl border border-accent/25 bg-surface/65 p-6 shadow-panel backdrop-blur-xl">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-lg font-semibold tracking-[-0.02em]">Substrate to EVM on PortalDot V3</span>
              <Badge tone="accent" live>
                Live
              </Badge>
            </div>
            <p className="mt-3 leading-relaxed text-muted">
              Native tPOT from a PortalDot account to an EVM address on the same chain, through Revive account mapping. Quoted, signed, finalized and measured on chain.
            </p>
            {latest && settledBlock !== undefined && (
              <Link href={`/intents/${latest.intent.intentId}`} className="mt-5 inline-flex items-center gap-1.5 font-mono text-[11px] text-accent hover:underline">
                Latest settlement in block #{settledBlock.toString()} <ArrowUpRight size={12} />
              </Link>
            )}
          </div>
          <div className="grid gap-5">
            {ibridge && !ibridge.status.available && (
              <div className="rounded-2xl border border-line bg-surface/40 p-6">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-semibold tracking-[-0.02em]">{ibridge.name}</span>
                  <Badge tone="neutral">Unavailable</Badge>
                </div>
                <p className="mt-3 text-sm leading-relaxed text-muted">{ibridge.status.reason}</p>
              </div>
            )}
            <div className="rounded-2xl border border-line bg-surface/40 p-6">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold tracking-[-0.02em]">On-chain receipt anchoring</span>
                <Badge tone="caution">Pending</Badge>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted">The IntentRegistry contract is written and tested, and waits on testnet funds for deployment.</p>
            </div>
          </div>
        </div>
      </section>

      <section className="mx-auto w-full max-w-[1160px] border-t border-line px-5 py-24 md:px-10 md:py-28">
        <div className="grid items-end gap-8 md:grid-cols-[minmax(0,1fr)_auto]">
          <h2 className="max-w-[20ch] text-4xl font-semibold tracking-[-0.05em] md:text-5xl">Send a transfer and keep the proof.</h2>
          <Link
            href="/desk"
            className="press group inline-flex w-fit items-center gap-2 rounded-full bg-accent px-6 py-3 text-[15px] font-medium text-accent-ink shadow-glow hover:-translate-y-0.5 hover:shadow-glow-strong"
          >
            Launch desk
            <ArrowRight size={16} className="transition-transform duration-200 group-hover:translate-x-0.5" />
          </Link>
        </div>
      </section>
    </>
  );
}
