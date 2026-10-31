// Deploys a RelayMesh contract to the PortalDot V3 testnet and verifies it by reading code and state back.
// Usage: tsx scripts/deploy.ts [IntentRegistry | ReceiptBatchRegistry | ReceiptBatchLog] (default IntentRegistry).
// Requires DEPLOYER_PRIVATE_KEY (an EVM key funded with tPOT on the V3 EVM side). The batch contracts
// fixes its recorder at deployment: BATCH_RECORDER_ADDRESS, or the deployer's own address if unset.
// Estimates: IntentRegistry about 96 tPOT (2026-10-20), ReceiptBatchRegistry about 82 tPOT
// (2026-10-29), ReceiptBatchLog about 50 tPOT (2026-10-31), mostly Revive's storage deposit for the code.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, encodeAbiParameters, encodeDeployData, formatEther, getAddress, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertEvmChainId, createV3PublicClient, loadPortaldotV3Config, portaldotV3EvmChain } from "@relaymesh/chains";
import { runtimeWithImmutables, type ImmutableReferences } from "./solc";

const CONTRACTS = ["IntentRegistry", "ReceiptBatchRegistry", "ReceiptBatchLog"] as const;
const name = (process.argv[2] ?? "IntentRegistry") as (typeof CONTRACTS)[number];
if (!CONTRACTS.includes(name)) {
  console.error(`Unknown contract ${name}; expected one of ${CONTRACTS.join(", ")}.`);
  process.exit(1);
}

const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("Set DEPLOYER_PRIVATE_KEY to a 0x-prefixed 32-byte hex key (see .env.example).");
  process.exit(1);
}
const recorderEnv = process.env.BATCH_RECORDER_ADDRESS;
if (recorderEnv && !/^0x[0-9a-fA-F]{40}$/.test(recorderEnv)) {
  console.error("BATCH_RECORDER_ADDRESS must be a 0x-prefixed 20-byte hex address.");
  process.exit(1);
}

const artifact = JSON.parse(readFileSync(join(import.meta.dirname, `../artifacts/${name}.json`), "utf8")) as {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
  immutableReferences?: ImmutableReferences;
};

const config = loadPortaldotV3Config();
const publicClient = createV3PublicClient(config);
await assertEvmChainId(publicClient, config.evmChainId);
const account = privateKeyToAccount(key as Hex);
const wallet = createWalletClient({ account, chain: portaldotV3EvmChain(config), transport: http(config.evmRpcUrl) });

const recorder = getAddress(recorderEnv ?? account.address);
const hasRecorder = name !== "IntentRegistry";
const args: readonly unknown[] = hasRecorder ? [recorder] : [];
// The runtime code the deployment must hold. The recorder is the batch contracts' only immutable.
const refs = artifact.immutableReferences ?? {};
const recorderWord = encodeAbiParameters([{ type: "address" }], [recorder]);
const expectedCode = runtimeWithImmutables({ deployedBytecode: artifact.deployedBytecode, immutableReferences: refs }, Object.fromEntries(Object.keys(refs).map((id) => [id, recorderWord])));
if (hasRecorder) console.log(`Recorder (the only account that may write batches): ${recorder}`);

const deploy = { abi: artifact.abi, bytecode: artifact.bytecode, args } as const;
const balance = await publicClient.getBalance({ address: account.address });
const gas = await publicClient.estimateGas({ account, data: encodeDeployData(deploy) });
const gasPrice = await publicClient.getGasPrice();
console.log(`Deployer ${account.address}: balance ${formatEther(balance)} tPOT, estimated cost ${formatEther(gas * gasPrice)} tPOT`);
if (balance < gas * gasPrice) {
  console.error("Insufficient balance for the deployment estimate.");
  process.exit(1);
}

const txHash = await wallet.deployContract(deploy);
console.log(`Submitted ${txHash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 });
if (receipt.status !== "success" || !receipt.contractAddress) {
  console.error(`Deployment failed: status ${receipt.status}`);
  process.exit(1);
}

const code = await publicClient.getCode({ address: receipt.contractAddress });
if (code?.toLowerCase() !== expectedCode.toLowerCase()) {
  console.error("Deployed code does not match the compiled artifact.");
  process.exit(1);
}
if (hasRecorder) {
  const onChain = (await publicClient.readContract({ address: receipt.contractAddress, abi: artifact.abi, functionName: "recorder" })) as Hex;
  if (getAddress(onChain) !== recorder) {
    console.error(`Deployed recorder ${onChain} is not ${recorder}.`);
    process.exit(1);
  }
}
console.log(
  JSON.stringify(
    { contract: name, address: receipt.contractAddress, txHash, blockNumber: receipt.blockNumber.toString(), chainId: config.evmChainId, ...(args.length > 0 && { recorder }) },
    null,
    2,
  ),
);
console.log(
  name === "ReceiptBatchLog"
    ? "Record these values in docs/evidence.md, then set RECEIPT_BATCH_LOG_ADDRESS for the worker and the web app."
    : name === "ReceiptBatchRegistry"
      ? "Record these values in docs/evidence.md, then set RECEIPT_BATCH_REGISTRY_ADDRESS for the worker and the web app."
      : "Record these values in docs/evidence.md and set INTENT_REGISTRY_ADDRESS for the web app's receipt checker.",
);
