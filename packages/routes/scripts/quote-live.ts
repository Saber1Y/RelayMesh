// Read-only: quotes the Substrate -> EVM route against the live PortalDot V3 testnet and builds the
// unsigned execution plan. Nothing is signed or submitted.
//
// Requester defaults to the public sudo account (it has funds, so fee estimation and balance checks
// are realistic); set SPIKE_SUBSTRATE_ADDRESS to quote from your own account instead.
import { bytesToHex, type Hex } from "viem";
import { connectSubstrate, createV3NativeClient, h160ForAccountId, loadPortaldotV3Config } from "@relaymesh/chains";
import { createIntent, formatBaseUnits } from "@relaymesh/core";
import { collectQuotes, IBridgeProvider, V3SubstrateToEvmProvider } from "../src/index";
import { decodeAddress } from "@polkadot/util-crypto";

const config = loadPortaldotV3Config();
const api = await connectSubstrate(config.wsUrl);

try {
  const requester = process.env.SPIKE_SUBSTRATE_ADDRESS || (await api.query.sudo.key()).toString();
  const provider = new V3SubstrateToEvmProvider(createV3NativeClient(api));
  const providers = [provider, new IBridgeProvider()];
  const now = Math.floor(Date.now() / 1000);

  const cases: { label: string; recipient: Hex }[] = [
    { label: "fresh EVM address (new account)", recipient: bytesToHex(crypto.getRandomValues(new Uint8Array(20))) },
    { label: "EVM address mapped to the requester", recipient: h160ForAccountId(decodeAddress(requester)) },
  ];

  for (const { label, recipient } of cases) {
    console.log(`\n=== ${label}: ${recipient}`);
    const { intent } = createIntent(
      {
        requester,
        source: { chain: "portaldot-v3-substrate", asset: "native", amount: "100000000000000" }, // 1 tPOT
        destination: { chain: "portaldot-v3-evm", asset: "native", recipient },
        constraints: { deadline: now + 600 },
      },
      { now },
    );
    const { ranked, rejections } = await collectQuotes(providers, intent, { now });
    console.log("Rejections:", rejections.map((r) => `${r.provider}: ${r.code} - ${r.reason}`));

    const best = ranked[0];
    if (!best) continue;
    const fee = best.fees[0]?.amount ?? 0n;
    console.log({
      quoteId: best.quoteId,
      expectedOutputWei: best.expectedOutput.toString(),
      expectedOutputTpot: formatBaseUnits(best.expectedOutput, 18),
      feeBaseUnits: fee.toString(),
      feeTpot: formatBaseUnits(fee, 14),
      expiresInSeconds: best.expiresAt - now,
      estimatedSeconds: best.estimatedSeconds,
    });

    const plan = await provider.buildExecution(intent, best, { now });
    const decoded = api.createType("Call", plan.callHex);
    console.log("Plan:", { ...plan, estimatedFee: plan.estimatedFee.toString() });
    console.log("callHex decodes to:", `${decoded.section}.${decoded.method}`, JSON.stringify(decoded.toHuman()));
  }
} finally {
  await api.disconnect();
}
