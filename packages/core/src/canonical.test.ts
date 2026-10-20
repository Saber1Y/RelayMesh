import { describe, expect, it } from "vitest";
import { canonicalJson, hashCanonical } from "./canonical";

describe("canonicalJson", () => {
  it("sorts keys recursively and omits undefined properties", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { z: true, y: null }], c: "x" }, u: undefined })).toBe(
      '{"a":{"c":"x","d":[1,{"y":null,"z":true}]},"b":1}',
    );
  });

  it("is independent of insertion order", () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });

  it("encodes bigint as a decimal string", () => {
    expect(canonicalJson({ amount: 10n ** 30n })).toBe('{"amount":"1000000000000000000000000000000"}');
  });

  it("rejects values without a single unambiguous encoding", () => {
    for (const bad of [{ n: Number.NaN }, { n: 1.5 }, { n: 2 ** 60 }, { d: new Date(0) }, { f: () => 1 }, [undefined], new Map()]) {
      expect(() => canonicalJson(bad)).toThrow(/Cannot canonicalize/);
    }
  });
});

describe("hashCanonical", () => {
  it("is deterministic and domain-separated", () => {
    const value = { a: 1n, b: "x" };
    expect(hashCanonical("relaymesh.test.v1", value)).toBe(hashCanonical("relaymesh.test.v1", { b: "x", a: 1n }));
    expect(hashCanonical("relaymesh.test.v1", value)).not.toBe(hashCanonical("relaymesh.test.v2", value));
    expect(hashCanonical("relaymesh.test.v1", value)).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("rejects malformed domains", () => {
    expect(() => hashCanonical("bad domain\n", {})).toThrow(/Invalid hash domain/);
  });
});
