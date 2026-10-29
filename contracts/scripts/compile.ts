// Compiles contracts/src/*.sol to EVM bytecode with solc-js and writes artifacts/<Name>.json and the typed abi/<Name>.ts.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compile, CONTRACTS_ROOT, EVM_VERSION, readSources, SOLC_VERSION, typedAbiSource } from "./solc";

const outDir = join(CONTRACTS_ROOT, "artifacts");
const abiDir = join(CONTRACTS_ROOT, "abi");

let result: ReturnType<typeof compile>;
try {
  result = compile(readSources("src"));
} catch (error) {
  console.error((error as Error).message);
  process.exit(1);
}
for (const warning of result.warnings) console.warn(warning);

mkdirSync(outDir, { recursive: true });
mkdirSync(abiDir, { recursive: true });
for (const c of result.contracts) {
  const artifact = {
    contractName: c.contractName,
    sourceName: c.sourceName,
    compiler: { solc: SOLC_VERSION, evmVersion: EVM_VERSION },
    abi: c.abi,
    bytecode: c.bytecode,
    deployedBytecode: c.deployedBytecode,
    immutableReferences: c.immutableReferences,
  };
  writeFileSync(join(outDir, `${c.contractName}.json`), `${JSON.stringify(artifact, null, 2)}\n`);
  writeFileSync(join(abiDir, `${c.contractName}.ts`), typedAbiSource(c));
  console.log(`${c.contractName}: ${(c.deployedBytecode.length - 2) / 2} bytes runtime (solc ${SOLC_VERSION}, ${EVM_VERSION})`);
}
