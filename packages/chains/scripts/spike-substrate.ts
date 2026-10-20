// Spike A: read-only check that the Substrate adapter works against PortalDot V3.
import { connectSubstrate, getFreeBalance, getSubstrateChainInfo, loadPortaldotV3Config } from "../src/index";

const config = loadPortaldotV3Config();
console.log(`Connecting to ${config.wsUrl}`);
const api = await connectSubstrate(config.wsUrl);

try {
  const info = await getSubstrateChainInfo(api);
  console.log("Chain info:", info);

  const pallets = api.runtimeMetadata.asLatest.pallets.map((p) => p.name.toString());
  const relevant = ["Balances", "Revive", "Contracts", "Assets", "AssetConversion", "Beefy", "Mmr", "Sudo"];
  console.log("Relevant pallets present:", Object.fromEntries(relevant.map((name) => [name, pallets.includes(name)])));
  console.log(
    "Bridge/XCM pallets present:",
    pallets.filter((name) => /bridge|xcm|xcmp|polkadotxcm/i.test(name)),
  );

  const existentialDeposit = api.consts.balances.existentialDeposit.toBigInt();
  console.log(`Existential deposit: ${existentialDeposit} base units`);

  // Events of the latest finalized block, decoded with the live metadata.
  const finalizedHash = await api.rpc.chain.getFinalizedHead();
  const events = await (await api.at(finalizedHash)).query.system.events();
  console.log(
    `Finalized block ${finalizedHash.toHex()} events:`,
    events.map(({ event }) => `${event.section}.${event.method}`),
  );

  const address = process.env.SPIKE_SUBSTRATE_ADDRESS;
  if (address) {
    console.log(`Free balance of ${address}: ${await getFreeBalance(api, address)} base units`);
  } else {
    console.log("SPIKE_SUBSTRATE_ADDRESS not set; skipping balance lookup");
  }
} finally {
  await api.disconnect();
}
