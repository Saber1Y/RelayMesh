import type { Hex } from "viem";
import { hashCanonical } from "./canonical";
import { RelayMeshError } from "./errors";

/**
 * Merkle batches of anchored receipts. One on-chain write records the root; each settled intent keeps
 * its own leaf and proof, and anyone can recompute the leaf from the receipt and fold the proof up to
 * the root read from the chain.
 *
 * - Leaf: hashCanonical("relaymesh.batch.leaf.v1", { intentHash, receiptHash }) for a receipt, or
 *   hashCanonical("relaymesh.batch.bridge.v1", { checkHash }) for a verified bridge transfer.
 * - Node: hashCanonical("relaymesh.batch.node.v1", [a, b]) with a <= b (sorted-pair hashing), so a
 *   proof is just the sibling hashes, bottom up, with no left/right flags.
 * - Leaves and nodes use different domains, so a node can never be presented as a leaf.
 * - Leaves are sorted ascending and must be unique; the root depends only on the set of leaves.
 * - A level with an odd count carries its last node up unchanged (never duplicated).
 */

export const BATCH_LEAF_DOMAIN = "relaymesh.batch.leaf.v1";
export const BATCH_NODE_DOMAIN = "relaymesh.batch.node.v1";
export const BATCH_BRIDGE_LEAF_DOMAIN = "relaymesh.batch.bridge.v1";

const HEX32 = /^0x[0-9a-f]{64}$/;

function checkHash(value: string, what: string): Hex {
  // Lowercase only: the canonical JSON of a leaf or node must have exactly one spelling.
  if (!HEX32.test(value)) throw new RelayMeshError("INVALID_BATCH", `${what} must be a lowercase 32-byte hex value`, what);
  return value as Hex;
}

/** The leaf committing one intent to its receipt. */
export function batchLeaf(intentHash: Hex, receiptHash: Hex): Hex {
  return hashCanonical(BATCH_LEAF_DOMAIN, { intentHash: checkHash(intentHash, "intentHash"), receiptHash: checkHash(receiptHash, "receiptHash") });
}

/** The leaf committing one verified bridge transfer, by the hash of its check (see bridge.ts). */
export function bridgeCheckLeaf(bridgeCheckHash: Hex): Hex {
  return hashCanonical(BATCH_BRIDGE_LEAF_DOMAIN, { checkHash: checkHash(bridgeCheckHash, "checkHash") });
}

function hashPair(a: Hex, b: Hex): Hex {
  return hashCanonical(BATCH_NODE_DOMAIN, a <= b ? [a, b] : [b, a]);
}

export interface MerkleTree {
  root: Hex;
  /** Leaves in tree order (ascending). */
  leaves: Hex[];
  /** Levels bottom up: levels[0] is the leaves, the last level is [root]. */
  levels: Hex[][];
}

export function buildMerkleTree(leaves: readonly Hex[]): MerkleTree {
  if (leaves.length === 0) throw new RelayMeshError("INVALID_BATCH", "A batch needs at least one leaf");
  const sorted = leaves.map((leaf, i) => checkHash(leaf, `leaves[${i}]`)).sort();
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] === sorted[i - 1]) throw new RelayMeshError("INVALID_BATCH", `Duplicate leaf ${sorted[i]}`);
  }
  const levels: Hex[][] = [sorted];
  for (let level = sorted; level.length > 1; ) {
    const next: Hex[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i] as Hex;
      const right = level[i + 1];
      next.push(right === undefined ? left : hashPair(left, right));
    }
    levels.push(next);
    level = next;
  }
  return { root: levels.at(-1)?.[0] as Hex, leaves: sorted, levels };
}

/** Sibling hashes from the leaf up to the root. A single-leaf tree has an empty proof. */
export function merkleProof(tree: MerkleTree, leaf: Hex): Hex[] {
  let index = tree.leaves.indexOf(leaf);
  if (index < 0) throw new RelayMeshError("INVALID_BATCH", `Leaf ${leaf} is not in this tree`);
  const proof: Hex[] = [];
  for (const level of tree.levels.slice(0, -1)) {
    const sibling = level[index ^ 1];
    if (sibling !== undefined) proof.push(sibling);
    index >>= 1;
  }
  return proof;
}

/** Folds a proof up from a leaf. Equal to the batch root exactly when the leaf is in the batch. */
export function merkleRootFromProof(leaf: Hex, proof: readonly Hex[]): Hex {
  return proof.reduce<Hex>((node, sibling, i) => hashPair(node, checkHash(sibling, `proof[${i}]`)), checkHash(leaf, "leaf"));
}

export function verifyMerkleProof(leaf: Hex, proof: readonly Hex[], root: Hex): boolean {
  try {
    return merkleRootFromProof(leaf, proof) === checkHash(root, "root");
  } catch {
    return false;
  }
}
