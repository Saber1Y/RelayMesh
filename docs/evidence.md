# On-chain evidence

Every entry here was re-checked directly against the PortalDot V3 testnet, independently of the RelayMesh app, before it was recorded.

## Network

| Item | Value |
| --- | --- |
| Substrate RPC | `wss://test-node-v3.portaldot.dev` |
| EVM JSON-RPC | `https://test-evm-rpc-v3.portaldot.dev` |
| EVM chain ID | `420420777` |
| Runtime | `portaldot-v3` spec 3002 |
| Genesis hash | `0xd4f9acbcf7f52388d8b095abe3c198d19fc510e0343e643e87cfbccb155283bd` |

## Transfer 1: Substrate to EVM, settled (2026-10-20)

A 1 tPOT transfer from a Substrate account to an EVM address, signed in Talisman and settled by the watcher.

| Item | Value |
| --- | --- |
| Intent ID | `0xfaedae39bf5b2762bde0e21af227ee8c` |
| Intent hash | `0x8323dbcdc39c2d9b0dc77bf84f2525ee160bfbc3860e1eca0520af96b6e860fc` |
| Signer (source) | `5EeRe5byF4PndSAwaESnGPLjZf5zoSnbFS7faZ251tYUZdP7` |
| Recipient (EVM) | `0x3F5b96A494061F7338Da529e3047809Ac6a7FB84` |
| Credited native account | `5DVn5fuqgSsJWneQYaWsQXB8AFcwTmPmbSkvZG3zPVxvzVGr` (fallback account of the EVM address) |
| Call | `balances.transferKeepAlive(dest, 100000000000000)` (1 tPOT) |
| Extrinsic hash | `0x2d2222d13b2ec22c7a134df2e6ac2c4a00963a96fb6bb3db201c23e6bc94ccb1` |
| Block | #122911, Substrate hash `0xb42bfa7fb772caee87574b5a8a3f3d1fadac920049c4ad6e20dfcb164dcbbcbf` |
| EVM view of the block | hash `0x034e9b92fea02a16b4cdb373deaa33c1f4486d71e64754174a0400d6e6203fb0` |
| Finality | Finalized and canonical at its height |
| Fee paid | `1490590940041` base units (about 0.0149 tPOT); the quote estimated about 0.014905 tPOT |
| `eth_getBalance` at #122910 | `0` |
| `eth_getBalance` at #122911 | `900000000000000000` (0.9 tPOT) |
| Expected output (quote) | `900000000000000000` (1 tPOT minus the 0.1 tPOT existential deposit of a new account) |
| Status | `SETTLED`, verification mode `destination_rpc_state` |
| Receipt hash | `0x3dca870319888d95290f490166b9bcdf120b4dd75daee050fd11e91a34544ab5` |

