import { Eye, MagnifyingGlass, PenNib, SealCheck } from "@phosphor-icons/react/dist/ssr";
import { IntentForm } from "@/components/intent-form";
import { Badge, stagger } from "@/components/ui";
import { describeProviders } from "@/server/services";

const FLOW = [
  { icon: MagnifyingGlass, title: "Quote", body: "Real fees and the exact amount the EVM side will show, read from V3." },
  { icon: Eye, title: "Review", body: "Your browser decodes the call from chain metadata and checks it." },
  { icon: PenNib, title: "Sign", body: "Your wallet signs that exact call. RelayMesh never holds keys." },
  { icon: SealCheck, title: "Verify", body: "Finality and the balance change are read from the chain, then receipted." },
] as const;

export default function HomePage() {
  const providers = describeProviders();

  // Mobile order: headline, form, flow, routes. Desktop: story on the left, form pinned on the right.
  return (
    <div className="grid gap-12 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)] lg:grid-rows-[auto_1fr] lg:gap-x-16">
      <div className="enter grid gap-5 pt-2" style={stagger(0)}>
        <h1 className="max-w-[16ch] text-4xl font-semibold leading-[1.05] tracking-[-0.035em] sm:text-5xl">Send tPOT. Keep the proof it landed.</h1>
        <p className="max-w-[52ch] text-[17px] leading-relaxed text-muted">
          RelayMesh quotes real routes, hands your wallet the exact call to sign, and only calls a transfer settled after reading both sides from the chain.
        </p>
      </div>

      <div className="lg:sticky lg:top-24 lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:self-start">
        <IntentForm />
      </div>

      <div className="grid content-start gap-12">
        <ol className="enter relative grid gap-6 sm:grid-cols-2" style={stagger(1)} aria-label="How a transfer works">
          {FLOW.map(({ icon: Icon, title, body }) => (
            <li key={title} className="grid grid-cols-[2.25rem_minmax(0,1fr)] items-start gap-3">
              <span className="flex size-9 items-center justify-center rounded-[10px] border border-line bg-surface text-accent shadow-panel">
                <Icon size={18} />
              </span>
              <div className="grid content-start gap-1 pt-0.5">
                <h2 className="text-sm font-semibold">{title}</h2>
                <p className="text-sm leading-relaxed text-muted">{body}</p>
              </div>
            </li>
          ))}
        </ol>

        <section aria-labelledby="routes-heading" className="enter grid gap-3" style={stagger(2)}>
          <h2 id="routes-heading" className="text-sm font-semibold">
            Routes
          </h2>
          <ul className="grid overflow-hidden rounded-[14px] border border-line bg-surface shadow-panel">
            {providers.map((p) => (
              <li key={p.id} className="grid gap-1.5 border-b border-line px-5 py-4 last:border-b-0">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm font-medium">{p.name}</span>
                  {p.status.available ? <Badge tone="positive">Available</Badge> : <Badge tone="neutral">Unavailable</Badge>}
                </div>
                <p className="text-sm leading-relaxed text-muted">{p.status.available ? p.description : p.status.reason}</p>
              </li>
            ))}
          </ul>
          <p className="text-[13px] text-muted">All transfers run on the PortalDot V3 testnet with test tokens. Nothing here touches mainnet funds.</p>
        </section>
      </div>
    </div>
  );
}
