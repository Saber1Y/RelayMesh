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

## 2026-10-23: Hosted, and the scanner window fix done properly

### The window estimate was wrong

The local watcher had stopped advancing at block 136,750, about 23,000 blocks behind the head.
The 2026-10-21 fix located each pending plan's blocks by counting back from the current time at 3 to 12 seconds per block.
V3 produces a block every 6 seconds, so both ends of the estimate drift away from the truth as a plan ages: for a 2-day-old plan the range spanned about 43,000 blocks and grew faster than the scanner could read.

Now the watcher finds the real blocks.
`blockTimestamp` reads the time from the block's own `timestamp.set` inherent instead of from state, which the node discards for older blocks.
`firstBlockAtOrAfter` searches block timestamps, interpolating and falling back to bisection when a guess does not halve the interval, and each plan's result is cached.
Against live V3 it found block #122911 from its timestamp (21:54:42 UTC, as the explorer shows) in 9 reads.
Restarted on the dev database, the watcher jumped from 136,750 to the head in one pass and expired the 3 stale test intents.

### Deployment

- Postgres runs on Render from `render.yaml` on the free plan, at first with the web app beside it.
- The watcher runs under PM2 on an always-on server (`apps/worker/ecosystem.config.cjs`) and connects to the database over TLS.
  The database accepts that server's IP and Render's private network only.
- The existing records were copied into the hosted database in one transaction.
  The hosted receipt for transfer 2 re-hashes to the receipt hash anchored in `IntentRegistry`.
- Watcher memory peaks near 250 MB during startup and settles around 170 MB, so the heap is capped at 160 MB and PM2 restarts it only above 400 MB.
- The web app then moved from Render's free plan, which sleeps after 15 idle minutes, to the same server as the watcher: [relaymesh.162-62-231-147.sslip.io](https://relaymesh.162-62-231-147.sslip.io).
  It is built locally and only the build output is copied over, since the server has about 500 MB free and `next build` needs more.
  PM2 serves it on loopback port 3200 and Caddy adds TLS with a Let's Encrypt certificate.
  It settles at about 255 MB; the watcher at about 90 MB.

Block links now go to PortalDot's official V3 testnet explorer, announced with the V3 upgrade.

## 2026-10-24: A real fork on V3, and how the watcher handles it now

A 5 tPOT transfer (intent `0xb253694179b26d2406cc81346b60fe17`) was reported in block #172004 with hash `0x7a957deb…7762e7`.
GRANDPA finalized a different block at that height, `0x5ded1c24…2db6e43`, and the watcher flagged the intent for review, saying the extrinsic was not in the finalized block.
That message was wrong: it compared block hashes and never looked inside the winning block.
Both competing blocks had included the same extrinsic (`0x6dbf8b26…8f715a4`, index 1, `ExtrinsicSuccess`), so the funds did arrive.

Now, when a reported block loses a fork, the watcher looks for the same extrinsic hash on the finalized chain: first at the same height, then up to 64 blocks later (the default mortal era, after which the extrinsic can no longer be included), then up to 8 blocks earlier.
If it is found, the extrinsic is re-verified in that block and settlement continues with it as evidence, keeping the reported block hash in the evidence details.
While part of that window is not final yet, the intent keeps waiting.
Only when the whole window is final without the extrinsic is the intent flagged, and the reason names the blocks that were searched.
Run against this transfer, the search finds it in finalized block #172004 (`0x5ded1c24…`).

Review is final in the state machine, so intent `0xb2536941…` stays in review; its timeline keeps both observations.

## 2026-10-28: Relayer out of tPOT, and a memory cap that was too tight

