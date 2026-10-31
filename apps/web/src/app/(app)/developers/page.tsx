import type { Metadata } from "next";
import { headers } from "next/headers";
import type { ReactNode } from "react";
import { listRecentIntents } from "@relaymesh/db";
import { CopyButton } from "@/components/copy-button";
import { PageShell } from "@/components/page-shell";
import { TryEndpoint } from "@/components/try-endpoint";
import { Mono, stagger } from "@/components/ui";
import { batchRegistryAddress, getDb, nowSeconds, v3Config } from "@/server/services";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Developers | RelayMesh",
  description: "RelayMesh's HTTP API, the hashes behind its receipts, and the contracts that anchor them on PortalDot V3.",
};

/** A transfer settled on PortalDot V3 and anchored in the first receipt batch, used when no newer one is listed. */
const FALLBACK_INTENT = "0x0bf897748ddda26464973d5892adacf2";
/** A real bridge deposit (33 POT) and its 32.01 WPOT payout on BSC. */
const BRIDGE_DEPOSIT = "832820-1";

type Method = "GET" | "POST";

interface Endpoint {
  method: Method;
  path: string;
  summary: string;
  body?: string;
  notes?: ReactNode;
  /** A GET path with real parameters, callable from the page. */
  live?: string;
  curl: string;
}

