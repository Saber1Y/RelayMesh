// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IntentRegistry
/// @notice Audit anchor for RelayMesh intents on PortalDot V3.
/// A recorder (the RelayMesh relayer account) commits an intent hash and route, and later the hash
/// of the settlement receipt it published. It does NOT prove that any transfer settled; receipts
/// carry their own chain evidence and must be verified independently. Only the original recorder
/// can attach the receipt.
contract IntentRegistry {
    struct Intent {
        address recorder;
        bytes32 routeId;
        uint64 recordedAt;
        bytes32 receiptHash;
        uint64 receiptRecordedAt;
    }

    mapping(bytes32 intentHash => Intent) private intents;

    event IntentRecorded(bytes32 indexed intentHash, address indexed recorder, bytes32 routeId);
    event ReceiptRecorded(bytes32 indexed intentHash, address indexed recorder, bytes32 receiptHash);

    error ZeroHash();
    error IntentAlreadyRecorded(bytes32 intentHash);
    error UnknownIntent(bytes32 intentHash);
    error NotRecorder(bytes32 intentHash, address caller);
    error ReceiptAlreadyRecorded(bytes32 intentHash);

    function recordIntent(bytes32 intentHash, bytes32 routeId) external {
        if (intentHash == bytes32(0) || routeId == bytes32(0)) revert ZeroHash();
        if (intents[intentHash].recorder != address(0)) revert IntentAlreadyRecorded(intentHash);

        intents[intentHash] = Intent({
            recorder: msg.sender,
            routeId: routeId,
            recordedAt: uint64(block.timestamp),
            receiptHash: bytes32(0),
            receiptRecordedAt: 0
        });
        emit IntentRecorded(intentHash, msg.sender, routeId);
    }

    function recordReceipt(bytes32 intentHash, bytes32 receiptHash) external {
        if (receiptHash == bytes32(0)) revert ZeroHash();
        Intent storage intent = intents[intentHash];
        if (intent.recorder == address(0)) revert UnknownIntent(intentHash);
        if (intent.recorder != msg.sender) revert NotRecorder(intentHash, msg.sender);
        if (intent.receiptHash != bytes32(0)) revert ReceiptAlreadyRecorded(intentHash);

        intent.receiptHash = receiptHash;
        intent.receiptRecordedAt = uint64(block.timestamp);
        emit ReceiptRecorded(intentHash, msg.sender, receiptHash);
    }

    function getIntent(bytes32 intentHash) external view returns (Intent memory) {
        return intents[intentHash];
    }
}
