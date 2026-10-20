// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IntentRegistry
/// @notice Audit anchor for RelayMesh intents on PortalDot V3.
/// It records that a requester committed to an intent and route, and later the hash of the
/// settlement receipt the requester published. It does NOT prove that any transfer settled;
/// receipts carry their own chain evidence and must be verified independently.
contract IntentRegistry {
    struct Intent {
        address requester;
        bytes32 routeId;
        uint64 recordedAt;
        bytes32 receiptHash;
        uint64 receiptRecordedAt;
    }

    mapping(bytes32 intentHash => Intent) private intents;

    event IntentRecorded(bytes32 indexed intentHash, address indexed requester, bytes32 routeId);
    event ReceiptRecorded(bytes32 indexed intentHash, address indexed requester, bytes32 receiptHash);

    error ZeroHash();
    error IntentAlreadyRecorded(bytes32 intentHash);
    error UnknownIntent(bytes32 intentHash);
    error NotRequester(bytes32 intentHash, address caller);
    error ReceiptAlreadyRecorded(bytes32 intentHash);

    function recordIntent(bytes32 intentHash, bytes32 routeId) external {
        if (intentHash == bytes32(0) || routeId == bytes32(0)) revert ZeroHash();
        if (intents[intentHash].requester != address(0)) revert IntentAlreadyRecorded(intentHash);

        intents[intentHash] = Intent({
            requester: msg.sender,
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
        if (intent.requester == address(0)) revert UnknownIntent(intentHash);
        if (intent.requester != msg.sender) revert NotRequester(intentHash, msg.sender);
        if (intent.receiptHash != bytes32(0)) revert ReceiptAlreadyRecorded(intentHash);

        intent.receiptHash = receiptHash;
        intent.receiptRecordedAt = uint64(block.timestamp);
        emit ReceiptRecorded(intentHash, msg.sender, receiptHash);
    }

    function getIntent(bytes32 intentHash) external view returns (Intent memory) {
        return intents[intentHash];
    }
}