function endpoints(base: string, intentId: string, deadline: number): { id: string; title: string; intro: ReactNode; items: Endpoint[] }[] {
  return [
    {
      id: "intents",
      title: "Move funds with an intent",
      intro: (
        <>
          An intent says what should arrive where. RelayMesh quotes it, hands back an unsigned call for the requester’s wallet, confirms the signed extrinsic on chain itself,
          then measures the balance change at the destination before it settles. RelayMesh never holds keys or funds.
        </>
      ),
      items: [
        {
          method: "POST",
          path: "/api/intents",
          summary: "Create an intent. The Idempotency-Key header is required, so a retried request never creates a second intent.",
          body: `{
  "requester": "5EeRe5byF4PndSAwaESnGPLjZf5zoSnbFS7faZ251tYUZdP7",
  "source": { "chain": "portaldot-v3-substrate", "asset": "native", "amount": "100000000000000" },
  "destination": { "chain": "portaldot-v3-evm", "asset": "native", "recipient": "0x3F5b96A494061F7338Da529e3047809Ac6a7FB84" },
  "constraints": { "deadline": ${deadline} }
}`,
          notes: (
            <>
              Save the body as <Mono>intent.json</Mono>, with your own addresses. Amounts are base-unit strings (tPOT has 14 decimals on the Substrate side); the{" "}
              <Mono>deadline</Mono> is unix seconds, at least 60 s ahead (the one shown is 15 minutes from when this page loaded). Answers <Mono>201</Mono> with{" "}
              <Mono>{"{ intentId, replayed: false }"}</Mono>, or <Mono>200</Mono> with <Mono>replayed: true</Mono> for a repeat of the same key and body. The steps
              below use it as <Mono>$INTENT</Mono>.
            </>
          ),
          curl: `BASE=${base}
INTENT=$(curl -s -X POST $BASE/api/intents \\
  -H 'content-type: application/json' \\
  -H "idempotency-key: $(uuidgen)" \\
  -d @intent.json | jq -r .intentId)`,
        },
        {
          method: "POST",
          path: "/api/intents/{intentId}/quotes",
          summary: "Ask every route provider for a fresh quote. Rejections come back too, each with its reason, so a client can say why a route is unavailable.",
          notes: (
            <>
              Quotes hold for 2 minutes. An intent can be quoted while it is a draft, quoted or awaiting a signature; later steps answer <Mono>409</Mono>.
            </>
          ),
          curl: `QUOTE=$(curl -s -X POST $BASE/api/intents/$INTENT/quotes | jq -r '.quotes[0].quoteId')`,
        },
        {
          method: "POST",
          path: "/api/intents/{intentId}/execution",
          summary: "Select a quote and get the unsigned call for the wallet. The provider re-reads chain state first, so a plan is never issued for a quote that no longer holds.",
          body: `{ "quoteId": "portaldot-v3-native-…" }`,
          curl: `curl -s -X POST $BASE/api/intents/$INTENT/execution \\
  -H 'content-type: application/json' \\
  -d "{\\"quoteId\\":\\"$QUOTE\\"}"`,
        },
        {
          method: "POST",
          path: "/api/intents/{intentId}/source",
          summary: "Report where the signed extrinsic was included. Nothing is taken on trust: the server reads the block and checks it is the planned call, signed by the requester.",
          body: `{ "txHash": "0x…", "blockHash": "0x…" }`,
          notes: (
            <>
              Answers <Mono>422</Mono> when the block or extrinsic is not found, or is not the planned call signed by the requester. From here the watcher takes over: it
              waits for finality, measures the recipient’s balance at that block, then marks the intent <Mono>SETTLED</Mono> or flags it for review.
            </>
          ),
          curl: `curl -s -X POST $BASE/api/intents/$INTENT/source \\
  -H 'content-type: application/json' \\
  -d '{"txHash":"0x…","blockHash":"0x…"}'`,
        },
        {
          method: "GET",
          path: "/api/intents/{intentId}",
          summary: "The intent, its status and full history, with the on-chain evidence recorded at each step.",
          live: `/api/intents/${intentId}`,
          curl: `curl ${base}/api/intents/${intentId}`,
        },
      ],
    },
    {
      id: "receipts",
      title: "Receipts and their anchors",
      intro: (
        <>
          Every settled intent has a receipt: the intent, the quote and the evidence, as canonical JSON. Its hash is anchored on PortalDot V3 in ReceiptBatchRegistry, so a
          receipt can be checked against the chain without asking RelayMesh.
        </>
      ),
      items: [
        {
          method: "GET",
          path: "/api/intents/{intentId}/receipt",
          summary: "The canonical receipt JSON. Re-hashing the body reproduces the X-Receipt-Hash header. Add the query download=1 to get it as a file.",
          live: `/api/intents/${intentId}/receipt`,
          curl: `curl -i ${base}/api/intents/${intentId}/receipt`,
        },
        {
          method: "GET",
          path: "/api/intents/{intentId}/anchor",
          summary: "Where the receipt is anchored: the receipt hash, the Merkle proof from its leaf to the batch root, and the recording transaction. batch is null until that batch is mined.",
          live: `/api/intents/${intentId}/anchor`,
          curl: `curl ${base}/api/intents/${intentId}/anchor`,
        },
      ],
    },
    {
      id: "bridge",
      title: "Bridge checks",
      intro: (
        <>
          Checks a transfer through PortalDot’s public bridge, from POT on Portaldot mainnet to WPOT on BSC, by reading both chains. The bridge’s own API is never asked. A
          verified transfer is queued and anchored in the same batches as receipts.
        </>
      ),
      items: [
        {
          method: "GET",
          path: "/api/bridge/check?deposit={block-index}&recipient={0x…}",
          summary: "Checks one deposit, given as its explorer ID. recipient is optional and pins the match to payouts sent to that BSC address.",
          notes: (
            <>
              <Mono>assessment.verdict</Mono> is <Mono>verified</Mono>, <Mono>payout_pending</Mono>, <Mono>not_final</Mono> or <Mono>not_a_deposit</Mono>, with the reasons in{" "}
              <Mono>problems</Mono>. For a verified transfer, <Mono>anchor.status</Mono> moves from <Mono>queued</Mono> to <Mono>batching</Mono> to <Mono>anchored</Mono>, the
              last with the root, proof and transaction. Reading both chains takes a few seconds.
            </>
          ),
          live: `/api/bridge/check?deposit=${BRIDGE_DEPOSIT}`,
          curl: `curl '${base}/api/bridge/check?deposit=${BRIDGE_DEPOSIT}'`,
        },
        {
          method: "GET",
          path: "/api/bridge/recent",
          summary: "Recent deposits into the bridge, listed by PortalDot’s explorer, as examples to check.",
          live: "/api/bridge/recent",
          curl: `curl ${base}/api/bridge/recent`,
        },
      ],
    },
    {
      id: "status",
      title: "Network and routes",
      intro: <>What RelayMesh can see right now.</>,
      items: [
        {
          method: "GET",
          path: "/api/network",
          summary: "The latest finalized V3 block and how long ago it was produced, so a stalled chain shows as stalled. Answers 503 with reachable: false when the node is unreachable.",
          live: "/api/network",
          curl: `curl ${base}/api/network`,
        },
        {
          method: "GET",
          path: "/api/providers",
          summary: "The route providers and whether each is available, with the reason when it is not.",
          live: "/api/providers",
          curl: `curl ${base}/api/providers`,
        },
      ],
    },
  ];
}

