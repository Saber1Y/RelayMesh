import { IntentForm } from "@/components/intent-form";
import { Badge } from "@/components/ui";
import { describeProviders } from "@/server/services";

export default function HomePage() {
  const providers = describeProviders();

  // Mobile order: headline, form, routes. Desktop: headline and routes on the left, form on the right.
  return (
    <div className="grid gap-10 lg:grid-cols-[minmax(0,1fr)_minmax(0,32rem)] lg:grid-rows-[auto_1fr] lg:gap-x-16">
      <div className="grid gap-4">
        <h1 className="text-3xl font-semibold tracking-tight text-balance sm:text-4xl">Send tPOT. Keep the proof it landed.</h1>
        <p className="max-w-[60ch] text-base leading-relaxed text-muted">
          RelayMesh quotes real routes, hands your wallet the exact call to sign, and verifies both sides on chain before it calls a transfer settled.
        </p>
      </div>

      <div className="lg:col-start-2 lg:row-span-2 lg:row-start-1">
        <IntentForm />
      </div>

      <section aria-labelledby="routes-heading" className="grid content-start gap-3">
        <h2 id="routes-heading" className="text-sm font-semibold">
          Routes
        </h2>
        <ul className="grid gap-px overflow-hidden rounded-xl border border-line bg-line">
          {providers.map((p) => (
            <li key={p.id} className="grid gap-1.5 bg-surface px-5 py-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm font-medium">{p.name}</span>
                {p.status.available ? <Badge tone="positive">Available</Badge> : <Badge tone="neutral">Unavailable</Badge>}
              </div>
              <p className="text-sm leading-relaxed text-muted">{p.status.available ? p.description : p.status.reason}</p>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted">All transfers run on the PortalDot V3 testnet with test tokens. Nothing here touches mainnet funds.</p>
      </section>
    </div>
  );
}
