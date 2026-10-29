// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ReceiptBatchRegistry
/// @notice Batched audit anchor for RelayMesh receipts on PortalDot V3.
/// One write records the Merkle root over many settled intents, so the Revive storage deposit is paid
/// once per batch instead of twice per intent. Each leaf commits to an (intentHash, receiptHash) pair;
/// the leaf and node encodings are defined in packages/core/src/merkle.ts, and proofs are checked off
/// chain against the root stored here. Like IntentRegistry, this proves only what RelayMesh committed
/// to, not that a transfer settled. Only the recorder fixed at deployment can write.
contract ReceiptBatchRegistry {
    /// Packed into one storage slot: one storage deposit per batch.
    struct Batch {
        uint64 recordedAt;
        uint64 blockNumber;
        uint32 leafCount;
    }

    address public immutable recorder;

    mapping(bytes32 root => Batch) private batches;

    event BatchRecorded(bytes32 indexed root, address indexed recorder, uint32 leafCount);

    error ZeroAddress();
    error NotRecorder(address caller);
    error ZeroRoot();
    error EmptyBatch();
    error BatchAlreadyRecorded(bytes32 root);

    constructor(address recorder_) {
        if (recorder_ == address(0)) revert ZeroAddress();
        recorder = recorder_;
    }

    function recordBatch(bytes32 root, uint32 leafCount) external {
        if (msg.sender != recorder) revert NotRecorder(msg.sender);
        if (root == bytes32(0)) revert ZeroRoot();
        if (leafCount == 0) revert EmptyBatch();
        if (batches[root].recordedAt != 0) revert BatchAlreadyRecorded(root);

        batches[root] = Batch({recordedAt: uint64(block.timestamp), blockNumber: uint64(block.number), leafCount: leafCount});
        emit BatchRecorded(root, msg.sender, leafCount);
    }

    /// @return The batch, or all zeros if this root was never recorded.
    function getBatch(bytes32 root) external view returns (Batch memory) {
        return batches[root];
    }
}