const HASHES: { name: string; formula: string }[] = [
  { name: "Receipt hash", formula: 'keccak256("relaymesh.receipt.v1\\n" + canonical(receipt))' },
  { name: "Receipt leaf", formula: 'keccak256("relaymesh.batch.leaf.v1\\n" + canonical({ intentHash, receiptHash }))' },
  { name: "Bridge check", formula: 'keccak256("relaymesh.bridge.v1\\n" + canonical({ deposit, payout }))' },
  { name: "Bridge leaf", formula: 'keccak256("relaymesh.batch.bridge.v1\\n" + canonical({ checkHash }))' },
  { name: "Tree node", formula: 'keccak256("relaymesh.batch.node.v1\\n" + canonical([a, b]))   // a < b, sorted' },
];

const VERIFY_SNIPPET = `import { createPublicClient, http, keccak256, stringToBytes } from "viem";

// Keys sorted, no whitespace, bigints as decimal strings.
const canonical = (v) =>
  Array.isArray(v) ? \`[\${v.map(canonical).join(",")}]\`
  : v && typeof v === "object"
    ? \`{\${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => \`\${JSON.stringify(k)}:\${canonical(v[k])}\`).join(",")}}\`
    : JSON.stringify(typeof v === "bigint" ? v.toString() : v);
const h = (domain, value) => keccak256(stringToBytes(\`\${domain}\\n\${canonical(value)}\`));

const receipt = await (await fetch(\`\${BASE}/api/intents/\${INTENT}/receipt\`)).json();
const { batch } = await (await fetch(\`\${BASE}/api/intents/\${INTENT}/anchor\`)).json();

const receiptHash = h("relaymesh.receipt.v1", receipt);
let node = h("relaymesh.batch.leaf.v1", { intentHash: receipt.intentHash, receiptHash });
for (const sibling of batch.proof) node = h("relaymesh.batch.node.v1", node < sibling ? [node, sibling] : [sibling, node]);

const v3 = createPublicClient({ transport: http("${v3Config.evmRpcUrl}") });
const onChain = await v3.readContract({
  address: "${batchRegistryAddress() ?? "0x…"}",
  abi: [{ type: "function", name: "getBatch", stateMutability: "view", inputs: [{ name: "root", type: "bytes32" }],
    outputs: [{ type: "tuple", components: [{ name: "recordedAt", type: "uint64" }, { name: "blockNumber", type: "uint64" }, { name: "leafCount", type: "uint32" }] }] }],
  functionName: "getBatch",
  args: [node],
});
console.log(onChain.recordedAt > 0n ? "anchored on PortalDot V3" : "root not recorded: do not trust this receipt");`;

const SECTIONS = [
  { id: "basics", label: "Basics" },
  { id: "intents", label: "Intents" },
  { id: "receipts", label: "Receipts" },
  { id: "bridge", label: "Bridge checks" },
  { id: "status", label: "Network" },
  { id: "verify", label: "Verify it yourself" },
  { id: "contracts", label: "Contracts" },
] as const;

