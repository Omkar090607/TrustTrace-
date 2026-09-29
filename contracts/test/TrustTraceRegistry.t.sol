// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import "../TrustTraceRegistry.sol";

interface Vm {
    struct Log {
        bytes32[] topics;
        bytes data;
        address emitter;
    }

    function recordLogs() external;
    function getRecordedLogs() external returns (Log[] memory);
}

contract TrustTraceRegistryTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testAnchorStoresAndVerifiesProof() external {
        TrustTraceRegistry registry = new TrustTraceRegistry();
        bytes32 traceHash = keccak256("event-proof");

        registry.anchor(traceHash);

        require(registry.isAnchored(traceHash), "hash not anchored");
        (bool exists, uint256 timestamp, uint256 blockNumber, address submitter) = registry.getAnchor(traceHash);
        require(exists, "anchor missing");
        require(timestamp == block.timestamp, "wrong timestamp");
        require(blockNumber == block.number, "wrong block");
        require(submitter == address(this), "wrong submitter");
    }

    function testEmitsAnchorEvent() external {
        TrustTraceRegistry registry = new TrustTraceRegistry();
        bytes32 traceHash = keccak256("event-log-proof");

        vm.recordLogs();
        registry.anchor(traceHash);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        require(logs.length == 1, "expected one anchor event");
        require(logs[0].emitter == address(registry), "wrong event emitter");
        require(logs[0].topics[0] == keccak256("HashAnchored(bytes32,uint256,uint256,address)"), "wrong event signature");
        require(logs[0].topics[1] == traceHash, "wrong event hash");
    }

    function testRejectsEmptyAndDuplicateHashes() external {
        TrustTraceRegistry registry = new TrustTraceRegistry();
        (bool emptySuccess,) = address(registry).call(abi.encodeCall(registry.anchor, (bytes32(0))));
        require(!emptySuccess, "empty hash accepted");

        bytes32 traceHash = keccak256("unique-proof");
        registry.anchor(traceHash);
        (bool duplicateSuccess,) = address(registry).call(abi.encodeCall(registry.anchor, (traceHash)));
        require(!duplicateSuccess, "duplicate hash accepted");
        require(registry.isAnchored(traceHash), "original anchor changed");
    }

    function testDifferentHashesAreIndependent() external {
        TrustTraceRegistry registry = new TrustTraceRegistry();
        bytes32 firstHash = keccak256("first-proof");
        bytes32 secondHash = keccak256("second-proof");

        registry.anchor(firstHash);
        registry.anchor(secondHash);

        require(registry.isAnchored(firstHash), "first hash missing");
        require(registry.isAnchored(secondHash), "second hash missing");
        require(registry.anchorSubmitter(firstHash) == address(this), "first submitter changed");
        require(registry.anchorSubmitter(secondHash) == address(this), "second submitter changed");
    }
}