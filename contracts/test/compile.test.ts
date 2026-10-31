import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { decodeAbiParameters, encodeAbiParameters, type Hex } from "viem";
import { compile, CONTRACTS_ROOT, readSources, runtimeWithImmutables, typedAbiSource } from "../scripts/solc";

const { contracts, warnings } = compile(readSources("src", "test"));
const byName = (name: string) => {
  const c = contracts.find((x) => x.contractName === name);
  if (!c) throw new Error(`${name} was not compiled`);
  return c;
};

describe("contract compilation", () => {
  it("compiles every contract without warnings", () => {
    expect(warnings).toEqual([]);
    expect(contracts.map((c) => c.contractName)).toEqual(expect.arrayContaining(["IntentRegistry", "ReceiptBatchRegistry", "ReceiptBatchRegistryChecks", "ReceiptBatchLog", "ReceiptBatchLogChecks"]));
  });

  it("keeps the committed typed ABIs in step with the sources", () => {
    for (const name of ["IntentRegistry", "ReceiptBatchRegistry", "ReceiptBatchLog"]) {
      expect(readFileSync(join(CONTRACTS_ROOT, "abi", `${name}.ts`), "utf8"), `abi/${name}.ts is stale: run pnpm compile`).toBe(typedAbiSource(byName(name)));
    }
  });

  it("exposes the batch registry interface the watcher and the verifier use", () => {
    const abi = byName("ReceiptBatchRegistry").abi;
    const names = abi.map((item) => ("name" in item ? `${item.type}:${item.name}` : item.type));
    expect(names).toEqual(
      expect.arrayContaining(["function:recordBatch", "function:getBatch", "function:recorder", "event:BatchRecorded", "error:NotRecorder", "error:BatchAlreadyRecorded"]),
    );
  });

  it("emits the same BatchRecorded event from both batch contracts, so one decoder reads either", () => {
    const event = (name: string) => byName(name).abi.find((item) => item.type === "event" && item.name === "BatchRecorded");
    expect(event("ReceiptBatchLog")).toEqual(event("ReceiptBatchRegistry"));
    expect(byName("ReceiptBatchLog").abi.some((item) => "name" in item && item.name === "getBatch")).toBe(false);
  });

  it("places the recorder in the runtime code exactly where solc reports the immutable", () => {
    const registry = byName("ReceiptBatchRegistry");
    const [id] = Object.keys(registry.immutableReferences);
    expect(Object.keys(registry.immutableReferences)).toHaveLength(1);
    const recorder = "0xd0dd606e328e9402c056d50171cacaadfb2563e4";
    const code = runtimeWithImmutables(registry, { [id as string]: encodeAbiParameters([{ type: "address" }], [recorder]) });
    expect(code.length).toBe(registry.deployedBytecode.length);
    for (const { start, length } of registry.immutableReferences[id as string] ?? []) {
      const word = `0x${code.slice(2 + start * 2, 2 + (start + length) * 2)}` as Hex;
      expect(decodeAbiParameters([{ type: "address" }], word)[0].toLowerCase()).toBe(recorder);
    }
    expect(() => runtimeWithImmutables(registry, {})).toThrow(/No 32-byte value/);
  });
});
