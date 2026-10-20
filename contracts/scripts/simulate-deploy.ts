// Spike B (read-only): simulate deploying IntentRegistry on PortalDot V3 via eth_call / eth_estimateGas,
// then simulate recordIntent against the simulated code. Nothing is signed or broadcast.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { encodeFunctionData, keccak256, toHex, type Abi, type Hex } from "viem";
import { assertEvmChainId, createV3PublicClient, loadPortaldotV3Config } from "@relaymesh/chains";

const artifact = JSON.parse(readFileSync(join(import.meta.dirname, "../artifacts/IntentRegistry.json"), "utf8")) as {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  compiler: { solc: string; evmVersion: string };
};

// Any funded EVM-side address works for simulation. Default: the H160 the spike derived for the
// public sudo account (it has balance), overridable for your own account.
const from = (process.env.SPIKE_EVM_FROM || "0xb4a81005669984dbbf9de26af42e82bc9a3c4a27") as Hex;

const config = loadPortaldotV3Config();
const client = createV3PublicClient(config);
await assertEvmChainId(client, config.evmChainId);
console.log(`Compiler: solc ${artifact.compiler.solc}, evmVersion ${artifact.compiler.evmVersion}`);

const deploy = await client.call({ account: from, data: artifact.bytecode });
console.log("eth_call (create) returned runtime code matching artifact:", deploy.data === artifact.deployedBytecode);

const gas = await client.estimateGas({ account: from, data: artifact.bytecode });
const gasPrice = await client.getGasPrice();
console.log(`Deployment estimate: ${gas} gas at ${gasPrice} wei/gas = ${gas * gasPrice} wei`);

// recordIntent cannot be simulated against code that is not deployed yet, so use a state override
// to place the runtime code at a throwaway address.
const registry = "0x000000000000000000000000000000000000ce1a" as Hex;
const intentHash = keccak256(toHex("relaymesh-spike-intent"));
const routeId = keccak256(toHex("v3-substrate-to-evm"));
try {
  const sim = await client.call({
    account: from,
    to: registry,
    data: encodeFunctionData({ abi: artifact.abi, functionName: "recordIntent", args: [intentHash, routeId] }),
    stateOverride: [{ address: registry, code: artifact.deployedBytecode }],
  });
  console.log("recordIntent simulation succeeded:", sim.data ?? "0x");
} catch (error) {
  console.log("recordIntent simulation with state override failed (override may be unsupported):", (error as Error).message.split("\n")[0]);
}
