// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Local contract-security fixture only. The runtime code is placed at Hemi's fixed
/// BitcoinKit address so BlockstepScores exercises the real external-call shape.
contract MockBitcoinKit {
    struct BitcoinHeader {
        uint32 height;
        bytes32 blockHash;
        uint32 version;
        bytes32 previousBlockHash;
        bytes32 merkleRoot;
        uint32 timestamp;
        uint32 bits;
        uint32 nonce;
    }

    mapping(uint32 height => BitcoinHeader header) private headers;
    uint32 private latestHeight;

    function setHeader(uint32 height, bytes32 blockHash) external {
        headers[height] = BitcoinHeader({
            height: height,
            blockHash: blockHash,
            version: 1,
            previousBlockHash: bytes32(uint256(height) - 1),
            merkleRoot: keccak256(abi.encodePacked(height, blockHash)),
            timestamp: 1_700_000_000 + height,
            bits: 0x1d00ffff,
            nonce: height ^ 0xa5a5a5a5
        });
    }

    function clearHeader(uint32 height) external {
        delete headers[height];
    }

    function setLastHeader(uint32 height, bytes32 blockHash) external {
        headers[height] = BitcoinHeader({
            height: height,
            blockHash: blockHash,
            version: 1,
            previousBlockHash: bytes32(uint256(height) - 1),
            merkleRoot: keccak256(abi.encodePacked(height, blockHash)),
            timestamp: 1_700_000_000 + height,
            bits: 0x1d00ffff,
            nonce: height ^ 0xa5a5a5a5
        });
        latestHeight = height;
    }

    function getHeaderN(uint32 height) external view returns (BitcoinHeader memory) {
        return headers[height];
    }

    function getLastHeader() external view returns (BitcoinHeader memory) {
        return headers[latestHeight];
    }
}
