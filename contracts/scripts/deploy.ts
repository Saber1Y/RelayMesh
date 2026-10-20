// Deploys IntentRegistry to the PortalDot V3 testnet and verifies it by reading code and state back.
// Requires DEPLOYER_PRIVATE_KEY (an EVM key funded with tPOT on the V3 EVM side). The deployment
// estimate on 2026-10-20 was about 96 tPOT, mostly Revive's refundable storage deposit.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createWalletClient, formatEther, http, type Abi, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assertEvmChainId, createV3PublicClient, loadPortaldotV3Config, portaldotV3EvmChain } from "@relaymesh/chains";

const key = process.env.DEPLOYER_PRIVATE_KEY;
if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) {
  console.error("Set DEPLOYER_PRIVATE_KEY to a 0x-prefixed 32-byte hex key (see .env.example).");
  process.exit(1);
}

const artifact = JSON.parse(readFileSync(join(import.meta.dirname, "../artifacts/IntentRegistry.json"), "utf8")) as {
  abi: Abi;
  bytecode: Hex;
  deployedBytecode: Hex;
};

const config = loadPortaldotV3Config();
const publicClient = createV3PublicClient(config);
await assertEvmChainId(publicClient, config.evmChainId);
const account = privateKeyToAccount(key as Hex);
const wallet = createWalletClient({ account, chain: portaldotV3EvmChain(config), transport: http(config.evmRpcUrl) });

const balance = await publicClient.getBalance({ address: account.address });
const gas = await publicClient.estimateGas({ account, data: artifact.bytecode });
const gasPrice = await publicClient.getGasPrice();
console.log(`Deployer ${account.address}: balance ${formatEther(balance)} tPOT, estimated cost ${formatEther(gas * gasPrice)} tPOT`);
if (balance < gas * gasPrice) {
  console.error("Insufficient balance for the deployment estimate.");
  process.exit(1);
}

const txHash = await wallet.deployContract({ abi: artifact.abi, bytecode: artifact.bytecode });
console.log(`Submitted ${txHash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 180_000 });
if (receipt.status !== "success" || !receipt.contractAddress) {
  console.error(`Deployment failed: status ${receipt.status}`);
  process.exit(1);
}

const code = await publicClient.getCode({ address: receipt.contractAddress });
if (code !== artifact.deployedBytecode) {
  console.error("Deployed code does not match the compiled artifact.");
  process.exit(1);
}
console.log(
  JSON.stringify(
    { contract: "IntentRegistry", address: receipt.contractAddress, txHash, blockNumber: receipt.blockNumber.toString(), chainId: config.evmChainId },
    null,
    2,
  ),
);
console.log("Record these values in docs/evidence.md and set INTENT_REGISTRY_ADDRESS for the worker.");
