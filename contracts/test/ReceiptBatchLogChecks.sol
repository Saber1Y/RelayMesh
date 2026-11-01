// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReceiptBatchLog} from "ReceiptBatchLog.sol";

// Behaviour checks for ReceiptBatchLog that run entirely inside one eth_call, like
// ReceiptBatchRegistryChecks: the constructor deploys the log, exercises it and reverts with a reason
// on the first failed check. Run against PortalDot V3 by scripts/simulate-batch-registry.ts; nothing
// is broadcast, so nothing is paid. Not part of the deployed system.

/// A second account, to call the log as someone other than the recorder.
contract LogStranger {
    function record(ReceiptBatchLog log, bytes32 root) external returns (bool ok, bytes memory ret) {
        return address(log).call(abi.encodeCall(ReceiptBatchLog.recordBatch, (root, 1)));
    }
}

contract ReceiptBatchLogChecks {
    constructor() {
        ReceiptBatchLog log = new ReceiptBatchLog(address(this));
        require(log.recorder() == address(this), "recorder is not the constructor argument");

        bytes32 root = keccak256("relaymesh-check-root");
        log.recordBatch(root, 3);
        // Nothing is stored, so recording the same root again is allowed and only emits again.
        log.recordBatch(root, 3);

        expectRevert(address(log), abi.encodeCall(ReceiptBatchLog.recordBatch, (bytes32(0), 1)), ReceiptBatchLog.ZeroRoot.selector, "zero root");
        expectRevert(address(log), abi.encodeCall(ReceiptBatchLog.recordBatch, (root, 0)), ReceiptBatchLog.EmptyBatch.selector, "empty batch");

        (bool ok, bytes memory ret) = new LogStranger().record(log, keccak256("stranger-root"));
        require(!ok && bytes4(ret) == ReceiptBatchLog.NotRecorder.selector, "a non-recorder could write");

        try new ReceiptBatchLog(address(0)) {
            revert("deployed with a zero recorder");
        } catch (bytes memory reason) {
            require(bytes4(reason) == ReceiptBatchLog.ZeroAddress.selector, "zero recorder: wrong error");
        }
    }

    function expectRevert(address target, bytes memory data, bytes4 selector, string memory what) private {
        (bool ok, bytes memory ret) = target.call(data);
        require(!ok, string.concat(what, ": did not revert"));
        require(ret.length >= 4 && bytes4(ret) == selector, string.concat(what, ": wrong error"));
    }
}

/// Deploys a log and stops; with ReceiptBatchLogOneWrite, isolates the cost of one recordBatch.
contract ReceiptBatchLogDeployOnly {
    constructor() {
        new ReceiptBatchLog(address(this));
    }
}

contract ReceiptBatchLogOneWrite {
    constructor() {
        new ReceiptBatchLog(address(this)).recordBatch(keccak256("relaymesh-cost-root"), 64);
    }
}
