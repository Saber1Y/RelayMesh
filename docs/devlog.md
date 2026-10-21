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

## 2026-10-20: Faster in-browser call decoding

A first real signing attempt stalled: the "Call your wallet will sign" box stayed on its loading placeholder, so the sign button stayed disabled while the 60-second quote ran down.
The cause is the browser's own connection to V3, which downloads about 1.3 MB of chain metadata before it can decode the call, on a node that was answering slowly at the time.

Changes:

- The browser caches the metadata it downloaded from the V3 node in local storage, keyed by genesis hash and runtime version. polkadot.js only uses it when the key matches what the node reports, so a runtime upgrade misses the cache. Metadata is never taken from the RelayMesh server, which keeps the in-browser check independent of the server.
- The intent page starts the browser's V3 connection on load, while the user is still reading the quote.
- The sign panel shows connection progress with elapsed seconds, gives up after 45 seconds with a retry button, and labels the disabled button "Waiting for the decoded call".
- Quotes now hold for 120 seconds instead of 60. Safety does not depend on a short window: chain state is re-read before a plan is issued, and settlement measures what actually arrived.

Measured in the browser against live V3: decode in 8.3 seconds on a cold cache, 2.6 seconds on a warm cache.

## 2026-10-20: First real transfer settled

A 1 tPOT transfer from `5EeRe5by...tYUZdP7` to `0x3F5b96A494061F7338Da529e3047809Ac6a7FB84`, signed in Talisman, settled in block #122911.
The app reported `SETTLED` (verification mode `destination_rpc_state`), and every fact was then re-checked independently against the node: the extrinsic, its success events, finality, the 0 to 0.9 tPOT `eth_getBalance` change, and the receipt hash.
Full details are in `docs/evidence.md`.

Found while reviewing it: the timeline and receipt linked the destination block to polkadot.js apps by its EVM-style hash, which that explorer cannot look up.
Links now use the block number, which is the same for both views of a V3 block.

## 2026-10-21: IntentRegistry deployed and receipts anchored

The deployer key was funded through RelayMesh itself: a 150 tPOT Substrate to EVM transfer to `0xD0Dd...63e4`, which settled in block #136917 with 149.9 tPOT observed (150 minus the existential deposit of a new account).
`pnpm deploy:registry` then deployed `IntentRegistry` at `0xfcfc36e3ea951640d1e495a1e671d66c75eb5123` in block #136936.
It cost about 94.27 tPOT, close to the 95.7 tPOT estimate, and the deployed code matches the artifact byte for byte.

With `INTENT_REGISTRY_ADDRESS` and `RELAYER_PRIVATE_KEY` set, the watcher anchored both settled intents within a few blocks.
For each one, `getIntent` on the contract returns the receipt hash that the downloadable receipt re-hashes to.
Transactions and blocks are in `docs/evidence.md`.

### Scanner fix found on the way

After the restart the scanner stopped advancing about 15,000 blocks behind the finalized head, logging "No response received from RPC endpoint in 30s".
Two things combined: 10 parallel block reads overwhelmed the node, and stale `AWAITING_SIGNATURE` test intents made the scanner crawl every block since the oldest one.
A single failed read also threw away the whole pass, so the cursor never moved.

Changes in `apps/worker/src/watcher.ts`:

- 4 blocks are read at a time, and each read is retried 3 times with doubling backoff.
- The cursor is saved after every chunk, so a failure keeps the progress made before it.
- `scanRanges` turns each pending plan into the block range where it could have been signed: from its creation time at the fastest plausible block time, minus a margin, to the end of its signing window at the slowest plausible block time, plus a margin (or to the finalized head while the window is open).
  The scanner jumps over blocks outside every range, since no planned call can be in them.

Old blocks read fine one at a time (about 1.5 seconds each), so the cause was load rather than pruning.
New unit tests cover `scanRanges`, and the database tests cover a retried timeout, a block that keeps failing, and skipping the gap after a stale plan's window.
