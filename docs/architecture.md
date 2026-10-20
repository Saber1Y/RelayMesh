# RelayMesh architecture

This document describes how RelayMesh is built today, on the PortalDot V3 testnet.
Every component named here exists in this repository.
Anything not yet built or not yet verified on chain is called out explicitly.

## System overview

```mermaid
flowchart TB
    subgraph Client[Browser]
        UI[Next.js pages<br/>intent form, review, timeline, receipt]
        Wallet[Talisman / SubWallet / polkadot.js<br/>signs the exact planned call]
    end

    subgraph Server[RelayMesh server]
        API[Next.js route handlers<br/>apps/web/src/app/api]
        Routes[Route providers<br/>packages/routes]
        Core[Domain rules<br/>packages/core]
        Worker[Watcher<br/>apps/worker]
    end

    subgraph Data[Storage]
        PG[(Postgres<br/>intents, quotes, plans,<br/>status events, anchors)]
    end

    subgraph V3[PortalDot V3 testnet]
        Sub[Substrate RPC<br/>wss://test-node-v3.portaldot.dev]
        EVM[EVM JSON-RPC, chain 420420777<br/>https://test-evm-rpc-v3.portaldot.dev]
        Reg[IntentRegistry contract<br/>not deployed yet]
    end

    UI -->|create intent, quote,<br/>select route, report inclusion| API
    UI -->|decode call from metadata| Sub
    Wallet -->|signed extrinsic| Sub
    API --> Core
    API --> Routes
    Routes -->|balances, mapping,<br/>payment_queryInfo| Sub
    API -->|verify reported block| Sub
    API --> PG
    Worker --> PG
    Worker -->|scan finalized blocks,<br/>confirm finality| Sub
    Worker -->|eth_getBalance at block N-1 and N| EVM
    Worker -.->|recordIntent, recordReceipt| Reg
```

Dashed edges are implemented but not yet exercised on chain.

## Intent lifecycle

```mermaid
flowchart LR
    DRAFT --> QUOTED
    QUOTED --> QUOTED
    QUOTED --> AWAITING_SIGNATURE
    AWAITING_SIGNATURE --> QUOTED
    AWAITING_SIGNATURE --> SOURCE_SUBMITTED
    SOURCE_SUBMITTED --> SOURCE_CONFIRMED
    SOURCE_CONFIRMED --> DESTINATION_PENDING
    DESTINATION_PENDING --> SETTLED
    DRAFT --> EXPIRED
    QUOTED --> EXPIRED
    AWAITING_SIGNATURE --> EXPIRED
    AWAITING_SIGNATURE --> FAILED_BEFORE_SOURCE
    SOURCE_SUBMITTED --> FAILED_BEFORE_SOURCE
    SOURCE_SUBMITTED --> NEEDS_REVIEW
    SOURCE_CONFIRMED --> NEEDS_REVIEW
    DESTINATION_PENDING --> NEEDS_REVIEW
```

`SETTLED`, `EXPIRED`, `FAILED_BEFORE_SOURCE` and `NEEDS_REVIEW` are terminal.
Transitions are enforced by `packages/core/src/status.ts` and every stored history is replayed through the same rules when it is loaded.

| Status | Required evidence |
| --- | --- |
| `SOURCE_SUBMITTED` | Source transaction with a transaction hash, read from the chain by the server or the watcher |
| `SOURCE_CONFIRMED` | The same transaction in a finalized, canonical block |
| `SETTLED` | Finalized destination-state evidence with an observed amount, plus a verification mode |

## One transfer, end to end

```mermaid
sequenceDiagram
    participant U as User and wallet
    participant W as Web app and API
    participant DB as Postgres
    participant S as V3 Substrate
    participant E as V3 EVM RPC
    participant K as Watcher

    U->>W: Intent (from, to EVM address, amount, deadline)
    W->>DB: Store intent + DRAFT (idempotency key)
    W->>S: Balances, Revive mapping, payment_queryInfo
    W->>DB: Store quote, status QUOTED
    U->>W: Select route
    W->>S: Re-read state, build transferKeepAlive call
    W->>DB: Store plan (exact call bytes), AWAITING_SIGNATURE
    U->>S: Decode call from metadata, check it, sign and submit
    U->>W: Report tx hash and block hash
    W->>S: Read block, match call bytes and signer
    W->>DB: SOURCE_SUBMITTED
    K->>S: Block finalized and canonical?
    K->>DB: SOURCE_CONFIRMED, DESTINATION_PENDING
    K->>E: eth_getBalance(recipient, N-1) and (recipient, N)
    K->>DB: SETTLED or NEEDS_REVIEW, with the measurement
    K-->>E: Anchor intent and receipt hashes in IntentRegistry
```

If the browser never reports the transaction, the watcher still finds it: it scans finalized blocks for extrinsics whose call bytes equal a stored plan, signed by the requester, in a block no older than the plan.

## Packages

| Package | Responsibility |
| --- | --- |
| `packages/core` | Intent schema, canonical hashing, status state machine, quote checks, settlement assessment, idempotency, receipts. No I/O. |
| `packages/chains` | V3 Substrate and EVM clients, Revive address mapping, extrinsic verification, the watcher's chain reader. |
| `packages/routes` | `RouteProvider` interface, the Substrate-to-EVM provider, the iBridge slot (always unavailable), quote ranking. |
| `packages/db` | Drizzle schema and migrations, append-only triggers, store functions that apply core rules in locked transactions. |
| `contracts` | `IntentRegistry` Solidity contract, compile, simulated deploy and deploy scripts, generated typed ABI. |
| `apps/web` | Next.js pages and API routes. |
| `apps/worker` | Watcher loop: scan, confirm, measure, expire, anchor. |

## Storage

| Table | Mutability | Purpose |
| --- | --- | --- |
| `intents` | Terms immutable (trigger); only `current_status` and `selected_quote_id` change | The signed-off request and its hash |
| `status_events` | Append-only (trigger) | Source of truth for status, with evidence |
| `quotes` | Append-only (trigger) | Every quote ever shown |
| `execution_plans` | Append-only (trigger) | The exact call bytes handed to the wallet |
| `idempotency_records` | Append-only (trigger) | Request hash per idempotency key |
| `registry_anchors` | Append-only (trigger) | IntentRegistry writes, inserted only after mining |
| `watcher_cursors` | Forward-only | Last finalized block scanned |

## Trust boundaries

- The browser is never trusted for facts.
  A reported transaction is accepted only after the server reads the block from the node and finds the exact planned call signed by the requester.
- Route providers are not trusted for settlement.
  Settlement comes from RelayMesh's own `eth_getBalance` reads at a finalized block.
- The database is not trusted blindly.
  Each load recomputes the intent hash and replays the full status history.
- `IntentRegistry` is an audit anchor only.
  It proves which hashes the relayer committed to, not that a transfer happened.

## Known limits

- The only route is Substrate to EVM within PortalDot V3.
  iBridge has no public interface and the V3 runtime has no bridge pallet (checked 2026-10-20).
- The V3 node keeps historical state for recent blocks only.
  If the watcher is down for more than about 25 minutes after a transfer, the balance delta can no longer be measured and the intent is flagged for review.
- No signed transfer has run yet, because no testnet tPOT has been received.
- `IntentRegistry` is not deployed yet (about 96 tPOT estimated).
