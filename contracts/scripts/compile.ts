// Compiles contracts/src/*.sol to EVM bytecode with solc-js and writes artifacts/<Name>.json.
// PortalDot V3's Revive pallet reports allowEVMBytecode = true, so standard solc output is the target.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const solc = require("solc") as { version(): string; compile(input: string): string };

export const EVM_VERSION = process.env.SOLC_EVM_VERSION || "cancun";

const root = join(import.meta.dirname, "..");
const srcDir = join(root, "src");
const outDir = join(root, "artifacts");

const sources = Object.fromEntries(
  readdirSync(srcDir)
    .filter((f) => f.endsWith(".sol"))
    .map((f) => [f, { content: readFileSync(join(srcDir, f), "utf8") }]),
);

const output = JSON.parse(
  solc.compile(
    JSON.stringify({
      language: "Solidity",
      sources,
      settings: {
        evmVersion: EVM_VERSION,
        optimizer: { enabled: true, runs: 200 },
        outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
      },
    }),
  ),
) as {
  errors?: { severity: string; formattedMessage: string }[];
  contracts: Record<string, Record<string, { abi: unknown; evm: { bytecode: { object: string }; deployedBytecode: { object: string } } }>>;
};

const errors = (output.errors ?? []).filter((e) => e.severity === "error");
for (const e of output.errors ?? []) console[e.severity === "error" ? "error" : "warn"](e.formattedMessage);
if (errors.length > 0) process.exit(1);

mkdirSync(outDir, { recursive: true });
for (const [file, contracts] of Object.entries(output.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    const artifact = {
      contractName: name,
      sourceName: file,
      compiler: { solc: solc.version(), evmVersion: EVM_VERSION },
      abi: c.abi,
      bytecode: `0x${c.evm.bytecode.object}`,
      deployedBytecode: `0x${c.evm.deployedBytecode.object}`,
    };
    writeFileSync(join(outDir, `${name}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
    console.log(`${name}: ${c.evm.deployedBytecode.object.length / 2} bytes runtime (solc ${solc.version()}, ${EVM_VERSION})`);
  }
}
