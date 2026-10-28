import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes, type Hex } from "viem";
import { parseReceipt, ReceiptFormatError, receiptHashOf, verifyReceipt, type AnchorState, type RegistryReader } from "./verify-receipt";

// The real receipt of the 150 tPOT transfer settled in block #136917, as downloaded from RelayMesh,
// and the receipt hash the relayer anchored for it in IntentRegistry (tx 0x7b09dc97…, block #136956).
const RECEIPT_JSON = readFileSync(new URL("./fixtures/receipt-block-136917.json", import.meta.url), "utf8");
const ANCHORED_HASH = "0x58f6e2f9dae10f1a2313815ad21f8fd8b8ef1cc3f2d00f9e17db47ea793fb54e" as Hex;
const RELAYER = "0xd0dd606e328e9402c056d50171cacaadfb2563e4" as Hex;
const ROUTE_ID = keccak256(stringToBytes("v3-substrate-to-evm"));
const ZERO_HASH = `0x${"0".repeat(64)}` as Hex;
const ANCHORED: AnchorState = { recorder: RELAYER, routeId: ROUTE_ID, receiptHash: ANCHORED_HASH };

function reader(state: AnchorState | null, findReceiptTx: RegistryReader["findReceiptTx"] = async () => ({ txHash: "0x7b09" as Hex, blockNumber: 136956n })): RegistryReader {
  return {
    getIntent: async () => state ?? { recorder: `0x${"0".repeat(40)}` as Hex, routeId: ZERO_HASH, receiptHash: ZERO_HASH },
    findReceiptTx,
  };
}

describe("receipt verification in the browser", () => {
  it("re-hashes the real downloaded receipt to the hash anchored on chain", () => {
    expect(receiptHashOf(parseReceipt(RECEIPT_JSON))).toBe(ANCHORED_HASH);
  });

  it("gives the same hash for a pretty-printed copy, since the hash covers canonical JSON", () => {
    expect(receiptHashOf(parseReceipt(JSON.stringify(JSON.parse(RECEIPT_JSON), null, 2)))).toBe(ANCHORED_HASH);
  });

  it("matches when the registry holds this receipt's hash", async () => {
    const result = await verifyReceipt(parseReceipt(RECEIPT_JSON), reader(ANCHORED));
    expect(result).toMatchObject({ verdict: "match", computedHash: ANCHORED_HASH, routeMatches: true, anchorTx: { blockNumber: 136956n } });
  });

  it("catches one changed digit in the observed amount", async () => {
    const tampered = RECEIPT_JSON.replace('"observedAmount":"149900000000000000000"', '"observedAmount":"249900000000000000000"');
    expect(tampered).not.toBe(RECEIPT_JSON);
    const result = await verifyReceipt(parseReceipt(tampered), reader(ANCHORED));
    expect(result.verdict).toBe("mismatch");
    expect(result.computedHash).not.toBe(ANCHORED_HASH);
  });

  it("reports a recorded intent whose receipt is not on chain yet", async () => {
    const result = await verifyReceipt(parseReceipt(RECEIPT_JSON), reader({ ...ANCHORED, receiptHash: ZERO_HASH }));
    expect(result).toMatchObject({ verdict: "receipt_pending", anchorTx: null });
  });

  it("reports an intent that was never anchored", async () => {
    expect(await verifyReceipt(parseReceipt(RECEIPT_JSON), reader(null))).toMatchObject({ verdict: "not_anchored", routeMatches: null });
  });

  it("flags a route ID on chain that differs from the receipt's", async () => {
    const result = await verifyReceipt(parseReceipt(RECEIPT_JSON), reader({ ...ANCHORED, routeId: keccak256(stringToBytes("other-route")) }));
    expect(result).toMatchObject({ verdict: "match", routeMatches: false });
  });

  it("keeps the verdict when the transaction search fails", async () => {
    const failing = reader(ANCHORED, async () => {
      throw new Error("log range too large");
    });
    expect(await verifyReceipt(parseReceipt(RECEIPT_JSON), failing)).toMatchObject({ verdict: "match", anchorTx: null });
  });

  it("rejects input that is not a RelayMesh receipt, with a reason", () => {
    expect(() => parseReceipt("{not json")).toThrow(ReceiptFormatError);
    expect(() => parseReceipt(JSON.stringify({ version: 2 }))).toThrow(/version 1/);
    expect(() => parseReceipt(JSON.stringify({ version: 1, intentId: "0x12", intentHash: "0x" }))).toThrow(/intentId/);
  });
});
