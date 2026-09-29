// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract TrustTraceRegistry {
    mapping(bytes32 => uint256) public anchoredAt;
    mapping(bytes32 => uint256) public anchoredBlock;
    mapping(bytes32 => address) public anchorSubmitter;

    event HashAnchored(bytes32 indexed eventHash, uint256 timestamp, uint256 blockNumber, address indexed submitter);

    error EmptyHash();
    error AlreadyAnchored(bytes32 eventHash);

    function anchor(bytes32 eventHash) external returns (uint256 timestamp) {
        if (eventHash == bytes32(0)) revert EmptyHash();
        if (anchoredAt[eventHash] != 0) revert AlreadyAnchored(eventHash);

        timestamp = block.timestamp;
        anchoredAt[eventHash] = timestamp;
        anchoredBlock[eventHash] = block.number;
        anchorSubmitter[eventHash] = msg.sender;
        emit HashAnchored(eventHash, timestamp, block.number, msg.sender);
    }

    function isAnchored(bytes32 eventHash) external view returns (bool) {
        return anchoredAt[eventHash] != 0;
    }

    function getAnchor(bytes32 eventHash) external view returns (bool exists, uint256 timestamp, uint256 blockNumber, address submitter) {
        timestamp = anchoredAt[eventHash];
        exists = timestamp != 0;
        if (exists) return (true, timestamp, anchoredBlock[eventHash], anchorSubmitter[eventHash]);
    }
}
