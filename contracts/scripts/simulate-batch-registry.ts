// Read-only checks of ReceiptBatchRegistry against PortalDot V3, through eth_call and eth_estimateGas.
// Nothing is signed or broadcast, so nothing is paid. The V3 eth-rpc rejects state overrides, so the
// behaviour checks run inside the constructor of test/ReceiptBatchRegistryChecks.sol instead.
import { BaseError, encodeAbiParameters, encodeDeployData, formatEther, type Hex } from "viem";
import { assertEvmChainId, createV3PublicClient, loadPortaldotV3Config } from "@relaymesh/chains";
import { compile, readSources, runtimeWithImmutables, SOLC_VERSION, EVM_VERSION } from "./solc";

// Any funded EVM-side address works for simulation. Default: the H160 the spike derived for the
// public sudo account (it has balance), overridable for your own account.
const from = (process.env.SPIKE_EVM_FROM || "0xb4a81005669984dbbf9de26af42e82bc9a3c4a27") as Hex;
// The recorder the real deployment would fix: by default the RelayMesh relayer, which also deployed IntentRegistry.
const recorder = (process.env.BATCH_RECORDER_ADDRESS || "0xd0dd606e328e9402c056d50171cacaadfb2563e4").toLowerCase() as Hex;

const { contracts } = compile(readSources("src", "test"));
const get = (name: string) => {
  const c = contracts.find((x) => x.contractName === name);
  if (!c) throw new Error(`${name} was not compiled`);
  return c;
};
const registry = get("ReceiptBatchRegistry");

const config = loadPortaldotV3Config();
const client = createV3PublicClient(config);
await assertEvmChainId(client, config.evmChainId);
console.log(`Compiler: solc ${SOLC_VERSION}, evmVersion ${EVM_VERSION}; simulating from ${from}`);

try {
  await client.call({ account: from, data: get("ReceiptBatchRegistryChecks").bytecode });
  console.log("Behaviour checks: pass (record, read back, duplicate, zero root, empty batch, non-recorder, zero recorder)");
} catch (error) {
  console.error("Behaviour checks: FAIL", error instanceof BaseError ? error.shortMessage : error);
  process.exit(1);
}

const deployData = encodeDeployData({ abi: registry.abi, bytecode: registry.bytecode, args: [recorder] });
const created = await client.call({ account: from, data: deployData });
const [immutableId] = Object.keys(registry.immutableReferences);
const expected = runtimeWithImmutables(registry, { [immutableId as string]: encodeAbiParameters([{ type: "address" }], [recorder]) });
console.log(`Simulated deployment returns the expected runtime code (recorder ${recorder} filled in):`, created.data === expected);
if (created.data !== expected) process.exit(1);

const gasPrice = await client.getGasPrice();
const cost = async (data: Hex) => (await client.estimateGas({ account: from, data })) * gasPrice;
const deployCost = await cost(deployData);
const [deployOnly, oneWrite] = await Promise.all([cost(get("ReceiptBatchRegistryDeployOnly").bytecode), cost(get("ReceiptBatchRegistryOneWrite").bytecode)]);
console.log(`Deployment estimate: ${formatEther(deployCost)} tPOT at ${gasPrice} wei/gas (mostly Revive's storage deposit for the code)`);
console.log(`One recordBatch, any batch size: about ${formatEther(oneWrite - deployOnly)} tPOT (difference of two simulated deployments)`);
