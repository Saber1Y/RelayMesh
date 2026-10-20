# RelayMesh development log

Every entry records what was actually run and what it returned.
Nothing here is simulated unless it says so.

## 2026-10-20: V3 environment and Day 1 spikes

### Context

The PortalDot team confirmed the V3 testnet endpoints:

- Substrate WebSocket: `wss://test-node-v3.portaldot.dev`
- EVM JSON-RPC: `https://test-evm-rpc-v3.portaldot.dev`
- EVM chain ID: `420420777`

They also confirmed there is no public iBridge SDK, API, contract interface, or working testnet route yet.
Follow-up questions about iBridge timing and track eligibility were sent on 2026-10-20 and are awaiting an answer.

### Runtime inventory (read-only)

- Chain `PortaldotV3 Test`, node `3.0.0-dev-fddd43141f2`, runtime `portaldot-v3` spec 3002.
- Native token tPOT, 14 decimals, SS58 prefix 42.
- Pallets present: Balances, Revive, Contracts, Assets, AssetConversion, Beefy, Mmr, MmrLeaf, MessageQueue, Sudo, and others.
- No bridge, XCM, or messaging-lane pallet exists in the runtime metadata.
- BEEFY finality tracks GRANDPA within a few blocks.
- `mmr_generateProof` returns `LeafNotFound` for recent blocks on the public node, likely because offchain indexing is disabled there.
- AssetConversion is installed with a quote runtime API, but it has 0 pools and only 2 test assets (`TEST`, `TST`).

### Spike A: Substrate adapter (`pnpm spike:substrate`)

Result: **pass**.

- `connectSubstrate` + `getSubstrateChainInfo` return the chain info above.
- Existential deposit is `10000000000000` base units (0.1 tPOT).
- Events of the latest finalized block decode with live metadata (`system.ExtrinsicSuccess`).

### Spike C (read-only part): native account to EVM address (`pnpm spike:mapping`)

Result: **pass** for the mapping and balance relationship.
A funded transfer still has to be run once tPOT arrives.

Revive constants on V3:

| Constant | Value |
| --- | --- |
| `chainId` | 420420777 |
| `nativeToEthRatio` | 10000 |
| `autoMap` | true |
| `allowEVMBytecode` | true |
| `depositPerByte` | 6000000000000 (0.06 tPOT) |
| `depositPerItem` | 15000000000000 (0.15 tPOT) |

Checked against the public sudo account `5Ca3hX34TqdyiwDu6kL1TqyQuo4aHvBSXYhWSCbyH8N1Xc5J`:

- Derived H160 `keccak256(accountId)[12..]` = `0xb4a81005669984dbbf9de26af42e82bc9a3c4a27`.
- `revive.originalAccount(0xb4a8...4a27)` returns the same sudo account, which confirms our derivation matches the runtime.
- Native free balance `99998479235636654`, `eth_getBalance` `999884792356366540000`.
- So `eth_getBalance = (free - existentialDeposit) * 10000`.
  The EVM view uses 18 decimals and excludes the existential deposit.
- The fallback native account for an H160 is `h160 ++ 0xEE * 12`, as implemented in `packages/chains/src/revive-address.ts`.

Implication for the first route: a Substrate to EVM transfer can be verified on both sides.
The Substrate side is the `balances` transfer extrinsic and events.
The EVM side is `eth_getBalance` of the recipient H160, compared using the ratio and existential deposit above.

### Spike B: contract toolchain (`pnpm --filter @relaymesh/contracts compile` and `simulate-deploy`)

Result: **pass for compile and simulated deployment**.
Not yet deployed, because we have no tPOT.

- `IntentRegistry` compiles with solc-js 0.8.37, `evmVersion` cancun, 1039 bytes runtime.
- `eth_call` with the creation bytecode returns runtime code identical to the artifact, so V3 accepts standard EVM bytecode.
  No PolkaVM `resolc` toolchain is required.
- `eth_estimateGas` for deployment: `2546337095430718` gas at `37600` wei/gas, about 95.7 tPOT.
  Most of this is Revive storage deposit (about 0.06 tPOT per code byte plus code-hash lockup), so it is an estimate, not a measured cost.
- The eth-rpc rejects `eth_call` state overrides ("Missing or invalid parameters"), so `recordIntent` will be tested after a real deployment.

### Open items

- tPOT: open the Discord support ticket with proof of registration and a native `5...` address.
  Ask for enough for the registry deployment (about 96 tPOT estimated) plus test transfers.
- Run a real Substrate to EVM transfer and record both sides in `docs/evidence.md`.
- Deploy `IntentRegistry` and exercise `recordIntent` / `recordReceipt` on V3.
- Waiting on the PortalDot team for iBridge timing, an MMR-proof-capable node, and track eligibility.

## 2026-10-20: Core package and database

### `packages/core`

Intent schema, canonical hashing, the status state machine, quotes, settlement assessment, idempotency, and receipts.
These are pure functions with no I/O.
55 unit tests pass (`pnpm test`).

### `packages/db`

Postgres 17.6 runs locally via `docker-compose.yml` (`pnpm db:up`), with Drizzle ORM 0.45 and the `postgres` driver.

- Tables: `intents`, `quotes`, `status_events`, `idempotency_records`.
- Amounts are `numeric(78,0)` read as bigint; a value above 2^64 round-trips exactly in tests.
- `status_events` is the source of truth; `intents.current_status` is a projection checked on every load.
- Database triggers make `status_events`, `quotes` and `idempotency_records` append-only, and make intent terms immutable after insert.
- Every load re-verifies the stored intent against its hash and replays the full status history through the core state machine.
- Status changes take a row lock on the intent, so concurrent watchers cannot write conflicting transitions.
- Idempotent intent creation is race-safe: 5 concurrent requests with the same key create exactly one intent.

`pnpm test:db` resets the `relaymesh_test` database, applies migrations and runs 15 integration tests against real Postgres. All pass.
