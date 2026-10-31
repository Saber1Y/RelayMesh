// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ReceiptBatchLog
/// @notice Event-only audit anchor for RelayMesh receipt batches on PortalDot V3.
/// Like ReceiptBatchRegistry, one write commits a Merkle root over settled receipts and verified
/// bridge checks (leaf and node encodings in packages/core/src/merkle.ts), but nothing is stored:
/// the root lives in the BatchRecorded event of the recording transaction. That skips Revive's
/// storage deposit, which was almost all of a ReceiptBatchRegistry write's cost, so each settled
/// transfer can be anchored on its own as soon as it settles. A verifier reads the transaction
/// receipt and accepts a root only from a BatchRecorded log emitted by this contract's address;
/// only the recorder fixed at deployment can make it emit one. This proves what RelayMesh
/// committed to, not that a transfer settled.
contract ReceiptBatchLog {
    address public immutable recorder;

    /// Same signature as ReceiptBatchRegistry's event, so one decoder reads both.
    event BatchRecorded(bytes32 indexed root, address indexed recorder, uint32 leafCount);

    error ZeroAddress();
    error NotRecorder(address caller);
    error ZeroRoot();
    error EmptyBatch();

    constructor(address recorder_) {
        if (recorder_ == address(0)) revert ZeroAddress();
        recorder = recorder_;
    }

    function recordBatch(bytes32 root, uint32 leafCount) external {
        if (msg.sender != recorder) revert NotRecorder(msg.sender);
        if (root == bytes32(0)) revert ZeroRoot();
        if (leafCount == 0) revert EmptyBatch();
        emit BatchRecorded(root, msg.sender, leafCount);
    }
}
