// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReceiptBatchRegistry} from "ReceiptBatchRegistry.sol";

// Behaviour checks for ReceiptBatchRegistry that run entirely inside one eth_call: the constructor
// of ReceiptBatchRegistryChecks deploys the registry, exercises it and reverts with a reason on the
// first failed check. Run against PortalDot V3 by scripts/check-batch-registry.ts; nothing is
// broadcast, so nothing is paid. Not part of the deployed system.

/// A second account, to call the registry as someone other than the recorder.
contract Stranger {
    function record(ReceiptBatchRegistry registry, bytes32 root) external returns (bool ok, bytes memory ret) {
        return address(registry).call(abi.encodeCall(ReceiptBatchRegistry.recordBatch, (root, 1)));
    }
}

contract ReceiptBatchRegistryChecks {
    constructor() {
        ReceiptBatchRegistry registry = new ReceiptBatchRegistry(address(this));
        require(registry.recorder() == address(this), "recorder is not the constructor argument");

        bytes32 root = keccak256("relaymesh-check-root");
        ReceiptBatchRegistry.Batch memory empty = registry.getBatch(root);
        require(empty.recordedAt == 0 && empty.blockNumber == 0 && empty.leafCount == 0, "unknown root is not all zeros");

        registry.recordBatch(root, 3);
        ReceiptBatchRegistry.Batch memory stored = registry.getBatch(root);
        require(stored.leafCount == 3, "leafCount not stored");
        require(stored.recordedAt == block.timestamp, "recordedAt is not the block timestamp");
        require(stored.blockNumber == block.number, "blockNumber is not the block number");

        expectRevert(address(registry), abi.encodeCall(ReceiptBatchRegistry.recordBatch, (root, 3)), ReceiptBatchRegistry.BatchAlreadyRecorded.selector, "duplicate root");
        expectRevert(address(registry), abi.encodeCall(ReceiptBatchRegistry.recordBatch, (bytes32(0), 1)), ReceiptBatchRegistry.ZeroRoot.selector, "zero root");
        expectRevert(address(registry), abi.encodeCall(ReceiptBatchRegistry.recordBatch, (keccak256("other"), 0)), ReceiptBatchRegistry.EmptyBatch.selector, "empty batch");

        (bool ok, bytes memory ret) = new Stranger().record(registry, keccak256("stranger-root"));
        require(!ok && bytes4(ret) == ReceiptBatchRegistry.NotRecorder.selector, "a non-recorder could write");
        require(registry.getBatch(keccak256("stranger-root")).recordedAt == 0, "a non-recorder's batch was stored");

        try new ReceiptBatchRegistry(address(0)) {
            revert("deployed with a zero recorder");
        } catch (bytes memory reason) {
            require(bytes4(reason) == ReceiptBatchRegistry.ZeroAddress.selector, "zero recorder: wrong error");
        }
    }

    function expectRevert(address target, bytes memory data, bytes4 selector, string memory what) private {
        (bool ok, bytes memory ret) = target.call(data);
        require(!ok, string.concat(what, ": did not revert"));
        require(ret.length >= 4 && bytes4(ret) == selector, string.concat(what, ": wrong error"));
    }
}

/// Deploys a registry and stops; with ReceiptBatchRegistryOneWrite, isolates the cost of one recordBatch.
contract ReceiptBatchRegistryDeployOnly {
    constructor() {
        new ReceiptBatchRegistry(address(this));
    }
}

contract ReceiptBatchRegistryOneWrite {
    constructor() {
        new ReceiptBatchRegistry(address(this)).recordBatch(keccak256("relaymesh-cost-root"), 64);
    }
}