Explorer: [block #122911](https://scanner-testnet-v3.portaldot.dev/#/blocks/122911) · [extrinsic 122911-1](https://scanner-testnet-v3.portaldot.dev/#/extrinsics/122911-1) on the official PortalDot V3 testnet explorer

Events of the extrinsic, as read from the block:

```text
balances.Withdraw                     fee 1490590940041 from the signer
system.NewAccount                     5DVn5fuq...xvzVGr
balances.Endowed                      5DVn5fuq...xvzVGr with 100000000000000
balances.Transfer                     100000000000000 from 5EeRe5by...tYUZdP7 to 5DVn5fuq...xvzVGr
transactionPayment.TransactionFeePaid actualFee 1490590940041
system.ExtrinsicSuccess
```

### How each claim was verified

- **The extrinsic is the planned call, signed by the requester.** The block was fetched from the node and the extrinsic's call bytes and signer were compared to the stored plan (`verifySubstrateExtrinsic`).
- **The block is final.** The finalized head is past #122911 and the canonical hash at #122911 equals the inclusion block hash (`isBlockFinalized`).
- **The funds arrived.** `eth_getBalance` for the recipient at #122910 and #122911, read from the EVM RPC, differ by exactly 0.9 tPOT.
- **The receipt is reproducible.** `keccak256("relaymesh.receipt.v1\n" + <downloaded receipt JSON>)` equals the receipt hash above.

### Timeline (UTC)

| Time | Status | Note |
| --- | --- | --- |
| 21:54:10 | Draft, Quoted | Quote: 0.9 tPOT on the EVM side, fee estimate about 0.014905 tPOT |
| 21:54:18 | Awaiting signature | Plan stored with the exact call bytes |
| 21:54:46 | In block | Server verified the reported extrinsic in block #122911 |
| 21:55:02 | Source final | Watcher confirmed finality |
| 21:55:03 | Checking destination | Watcher measured the EVM balance across #122911 |
| 21:55:05 | Settled | Observed 0.9 tPOT, required 0.9 tPOT |

From signature to settlement took about 19 seconds after inclusion.

## Transfer 2: Substrate to EVM, settled (2026-10-21)

A 150 tPOT transfer from the same Substrate account to the RelayMesh deployer and relayer address, made through RelayMesh itself to fund the registry deployment.

| Item | Value |
| --- | --- |
| Intent ID | `0x28987e8f6976957c3e030479cbe5fe64` |
| Intent hash | `0xea3dec2f739ffedc4eb2e2dc1fc58c0e7d0acb536a7df687fa0758936d43b9d0` |
| Signer (source) | `5EeRe5byF4PndSAwaESnGPLjZf5zoSnbFS7faZ251tYUZdP7` |
| Recipient (EVM) | `0xD0Dd606e328E9402C056d50171CAcAAdFB2563e4` |
| Call | `balances.transferKeepAlive(dest, 15000000000000000)` (150 tPOT) |
| Extrinsic hash | `0x97c3d29453fdd57f087671c5d7daff01665e1de230776524cdd6f07b967b6ff4` |
| Block | #136917, Substrate hash `0xa5c5d5d48158f1231539e32cd03cf13f7ddd4ba2f512dbb7608d3cd6fc9b68bc` |
| EVM view of the block | hash `0x5442ac38f7d33736c1c05469052fcfa95f1d2c9e6a3cc0ff00c35ba0bc2cecc7` |
| Observed on the EVM side | `149900000000000000000` (149.9 tPOT: 150 minus the 0.1 tPOT existential deposit of a new account) |
| Status | `SETTLED`, verification mode `destination_rpc_state` |
| Receipt hash | `0x58f6e2f9dae10f1a2313815ad21f8fd8b8ef1cc3f2d00f9e17db47ea793fb54e` |

Explorer: [block #136917](https://scanner-testnet-v3.portaldot.dev/#/blocks/136917) · [extrinsic 136917-1](https://scanner-testnet-v3.portaldot.dev/#/extrinsics/136917-1) on the official PortalDot V3 testnet explorer

From inclusion to settlement took about 21 seconds.

## IntentRegistry deployment (2026-10-21)

| Item | Value |
| --- | --- |
| Address | `0xfcfc36e3ea951640d1e495a1e671d66c75eb5123` |
| Deployment transaction | `0xa8d562b095d5c4d4fa9ac5484dc9a6659d51ed1c403b6c06360dcf3f0d6de6a5` |
| Block | #136936 |
| Deployer and recorder | `0xD0Dd606e328E9402C056d50171CAcAAdFB2563e4` |
| Cost | About 94.27 tPOT, mostly the Revive storage deposit for the code |
| Runtime code | 1039 bytes, byte-for-byte equal to the compiled artifact (`eth_getCode`) |

## Receipt anchors (2026-10-21)

Once the registry was configured, the watcher anchored both settled intents: `recordIntent` with the intent hash and route, then `recordReceipt` with the receipt hash.

| Intent | `recordIntent` transaction (block) | `recordReceipt` transaction (block) | Receipt hash on chain |
| --- | --- | --- | --- |
| Transfer 1 | `0x166c9ea112425fcc4db0f473e0eb74cbdf37ad16b70dcf8b747444cd74bf82cb` (#136952) | `0x1f07605fb157a6f1ac5c71bbb2f3a61ac0bb38dfa8f5036b8393af3464812799` (#136953) | `0x3dca870319888d95290f490166b9bcdf120b4dd75daee050fd11e91a34544ab5` |
| Transfer 2 | `0xa120a0140b458eecf73249afccc317339f19e323c4e049fb88af27009c07c231` (#136955) | `0x7b09dc97984c3c7f0d40c1df50c78f3f32d7d6f14cf59e27b16608ad0f9d4dc8` (#136956) | `0x58f6e2f9dae10f1a2313815ad21f8fd8b8ef1cc3f2d00f9e17db47ea793fb54e` |

### How the anchors were verified

- **The transactions succeeded.** `eth_getTransactionReceipt` returns status `success` for all four.
- **The contract holds the right hashes.** `getIntent(intentHash)` on the deployed contract returns the receipt hash in the table, the route ID `keccak256("v3-substrate-to-evm")` and the recorder above.
- **The anchored hash is the downloadable receipt.** For each intent, `keccak256("relaymesh.receipt.v1\n" + <receipt JSON from the API>)` equals the receipt hash read from the contract.

The registry is an audit anchor: it proves which receipt RelayMesh committed to, not that a transfer happened.
The transfer itself is proven by the chain facts above.

## ReceiptBatchRegistry deployment (2026-10-29)

Batch anchoring replaces the two `IntentRegistry` writes per intent with one `recordBatch(root, leafCount)` per batch of receipts.

| Item | Value |
| --- | --- |
| Address | `0x0a4e4bef58f22a47f28cece57b41ba67dbd5ae5e` |
| Deployment transaction | `0x773bee333e7240cc1a5dabc44d4da9c5ff72dca7e40e57888773e85199f90580` |
| Block | #238209 |
| Deployer and recorder | `0xD0Dd606e328E9402C056d50171CAcAAdFB2563e4` |
| Cost | 80.38 tPOT (balance at #238208 minus balance at #238209), mostly the Revive storage deposit for the code; the estimate was 81.64 tPOT |
| Runtime code | 861 bytes, equal to the compiled artifact with the recorder written into its immutable slot (`eth_getCode`) |

### How the deployment was verified

- **The transaction succeeded.** `eth_getTransactionReceipt` returns status `success` and the address above.
- **The code is the compiled contract.** The deploy script compares `eth_getCode` with the compiled runtime after filling in the recorder at the offsets solc reports.
- **Only the relayer can write.** `recorder()` returns the relayer address above.
- **Nothing is recorded yet.** `getBatch` for an unknown root returns all zeros.

No batch has been written on V3 yet; the first one is recorded here once the watcher is configured with this address.
