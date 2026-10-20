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

Explorer: [block #122911 on polkadot.js apps](https://polkadot.js.org/apps/?rpc=wss%3A%2F%2Ftest-node-v3.portaldot.dev#/explorer/query/122911)

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

## Not yet on chain

- `IntentRegistry` is not deployed, so the receipt hash above is not yet anchored in a contract.
