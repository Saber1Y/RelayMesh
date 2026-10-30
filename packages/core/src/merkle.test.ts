import { describe, expect, it } from "vitest";
import { keccak256, stringToBytes, type Hex } from "viem";
import { hashCanonical } from "./canonical";
import { BATCH_NODE_DOMAIN, batchLeaf, bridgeCheckLeaf, buildMerkleTree, merkleProof, merkleRootFromProof, verifyMerkleProof } from "./merkle";

const hash = (n: number) => keccak256(stringToBytes(`value-${n}`));
const leaves = (count: number) => Array.from({ length: count }, (_, i) => batchLeaf(hash(i), hash(1_000 + i)));

describe("batchLeaf", () => {
  it("commits to both hashes under its own domain", () => {
    const leaf = batchLeaf(hash(1), hash(2));
    expect(leaf).toBe(keccak256(stringToBytes(`relaymesh.batch.leaf.v1\n{"intentHash":"${hash(1)}","receiptHash":"${hash(2)}"}`)));
    expect(batchLeaf(hash(2), hash(1))).not.toBe(leaf);
    expect(batchLeaf(hash(1), hash(3))).not.toBe(leaf);
  });

  it("accepts only one spelling of each hash", () => {
    expect(() => batchLeaf(hash(1).toUpperCase().replace("0X", "0x") as Hex, hash(2))).toThrow(/lowercase 32-byte hex/);
    expect(() => batchLeaf("0x12", hash(2))).toThrow(/intentHash/);
  });
});

describe("buildMerkleTree", () => {
  it("uses the leaf itself as the root of a one-leaf batch, with an empty proof", () => {
    const [leaf] = leaves(1) as [Hex];
    const tree = buildMerkleTree([leaf]);
    expect(tree.root).toBe(leaf);
    expect(merkleProof(tree, leaf)).toEqual([]);
    expect(verifyMerkleProof(leaf, [], tree.root)).toBe(true);
  });

  it("hashes a sorted pair under the node domain", () => {
    const [a, b] = leaves(2) as [Hex, Hex];
    const [lo, hi] = a < b ? [a, b] : [b, a];
    expect(buildMerkleTree([a, b]).root).toBe(hashCanonical(BATCH_NODE_DOMAIN, [lo, hi]));
  });

  it("depends only on the set of leaves, not their order", () => {
    const set = leaves(7);
    expect(buildMerkleTree([...set].reverse()).root).toBe(buildMerkleTree(set).root);
  });

  it("carries an odd node up instead of duplicating it", () => {
    const [a, b, c] = buildMerkleTree(leaves(3)).leaves as [Hex, Hex, Hex];
    const ab = hashCanonical(BATCH_NODE_DOMAIN, [a, b].sort());
    expect(buildMerkleTree([a, b, c]).root).toBe(hashCanonical(BATCH_NODE_DOMAIN, [ab, c].sort()));
    // With duplication, [a, b, c] and [a, b, c, c] would share a root.
    expect(() => buildMerkleTree([a, b, c, c])).toThrow(/Duplicate leaf/);
  });

  it("rejects an empty batch and malformed leaves", () => {
    expect(() => buildMerkleTree([])).toThrow(/at least one leaf/);
    expect(() => buildMerkleTree(["0xabc" as Hex])).toThrow(/leaves\[0\]/);
  });
});

describe("merkle proofs", () => {
  it("proves every leaf of batches of many sizes", () => {
    for (const count of [1, 2, 3, 4, 5, 8, 13, 64, 100]) {
      const set = leaves(count);
      const tree = buildMerkleTree(set);
      for (const leaf of set) {
        const proof = merkleProof(tree, leaf);
        expect(proof.length).toBeLessThanOrEqual(Math.ceil(Math.log2(count)));
        expect(merkleRootFromProof(leaf, proof)).toBe(tree.root);
        expect(verifyMerkleProof(leaf, proof, tree.root)).toBe(true);
      }
    }
  });

  it("fails for a leaf outside the batch, a changed proof, or another root", () => {
    const set = leaves(9);
    const tree = buildMerkleTree(set);
    const leaf = set[4] as Hex;
    const proof = merkleProof(tree, leaf);
    const outsider = batchLeaf(hash(4), hash(9_999)); // same intent, different receipt
    expect(verifyMerkleProof(outsider, proof, tree.root)).toBe(false);
    expect(verifyMerkleProof(leaf, [...proof.slice(0, -1), hash(42)], tree.root)).toBe(false);
    expect(verifyMerkleProof(leaf, proof.slice(1), tree.root)).toBe(false);
    expect(verifyMerkleProof(leaf, proof, buildMerkleTree(leaves(8)).root)).toBe(false);
    expect(() => merkleProof(tree, outsider)).toThrow(/not in this tree/);
  });

  it("folds an inner node to the root too, so verifiers must recompute the leaf themselves", () => {
    const tree = buildMerkleTree(leaves(4));
    const inner = tree.levels[1]?.[0] as Hex;
    expect(verifyMerkleProof(inner, [tree.levels[1]?.[1] as Hex], tree.root)).toBe(true);
    // An inner node passes the fold, so the leaf must always be recomputed from the receipt, never
    // taken from the proof supplier. A leaf hash cannot equal a node hash: their domains differ.
    expect(tree.leaves).not.toContain(inner);
  });

  it("returns false rather than throwing on malformed proof input", () => {
    const [leaf] = leaves(1) as [Hex];
    expect(verifyMerkleProof(leaf, ["0xnope" as Hex], leaf)).toBe(false);
    expect(verifyMerkleProof(leaf, [], "0x00" as Hex)).toBe(false);
  });
});

describe("bridge check leaves", () => {
  it("never collide with a receipt leaf built from the same hash", () => {
    const h = hash(7);
    expect(bridgeCheckLeaf(h)).not.toBe(batchLeaf(h, h));
  });

  it("share a tree and proofs with receipt leaves", () => {
    const mixed = [...leaves(3), bridgeCheckLeaf(hash(42))];
    const tree = buildMerkleTree(mixed);
    expect(verifyMerkleProof(bridgeCheckLeaf(hash(42)), merkleProof(tree, bridgeCheckLeaf(hash(42))), tree.root)).toBe(true);
  });

  it("reject a check hash that is not lowercase 32-byte hex", () => {
    expect(() => bridgeCheckLeaf("0xABC" as Hex)).toThrow(/checkHash/);
  });
});
