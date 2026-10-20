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

## 2026-10-20: Route providers

### `packages/routes`

- `RouteProvider` interface, `collectQuotes` (runs providers in parallel and reports every provider that produced no quote), and a deterministic `rankQuotes`.
- `V3SubstrateToEvmProvider`: native tPOT from a Substrate account to an EVM address on V3 via `balances.transferKeepAlive`.
  - The destination is the H160's mapped original account (`revive.originalAccount`), or its fallback account `h160 ++ 0xEE*12`.
  - Expected EVM-side output = change in reducible balance (`free - max(frozen, ED)`) x `nativeToEthRatio`; settlement measures the real delta independently.
  - Fees come from `payment_queryInfo` and are labeled estimates; quotes live 60 seconds.
  - `buildExecution` re-reads chain state and refuses expired quotes, changed destination state, or fees above `maxFee`.
- `IBridgeProvider`: always reports unavailable with the reason; it never returns quotes or simulated data.

### Live read-only quote (`pnpm --filter @relaymesh/routes quote:live`)

Requester: the public sudo account. Amount: 1 tPOT.

| Case | Result |
| --- | --- |
| Fresh EVM address | Quote: expected output 0.9 tPOT on the EVM side (0.1 tPOT ED stays locked), fee estimate `1490601551715` (about 0.0149 tPOT) |
| EVM address mapped to the requester | Rejected: `INVALID_RECIPIENT` |
| iBridge | Rejected: `PROVIDER_UNAVAILABLE` |

The plan's `callHex` decodes on-chain metadata to `balances.transferKeepAlive` with the fallback account and `100000000000000` base units.
Nothing was signed or submitted.

## 2026-10-20: Web app

### `apps/web` (Next.js 16, React 19, Tailwind 4)

- Pages: intent form (`/`), intent workspace (`/intents/[id]`) and receipt (`/intents/[id]/receipt`).
- API: create intent (requires `Idempotency-Key`), read intent, quote, select route (returns the unsigned plan), report source inclusion, receipt JSON, provider status.
- Signing uses `@polkadot/extension-dapp` (Talisman, SubWallet, polkadot.js). The browser decodes the plan's call bytes from live V3 metadata and checks section, method, amount and destination against the intent before enabling the sign button.
- The server never trusts the browser's inclusion report: `verifySubstrateExtrinsic` reads the block from the node and requires the extrinsic to be the stored plan's exact call, signed by the requester. Plans are stored append-only in `execution_plans`.
- Times are shown in UTC so server and client render identically.

### Verified on 2026-10-20 against the live V3 testnet (no wallet, watch-only)

| Check | Result |
| --- | --- |
| Create intent, replay same key, same key with different body, missing key | 201, 200 replayed, 409 conflict, 400 |
| Quote | Real fee from `payment_queryInfo`; iBridge listed as unavailable |
| Select route | Plan stored; call decoded in the browser matches the intent |
| Report a fake block hash | 422 `SOURCE_NOT_FOUND`, status unchanged |
| Report a real extrinsic from a real block that is not the user's | 422 `SOURCE_MISMATCH`, status unchanged |
| Expired signing window, re-quote, re-select | Works; timeline records each step |
| Sign without a wallet extension | Clear error, nothing recorded |
| Receipt download | `keccak256("relaymesh.receipt.v1\n" + file)` equals `X-Receipt-Hash` |
| Light, dark and 375px mobile | No horizontal overflow; form shown before routes on mobile |

Not yet verified: an actual signed transfer, because no tPOT has been received yet.
After signing, intents stay at "In block" until the watcher (next task) confirms finality and measures the destination balance.

### Build notes

- Turbopack does not map NodeNext-style `./x.js` imports to `.ts` sources, so all packages now use `moduleResolution: Bundler` with extensionless relative imports.
- `runMigrations` moved to `@relaymesh/db/src/migrate.ts` so app bundles never try to resolve the SQL folder.
- `next.config.ts` force-reloads the repository-root `.env`, because `@next/env` caches the env it loaded for `apps/web`.

## 2026-10-20: Watcher (`apps/worker`)

### What a pass does

1. Scans finalized blocks for extrinsics that are exactly a stored plan's call bytes, signed by the intent's requester, and not older than the plan. This catches transfers the browser never reported. The cursor is persisted and never moves backwards.
2. `SOURCE_SUBMITTED` to `SOURCE_CONFIRMED` once the inclusion block is finalized and still canonical, after re-verifying the extrinsic. A replaced block becomes `NEEDS_REVIEW`.
3. `SOURCE_CONFIRMED` to `DESTINATION_PENDING`.
4. Measures `eth_getBalance` of the recipient at the inclusion block and the block before, from the EVM RPC. `SETTLED` with `destination_rpc_state` if the delta meets the expectation, otherwise `NEEDS_REVIEW` with the measurement kept as evidence.
5. Expires unsigned intents. An `AWAITING_SIGNATURE` intent expires only after its deadline, after the longest plausible signed-transaction lifetime (30 minutes by default), and once the scanner has caught up to the finalized head.
6. Anchors settled intents in `IntentRegistry` (`recordIntent`, then `recordReceipt` with the receipt hash), recovering from a crash between mining and recording by reading contract state and events. Rows in `registry_anchors` are written only after the transaction is mined.

### Facts verified on the live V3 testnet

- EVM block numbers equal Substrate block numbers; hashes differ, so evidence stores both.
- Historical `eth_getBalance` works for recent blocks; about 1,000 blocks back returns "State already discarded". The watcher classifies this as `state_pruned` and flags the intent instead of guessing.
- Fetching a block costs about 1.3 seconds from here, so the scanner fetches 10 blocks in parallel and matches them in order. A 50-block catch-up pass took 12.5 seconds.
- Running against the dev database expired the two stale test intents with the expected reasons and persisted the cursor.

### Tests

`pnpm test:db` now runs 18 watcher integration tests against real Postgres with an in-memory V3 chain and registry (test doubles), covering settlement, finality waits, forks, short deliveries, no delivery, unindexed and pruned EVM state, the scanner (including wrong signer, pre-plan transactions, failed extrinsics, identical requests), cursor limits, expiry rules, clock skew between web server and worker, and registry recovery and refusal.

### Not yet verified on chain

- No real signed transfer has gone through yet (no tPOT), so `SETTLED` has only been reached in tests.
- `IntentRegistry` is not deployed (needs about 96 tPOT). Anchoring is disabled until `INTENT_REGISTRY_ADDRESS` and `RELAYER_PRIVATE_KEY` are set; `pnpm --filter @relaymesh/contracts deploy:registry` deploys and verifies the code.
- The contract field `requester` was renamed `recorder`, because the account that anchors is the RelayMesh relayer, not the user.