A third transfer settled on 24 Oct (8 tPOT, block #172163), and its intent hash was anchored, but its receipt write was rejected with "Invalid Transaction" on every pass for four days.
The relayer had run out of tPOT: each `IntentRegistry` write costs about 11.5 tPOT, almost all of it Revive's storage deposit, and the account was down to 5.6 tPOT after the deployment and five writes.
The watcher retried the doomed write every pass, about 40,000 times, filling its error log.

Now the registry client estimates each write's cost (gas times gas price, with a 25% margin for the fee cap) and compares it with the relayer's balance before signing.
If the relayer cannot pay, the watcher logs one warning with the account, its balance and the amount needed, and pauses anchoring for 10 minutes before checking again.
Settlement is unaffected; only the on-chain record waits.
On the live server the watcher now logs that one warning and the error log stays empty.

The web app had also restarted four times since 24 Oct, each time out of heap memory: when the V3 node is slow, the app reloads chain metadata, which briefly needs more than the 192 MB heap cap.
The cap is now 320 MB, with PM2 restarting only above 520 MB.

The logo now matches the app header: a white graph mark on the accent purple, in `docs/brand/`, and the browser tab icon uses it instead of the old blue.

## 2026-10-28: A public receipt checker, and the PortalDot bridge is live on mainnet

The new **Verify** page lets anyone check a receipt without trusting RelayMesh.
The visitor's browser hashes the receipt with the same canonical encoding the server uses, then reads `getIntent` from `IntentRegistry` directly through the V3 EVM RPC (it allows cross-origin requests), and searches the `ReceiptRecorded` event from the deploy block to show the anchoring transaction.
It accepts an intent ID (the receipt is fetched from RelayMesh, then hashed locally, so a server serving a changed receipt would be caught) or pasted or dropped receipt JSON, which never leaves the browser.

Checked live in the browser:

- The 150 tPOT receipt matches: both hashes are `0x58f6e2f9…a793fb54e`, the route matches, and the anchoring transaction is `0x7b09dc97…` in block #136956.
- The same receipt with one digit of the observed amount changed reports "Does not match the chain".
- The 8 tPOT receipt reports "Receipt not anchored yet"; its browser-computed hash `0x3fc53859…` is exactly the value the watcher is waiting to write.

The unit tests use the real downloaded 150 tPOT receipt as a fixture and assert that it re-hashes to the anchored value.

While planning the next step, a read-only look at the PortalDot bridge (bridge.portaldot.dev, POT ↔ BSC on mainnet) showed real traffic: its Portaldot deposit address holds about 4,302 POT, and its BSC address has sent 474 transactions from a fixed 300,000,000 WPOT supply.
Both sides are public, so RelayMesh can verify real bridge transfers without spending anything or using the bridge's API.

## 2026-10-28: The V3 testnet stalled, and expiry no longer trusts the clock alone

PortalDot V3 stopped producing blocks at 12:45:54 UTC (block #232115).
A 90 tPOT transfer signed at about 12:48 went into the node's transaction pool and stayed there, and a second transfer from the same account was refused with "1014: Priority is too low", because it reused the waiting transaction's nonce.

That exposed a RelayMesh bug.
The watcher expired an unsigned intent once its signing lifetime (30 minutes) had passed on the wall clock and the scanner had caught up.
A signed extrinsic's mortal era counts blocks, not seconds, so during a stall it stays valid: the intent would have expired at about 13:18 UTC, and the transfer could still have landed after the chain resumed, moving funds that RelayMesh would then never settle.
Expiry now also requires the finalized chain to have advanced a full lifetime of blocks (lifetime / 6 s) past the first block at or after the plan's creation.
The fix was deployed at 13:00 UTC, before that intent could expire, and a new test keeps an intent signable through hours of wall-clock time with no new blocks.

The app now says when this happens.
`/api/network` reports how long ago the latest finalized block was produced, and past 90 seconds the header chip turns amber and reads "Paused" with the duration.
The signing panel warns that a transfer signed during a stall waits in the queue, and node rejections such as 1014 and 1010 are explained in plain words.

## 2026-10-29: The stall ends; a slow node, and the transfer settles

V3 resumed at block #232116 (02:09:54 UTC), after a stall of 13 hours 24 minutes.
The 90 tPOT transfer signed during the stall was included at #232117 (02:10:00 UTC).
Because expiry now counts blocks, its intent was still open, and the relayer's 90 tPOT also let the watcher anchor the 8 tPOT receipt (tx `0x51b3943a…`).

The node came back short of peers and slow, and that stopped the watcher from settling the transfer for six hours:

- Every pass failed while finding the plan's block, because the timestamp search began by reading block #1, which the node no longer answered within 30 seconds.
  The search now steps back from the head in doubling strides (64, 128, 256, … blocks) to find its lower bound, so a recent time never reads far back.
- After a restart the watcher could not start at all: the node took 60 seconds to serve the 1.1 MB of chain metadata, and RPC requests timed out at 30.
  Server connections (watcher and web) now allow two minutes per request.

With both fixes deployed, the watcher found the transfer in block #232117, measured exactly 90 tPOT arriving at the relayer's EVM address, settled it, and anchored its intent (#235751) and receipt (#235753, tx `0xdf66f298…`).
That makes four settled transfers on V3, all with receipts anchored in `IntentRegistry`.

## 2026-10-29: Checking real PortalDot bridge transfers

PortalDot confirmed iBridge stays closed to third parties through demo day, but its public bridge (bridge.portaldot.dev) already moves POT from Portaldot mainnet to WPOT on BSC.
Read-only, the traffic is clear: the deposit address on Portaldot had received 565 transfers, and the bridge's BSC reserve had sent 474 payouts from a fixed 300,000,000 WPOT supply.
The amounts show the bridge's published 3% fee: 1 POT pays 0.97 WPOT, 33 POT pays 32.01.

The new **Bridge** page checks one transfer from the chains alone.
The deposit is read from the Portaldot mainnet node: the extrinsic at the given block and index must be a successful, finalized balances transfer into the bridge's deposit address.
Then BSC is searched, in 50,000-block steps (the public node's limit), for a WPOT transfer from the bridge's reserve of exactly the deposit less the fee, made after the deposit and in a finalized block, to the user's BSC address when they give one.

Two things from real data shaped it:

- The first attempt matched a 6 POT deposit to a 5.82 WPOT payout that had happened eight hours before the deposit.
  Equal amounts are common, so only payouts after the deposit count, and the earliest wins.
- The bridge pays out in batches, often hours later; the 33 POT deposit was paid 11 hours 30 minutes after it landed.
  A proven deposit without a payout is reported as pending, not failed.

The bridge does not link its two transactions on chain, so the page states that the payout is matched by exact amount, order and optional recipient.
Recent deposits are listed from PortalDot's explorer only as examples; every check reads both chains itself.
Live, the page verified deposit `832820-1` (33 POT) against BSC transaction `0xff150567…899d8534` (32.01 WPOT), and reported `844578-1` (6 POT, a few hours old) as pending.

Deploying it also showed a hazard in copying builds over an unreliable connection: a half-copied build broke every page, and files that arrive after the server starts are not served until it restarts.
The README's deploy steps now say to compare the file lists on both sides before restarting.

## 2026-10-29: Batch anchoring, built and checked, not deployed yet

Anchoring each settled intent took two `IntentRegistry` writes of about 11.5 tPOT each, almost all of it Revive's storage deposit, and that is what drained the relayer.
At about 23 tPOT per transfer, anchoring would not scale past a handful of transfers a day.

The watcher now anchors receipts in batches.
`ReceiptBatchRegistry` records one Merkle root per batch, in one storage slot, and only the recorder fixed at deployment can write.
Each leaf is `hashCanonical("relaymesh.batch.leaf.v1", { intentHash, receiptHash })`; inner nodes hash sorted pairs under `relaymesh.batch.node.v1`, so a proof is just the sibling hashes and a node can never pass as a leaf.
Leaves are sorted and unique, and an odd node is carried up rather than duplicated, so two different sets of receipts can never share a root.
A batch is written when 20 receipts are waiting or the oldest settled 30 minutes ago, with at most 256 per batch; all three are configurable.

Crash recovery mirrors the old event-based approach.
Each batch is stored with every leaf and proof before its root is sent.
The next pass reads that exact root back with `getBatch`, finds its `BatchRecorded` event in the block the contract stored, and records the transaction; if the root is not on chain, it sends the same root again.
Receipts that settle in the meantime wait for the next batch, so a root never changes after it may have been mined.
The relayer funds check and the pause with one warning are unchanged.

`IntentRegistry` is no longer written, and its four anchored receipts are never re-batched.
The receipt checker reads it first, so those receipts verify exactly as before; this was re-checked in a browser against the live contract for the 150 tPOT and 1 tPOT receipts, including a tampered copy that reported "Does not match the chain".
For a batched receipt, the browser recomputes the leaf, folds the proof served by `/api/intents/:id/anchor` and checks the root is recorded in `ReceiptBatchRegistry`.
The proof needs no trust: a changed receipt reports a mismatch, and a proof that reaches no recorded root reports that it does not check out.

What was verified, and how:

- On V3, read-only: the contract's behaviour checks run inside the constructor of a test contract in one `eth_call` (the eth-rpc rejects state overrides).
  Recording, read-back, duplicate roots, zero roots, empty batches, a non-recorder caller and a zero recorder all behave as specified, and a deliberately broken check fails the run.
- On V3, simulated costs: deployment about 81.6 tPOT, one `recordBatch` about 3.9 tPOT at any batch size (the difference between two simulated deployments, one of which also records a batch).
- On a local anvil chain, end to end: the real deploy script (code and recorder checked after deploying), the real watcher pass and batch client against a copy of the local database with two settled intents, a crash after mining that the next pass recovered without a second write, and `/verify` in the browser showing the leaf, proof, root and batch transaction, plus a tampered receipt reported as a mismatch.
  Only the Substrate side of that pass was a stub, since nothing was left to scan.

`ReceiptBatchRegistry` is not deployed on V3 yet.
Deploying it costs about 82 tPOT and waits for approval.

### Later the same day: the batch registry is deployed

`ReceiptBatchRegistry` is deployed at `0x0a4e4bef58f22a47f28cece57b41ba67dbd5ae5e` (tx `0x773bee33…`, block #238209), with the relayer as its only recorder.
It cost 80.38 tPOT against an estimate of 81.64 tPOT, and the deploy script confirmed the on-chain code and recorder.
The relayer kept 9.02 tPOT, enough for one batch write at the watcher's 25% safety margin, and for a second one only just.
No batch has been written on V3 yet: the watcher needs this branch, the two new migrations and `RECEIPT_BATCH_REGISTRY_ADDRESS` first.

## 2026-10-29: Batch anchoring switched on, and a connection that never healed

The batch-anchoring branch is merged into `main`.
It overlapped with the week's watcher work (block-based expiry, the doubling timestamp search, fork handling, the funds pause), which all merged cleanly; three documentation and import conflicts were resolved by hand, and the merged tree passes 129 unit and 55 database tests.
On the live server, migrations `0006` and `0007` created the three batch tables in the hosted database, `RECEIPT_BATCH_REGISTRY_ADDRESS` was set for the watcher and the web app, and both were restarted.
The watcher now logs batch anchoring as on: contract `0x0a4e4bef…dbd5ae5e`, a batch at 20 waiting receipts or 30 minutes, at most 256 per batch.
No batch has been written on V3 yet; the first one follows the next settled transfer.

The restart also cleared a stall nobody had noticed.
The watcher's scan cursor had sat at block #232121 for about 13 hours: every pass failed with "disconnected (1006)" on block reads, although the same blocks read in under half a second on a fresh connection, and the polkadot.js provider kept reporting reconnects.
The new process caught up to the head in its first pass and expired the stale 80 tPOT intent.
The watcher now exits after 12 passes in a row that fail without moving the scan, so PM2 starts a fresh process instead of waiting for someone to notice.

Deploying the web build twice over an unreliable connection showed that copying straight into the live `.next` folder breaks pages while the copy runs, because `rsync --delete` removes old files first.
The README now describes copying into a staging folder and swapping it in with one rename.
