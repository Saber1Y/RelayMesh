# X post (long form)

Attach `video/out/relaymesh-intro.mp4` (or the square cut for the feed).
Replace `@[PORTALDOT_HANDLE]` and `[DEMO VIDEO LINK]` before posting.

---

Moving tokens across chains usually means trusting a black box.

You sign. You wait. You hope it lands.
No status, no fees you saw coming, and no proof when it does arrive.

So I built RelayMesh at the @[PORTALDOT_HANDLE] Hacker House.
It moves tPOT between PortalDot's Substrate side and its EVM side, and shows you every step of it.

Here is what it does today, live on PortalDot V3 testnet:

1. A quote with every fee up front
You choose where the funds go and see the exact cost before you pay.
On a real 10 tPOT transfer: 0.0195 tPOT network fee, 0.2 tPOT RelayMesh fee, about 18 seconds.
Before you sign, it decodes the exact call your wallet will sign, so nothing is hidden in the signature.

2. One signature, a live timeline
Sign once.
Then watch it move: included in block #291963, finalized 17 seconds later, funds seen on the EVM side at 19 seconds, settled at 22.
RelayMesh only calls it settled after it measures the recipient's balance change on chain.

3. A receipt anyone can check
Every transfer ends in a receipt.
Its hash is written to PortalDot V3 by our ReceiptBatchLog contract, for 0.0186 tPOT per anchor.
Open /verify and your browser rebuilds the hash and checks it against the chain.
Change one field and it fails.

4. A checker for the PortalDot to BNB Chain bridge
Paste a mainnet bridge deposit and RelayMesh finds the WPOT payout on BNB Chain and checks the amount after the 3% bridge fee.
Deposit 860457-1: 44 POT in, 42.68 WPOT out. Verified, then the check itself anchored on V3.

5. A fee model that pays for itself
The 0.2 tPOT fee goes straight to the relayer in the same transaction as the transfer.
One fee covers about 10 anchors, so the service funds its own proofs.

6. An open API
Everything in the app is a plain HTTP endpoint: intents, quotes, timelines, receipts, anchors, bridge checks.
The /developers page lets you run each call live in the browser.

The numbers so far: 10 settled transfers, 382 tPOT moved, every receipt anchored, 5 bridge deposits verified, 212 tests.

And this is only the start.
Next: the reverse EVM to Substrate route, an iBridge adapter, a TypeScript SDK and signed webhooks, then mainnet, treasury payout receipts and more chains.
The goal is a verification layer for every value transfer on PortalDot, held to one rule: if it moved, you can prove it.

Try it: https://relaymesh.162-62-231-147.sslip.io
API docs: https://relaymesh.162-62-231-147.sslip.io/developers
Code and roadmap: https://github.com/Saber1Y/RelayMesh
Full demo: [DEMO VIDEO LINK]