export default async function DevelopersPage() {
  const host = (await headers()).get("host") ?? "localhost:3000";
  const base = `${/^(localhost|127\.0\.0\.1)(:|$)/.test(host) ? "http" : "https"}://${host}`;
  const recent = await listRecentIntents(getDb(), 20).catch(() => []);
  const intentId = recent.find((i) => i.status === "SETTLED")?.intentId ?? FALLBACK_INTENT;
  const batchRegistry = batchRegistryAddress();
  const intentRegistry = process.env.INTENT_REGISTRY_ADDRESS ?? null;

  return (
    <PageShell>
      <div className="grid gap-10 lg:grid-cols-[180px_minmax(0,1fr)] lg:gap-12">
        <nav aria-label="On this page" className="hidden lg:block">
          <ul className="sticky top-28 grid gap-1 text-sm">
            {SECTIONS.map((s) => (
              <li key={s.id}>
                <a href={`#${s.id}`} className="block rounded-lg px-3 py-1.5 text-muted transition-colors hover:bg-raised hover:text-ink">
                  {s.label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="grid min-w-0 gap-12">
          <header className="enter grid gap-3" style={stagger(0)}>
            <p className="text-sm font-medium text-accent">Developers</p>
            <h1 className="text-3xl font-semibold tracking-[-0.03em] text-balance sm:text-4xl">Build on RelayMesh, and check it without trusting it</h1>
            <p className="max-w-[64ch] text-muted text-pretty">
              A plain JSON API over HTTP for intents, receipts and bridge checks, plus the exact hashes and contracts behind every receipt. Each GET example on this page
              runs against this deployment, with real data from PortalDot V3.
            </p>
          </header>

          <section id="basics" className="enter grid scroll-mt-28 gap-4" style={stagger(1)}>
            <h2 className="text-xl font-semibold tracking-[-0.02em]">Basics</h2>
            <dl className="grid gap-px overflow-hidden rounded-[18px] border border-line bg-line sm:grid-cols-2">
              <Basic term="Base URL">
                <span className="inline-flex items-center gap-1">
                  <Mono className="break-all">{base}</Mono>
                  <CopyButton value={base} label="Copy base URL" />
                </span>
              </Basic>
              <Basic term="Authentication">None. Writes are bound to the requester’s signature on chain, not to an API key.</Basic>
              <Basic term="Amounts">
                Base-unit integers as strings, never JSON numbers, so nothing is rounded. Hashes are lowercase <Mono>0x</Mono> hex.
              </Basic>
              <Basic term="Errors">
                <Mono className="mb-1 block">{'{ "error": { "code", "message", "field"? } }'}</Mono>
                With a matching HTTP status: 400 for bad input, 404 when not found, 409 for a step out of order, 422 when a reported extrinsic does not check out.
              </Basic>
              <Basic term="Fees" wide>
                Quotes list the network fee estimate and, when set, RelayMesh’s fee as a <Mono>provider</Mono> fee with its <Mono>recipient</Mono>. The fee is paid in the same
                signed call as the transfer (<Mono>utility.batchAll</Mono>), goes to the relayer that pays for anchoring, counts against <Mono>maxFee</Mono>, and appears in the
                receipt as <Mono>serviceFee</Mono>. The recipient always gets the full amount.
              </Basic>
            </dl>
          </section>

          {endpoints(base, intentId, nowSeconds() + 900).map((group) => (
            <section key={group.id} id={group.id} className="grid scroll-mt-28 gap-4">
              <div className="grid gap-2">
                <h2 className="text-xl font-semibold tracking-[-0.02em]">{group.title}</h2>
                <p className="max-w-[68ch] text-sm text-muted text-pretty">{group.intro}</p>
              </div>
              <div className="grid gap-3">
                {group.items.map((e) => (
                  <EndpointCard key={`${e.method} ${e.path}`} endpoint={e} />
                ))}
              </div>
            </section>
          ))}

          <section id="verify" className="grid scroll-mt-28 gap-4">
            <div className="grid gap-2">
              <h2 className="text-xl font-semibold tracking-[-0.02em]">Verify it yourself</h2>
              <p className="max-w-[68ch] text-sm text-muted text-pretty">
                Every hash is keccak256 over a domain, a newline and canonical JSON: object keys sorted, no whitespace, integers that do not fit a JavaScript number written as
                decimal strings. The domain keeps each kind of hash apart, so a bridge check can never pass for a receipt.
              </p>
            </div>
            <dl className="divide-y divide-line overflow-hidden rounded-[18px] border border-line bg-surface">
              {HASHES.map((row) => (
                <div key={row.name} className="grid gap-1 px-4 py-3 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-4 sm:px-5">
                  <dt className="text-sm font-medium">{row.name}</dt>
                  <dd className="min-w-0">
                    <code className="font-mono text-[12px] break-all text-ink/85">{row.formula}</code>
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-sm text-muted">The whole check for one receipt, in plain JavaScript with viem and no RelayMesh code:</p>
            <Code value={VERIFY_SNIPPET} label="Copy verification script" />
          </section>

          <section id="contracts" className="grid scroll-mt-28 gap-4">
            <div className="grid gap-2">
              <h2 className="text-xl font-semibold tracking-[-0.02em]">Contracts on PortalDot V3</h2>
              <p className="max-w-[68ch] text-sm text-muted text-pretty">
                EVM chain {v3Config.evmChainId}, RPC <Mono>{v3Config.evmRpcUrl}</Mono>. Only RelayMesh’s relayer can write; anyone can read.
              </p>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {batchRegistry && (
                <ContractCard
                  name="ReceiptBatchRegistry"
                  address={batchRegistry}
                  role="Holds a Merkle root per batch of receipts and bridge checks. Used for everything anchored since 29 October."
                  reads={["getBatch(bytes32 root) → (recordedAt, blockNumber, leafCount)", "event BatchRecorded(root, recorder, leafCount)"]}
                />
              )}
              {intentRegistry && (
                <ContractCard
                  name="IntentRegistry"
                  address={intentRegistry}
                  role="Per-intent anchors, written one transaction at a time before batching. Earlier receipts still verify against it."
                  reads={["getIntent(bytes32 intentHash) → (recorder, routeId, receiptHash)", "event ReceiptRecorded(intentHash, recorder, receiptHash)"]}
                />
              )}
            </div>
          </section>
        </div>
      </div>
    </PageShell>
  );
}

function Basic({ term, children, wide = false }: { term: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`grid content-start gap-1 bg-surface px-5 py-4 ${wide ? "sm:col-span-2" : ""}`}>
      <dt className="text-[13px] text-muted">{term}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

const METHOD_CLASS: Record<Method, string> = {
  GET: "border-positive/30 bg-positive-soft text-positive",
  POST: "border-accent/30 bg-accent-soft text-accent",
};

function EndpointCard({ endpoint: e }: { endpoint: Endpoint }) {
  return (
    <article className="grid gap-3 rounded-[18px] border border-line bg-surface p-5 shadow-panel sm:p-6">
      <div className="flex min-w-0 flex-wrap items-center gap-2.5">
        <span className={`rounded-md border px-2 py-0.5 font-mono text-[11px] font-semibold tracking-wide ${METHOD_CLASS[e.method]}`}>{e.method}</span>
        <code className="min-w-0 font-mono text-[13px] font-medium break-all">{e.path}</code>
      </div>
      <p className="max-w-[72ch] text-sm text-ink/85 text-pretty">{e.summary}</p>
      {e.body && (
        <div className="grid gap-1.5">
          <p className="text-[13px] text-muted">Body</p>
          <Code value={e.body} label="Copy request body" />
        </div>
      )}
      {e.notes && <p className="max-w-[72ch] text-[13px] text-muted text-pretty">{e.notes}</p>}
      <Code value={e.curl} label="Copy curl command" />
      {e.live && <TryEndpoint path={e.live} />}
    </article>
  );
}

function Code({ value, label }: { value: string; label: string }) {
  return (
    <div className="relative min-w-0 overflow-hidden rounded-xl border border-line bg-raised/50">
      <div className="absolute top-2 right-2">
        <CopyButton value={value} label={label} />
      </div>
      <pre className="overflow-x-auto p-4 pr-10 font-mono text-[12px] leading-relaxed text-ink/90">{value}</pre>
    </div>
  );
}

function ContractCard({ name, address, role, reads }: { name: string; address: string; role: string; reads: string[] }) {
  return (
    <article className="grid content-start gap-3 rounded-[18px] border border-line bg-surface p-5 shadow-panel">
      <h3 className="text-sm font-semibold">{name}</h3>
      <span className="inline-flex min-w-0 items-center gap-1">
        <Mono className="break-all">{address}</Mono>
        <CopyButton value={address} label={`Copy ${name} address`} />
      </span>
      <p className="text-[13px] text-muted text-pretty">{role}</p>
      <ul className="grid gap-1">
        {reads.map((r) => (
          <li key={r}>
            <code className="font-mono text-[12px] break-words text-ink/80">{r}</code>
          </li>
        ))}
      </ul>
    </article>
  );
}
