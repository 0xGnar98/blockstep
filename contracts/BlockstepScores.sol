// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IBitcoinKit {
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

    function getHeaderN(uint32 height) external view returns (BitcoinHeader memory);
    function getLastHeader() external view returns (BitcoinHeader memory);
}

/// @title BLOCKSTEP verified score registry
/// @notice Replays all 36 moves against a challenge derived from a Bitcoin header
///         stored by Hemi's BitcoinKit. The caller never supplies the score.
contract BlockstepScores {
    uint8 public constant TOTAL_BEATS = 36;
    uint8 public constant GRID_SIZE = 5;
    uint8 public constant PACKED_MOVE_BITS = 108;
    uint8 public constant SUBMISSION_HEIGHT_WINDOW = 6;
    uint32 public constant SURVIVAL_POINTS = 10;
    uint32 public constant SHARD_POINTS = 40;
    uint32 public constant CLOSE_CALL_POINTS = 15;
    uint32 public constant RUN_CLEARED_POINTS = 200;
    uint32 public constant CLEAN_RUN_POINTS = 150;
    uint32 public constant FLIP_RESERVE_POINTS = 75;
    uint32 public constant HIT_PENALTY = 100;
    address public constant BITCOIN_KIT = 0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12;
    bytes32 public constant RUN_TYPEHASH = keccak256(
        "Run(address player,uint32 bitcoinHeight,uint128 packedMoves,uint256 deadline)"
    );
    bytes32 public immutable DOMAIN_SEPARATOR;
    uint256 private constant SECP256K1_HALF_ORDER =
        0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    struct RunResult {
        uint32 score;
        uint8 lives;
        uint8 hits;
        uint8 shards;
        uint8 closeCalls;
        uint8 beatsSurvived;
        bool flipUnused;
        bool cleared;
    }

    struct BestRun {
        uint32 score;
        uint32 bitcoinHeight;
        uint128 packedMoves;
        uint8 lives;
        uint8 hits;
        uint8 shards;
        uint8 closeCalls;
        bool flipUnused;
    }

    mapping(address player => BestRun run) public bestRunByPlayer;
    mapping(bytes32 proofId => bool used) public proofUsed;
    uint256 public totalVerifiedRuns;

    event RunVerified(
        address indexed player,
        uint32 indexed bitcoinHeight,
        bytes32 indexed bitcoinBlockHash,
        uint32 score,
        uint128 packedMoves,
        uint8 lives,
        uint8 hits,
        uint8 shards,
        uint8 closeCalls,
        bool flipUnused
    );

    error BitcoinHeaderUnavailable(uint32 height);
    error InvalidMove(uint8 beat, uint8 moveCode);
    error NonCanonicalMoves(uint128 packedMoves);
    error StaleBitcoinHeader(uint32 submittedHeight, uint32 latestHeight);
    error RunNotCleared(uint8 beatsSurvived);
    error ProofAlreadyUsed(bytes32 proofId);
    error SignatureExpired(uint256 deadline);
    error InvalidSignature();

    constructor() {
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("BLOCKSTEP Scores"),
                keccak256("1"),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice Replays a run without saving it.
    function verifyRun(uint32 bitcoinHeight, uint128 packedMoves)
        public
        view
        returns (RunResult memory result, bytes32 bitcoinBlockHash)
    {
        _requireCanonicalMoves(packedMoves);
        IBitcoinKit.BitcoinHeader memory header = IBitcoinKit(BITCOIN_KIT).getHeaderN(bitcoinHeight);
        if (header.height != bitcoinHeight || header.blockHash == bytes32(0)) {
            revert BitcoinHeaderUnavailable(bitcoinHeight);
        }

        return (_replay(bitcoinHeight, header.blockHash, packedMoves), header.blockHash);
    }

    /// @notice Verifies a full clear and records the caller's best score.
    function submitRun(uint32 bitcoinHeight, uint128 packedMoves) external returns (uint32 score) {
        return _submitRun(msg.sender, bitcoinHeight, packedMoves);
    }

    /// @notice Lets a funded relayer submit a run after the player signs it for free.
    function submitRunFor(
        address player,
        uint32 bitcoinHeight,
        uint128 packedMoves,
        uint256 deadline,
        bytes calldata signature
    ) external returns (uint32 score) {
        if (block.timestamp > deadline) revert SignatureExpired(deadline);
        bytes32 structHash = keccak256(
            abi.encode(RUN_TYPEHASH, player, bitcoinHeight, packedMoves, deadline)
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
        if (_recover(digest, signature) != player) revert InvalidSignature();
        return _submitRun(player, bitcoinHeight, packedMoves);
    }

    function _submitRun(address player, uint32 bitcoinHeight, uint128 packedMoves)
        internal
        returns (uint32 score)
    {
        _requireCanonicalMoves(packedMoves);

        IBitcoinKit.BitcoinHeader memory latestHeader = IBitcoinKit(BITCOIN_KIT).getLastHeader();
        if (latestHeader.blockHash == bytes32(0)) {
            revert BitcoinHeaderUnavailable(latestHeader.height);
        }
        if (
            bitcoinHeight > latestHeader.height
                || latestHeader.height - bitcoinHeight >= SUBMISSION_HEIGHT_WINDOW
        ) {
            revert StaleBitcoinHeader(bitcoinHeight, latestHeader.height);
        }

        bytes32 proofId = keccak256(abi.encodePacked(player, bitcoinHeight, packedMoves));
        if (proofUsed[proofId]) revert ProofAlreadyUsed(proofId);

        (RunResult memory result, bytes32 blockHash) = verifyRun(bitcoinHeight, packedMoves);
        if (!result.cleared) revert RunNotCleared(result.beatsSurvived);
        proofUsed[proofId] = true;

        BestRun storage currentBest = bestRunByPlayer[player];
        if (result.score > currentBest.score) {
            currentBest.score = result.score;
            currentBest.bitcoinHeight = bitcoinHeight;
            currentBest.packedMoves = packedMoves;
            currentBest.lives = result.lives;
            currentBest.hits = result.hits;
            currentBest.shards = result.shards;
            currentBest.closeCalls = result.closeCalls;
            currentBest.flipUnused = result.flipUnused;
        }

        unchecked {
            totalVerifiedRuns += 1;
        }

        emit RunVerified(
            player,
            bitcoinHeight,
            blockHash,
            result.score,
            packedMoves,
            result.lives,
            result.hits,
            result.shards,
            result.closeCalls,
            result.flipUnused
        );
        return result.score;
    }

    function _requireCanonicalMoves(uint128 packedMoves) internal pure {
        if (packedMoves >> PACKED_MOVE_BITS != 0) revert NonCanonicalMoves(packedMoves);
    }

    function _recover(bytes32 digest, bytes calldata signature) internal pure returns (address signer) {
        if (signature.length != 65) revert InvalidSignature();
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1_HALF_ORDER || (v != 27 && v != 28)) revert InvalidSignature();
        signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert InvalidSignature();
    }

    function _replay(uint32 height, bytes32 blockHash, uint128 packedMoves)
        internal
        pure
        returns (RunResult memory result)
    {
        uint8[36] memory historyX;
        uint8[36] memory historyY;
        uint16 collectedShards;
        uint8 x = 2;
        uint8 y = 3;
        uint8 lives = 3;
        uint8 hits;
        uint8 shardCount;
        uint8 closeCallCount;
        uint32 earnedScore;
        bool flipAvailable = true;
        uint8 chargedOffset = 1 + uint8(_entropy(height, blockHash, 3, 0) % 6);

        for (uint8 beat = 1; beat <= TOTAL_BEATS; beat++) {
            uint8 moveCode = uint8((packedMoves >> ((beat - 1) * 3)) & 7);
            if (moveCode > 5) revert InvalidMove(beat, moveCode);

            if (moveCode == 5 && flipAvailable) {
                x = GRID_SIZE - 1 - x;
                y = GRID_SIZE - 1 - y;
                flipAvailable = false;
            } else if (moveCode != 5) {
                (x, y) = _move(x, y, moveCode);
            }

            bool hit = _isHazard(height, blockHash, beat, x, y, historyX, historyY, chargedOffset);
            if (hit) {
                lives -= 1;
                hits += 1;
            } else if (_isCloseCall(height, blockHash, beat, x, y, historyX, historyY, chargedOffset)) {
                earnedScore += CLOSE_CALL_POINTS;
                closeCallCount += 1;
            }

            if (lives > 0) earnedScore += SURVIVAL_POINTS;

            for (uint8 shard = 0; shard < 12; shard++) {
                uint16 shardBit = uint16(1) << shard;
                if ((collectedShards & shardBit) != 0) continue;

                uint8 spawnBeat = 2 + shard * 3;
                uint8 expiresBeat = spawnBeat + 6 > TOTAL_BEATS ? TOTAL_BEATS : spawnBeat + 6;
                if (beat < spawnBeat || beat > expiresBeat) continue;

                uint256 shardEntropy = _entropy(height, blockHash, 2, shard);
                uint8 shardX = uint8(shardEntropy % GRID_SIZE);
                uint8 shardY = uint8((shardEntropy >> 8) % GRID_SIZE);
                if (x == shardX && y == shardY) {
                    collectedShards |= shardBit;
                    shardCount += 1;
                    earnedScore += SHARD_POINTS;
                    break;
                }
            }

            historyX[beat - 1] = x;
            historyY[beat - 1] = y;
            result.beatsSurvived = beat;
            if (lives == 0) break;
        }

        bool cleared = result.beatsSurvived == TOTAL_BEATS && lives > 0;
        if (cleared) {
            earnedScore += RUN_CLEARED_POINTS;
            if (hits == 0) earnedScore += CLEAN_RUN_POINTS;
            if (flipAvailable) earnedScore += FLIP_RESERVE_POINTS;
        }

        uint32 hitPenalty = uint32(hits) * HIT_PENALTY;
        result.score = earnedScore > hitPenalty ? earnedScore - hitPenalty : 0;
        result.lives = lives;
        result.hits = hits;
        result.shards = shardCount;
        result.closeCalls = closeCallCount;
        result.flipUnused = flipAvailable;
        result.cleared = cleared;
    }

    function _move(uint8 x, uint8 y, uint8 moveCode) internal pure returns (uint8, uint8) {
        // 0 stay, 1 up, 2 right, 3 down, 4 left, 5 Hemi Flip.
        if (moveCode == 1 && y > 0) y -= 1;
        else if (moveCode == 2 && x + 1 < GRID_SIZE) x += 1;
        else if (moveCode == 3 && y + 1 < GRID_SIZE) y += 1;
        else if (moveCode == 4 && x > 0) x -= 1;
        return (x, y);
    }

    function _isCloseCall(
        uint32 height,
        bytes32 blockHash,
        uint8 beat,
        uint8 x,
        uint8 y,
        uint8[36] memory historyX,
        uint8[36] memory historyY,
        uint8 chargedOffset
    ) internal pure returns (bool) {
        return
            _isHazard(height, blockHash, beat, int8(uint8(x)) - 1, int8(uint8(y)), historyX, historyY, chargedOffset)
            || _isHazard(height, blockHash, beat, int8(uint8(x)) + 1, int8(uint8(y)), historyX, historyY, chargedOffset)
            || _isHazard(height, blockHash, beat, int8(uint8(x)), int8(uint8(y)) - 1, historyX, historyY, chargedOffset)
            || _isHazard(height, blockHash, beat, int8(uint8(x)), int8(uint8(y)) + 1, historyX, historyY, chargedOffset);
    }

    function _isHazard(
        uint32 height,
        bytes32 blockHash,
        uint8 beat,
        uint8 cellX,
        uint8 cellY,
        uint8[36] memory historyX,
        uint8[36] memory historyY,
        uint8 chargedOffset
    ) internal pure returns (bool) {
        return _isHazard(
            height,
            blockHash,
            beat,
            int8(cellX),
            int8(cellY),
            historyX,
            historyY,
            chargedOffset
        );
    }

    function _isHazard(
        uint32 height,
        bytes32 blockHash,
        uint8 beat,
        int8 cellX,
        int8 cellY,
        uint8[36] memory historyX,
        uint8[36] memory historyY,
        uint8 chargedOffset
    ) internal pure returns (bool) {
        if (cellX < 0 || cellY < 0 || cellX >= int8(GRID_SIZE) || cellY >= int8(GRID_SIZE)) return false;

        if (beat > 4) {
            uint8 sourceBeat = beat - 4;
            int8 echoX = int8(historyX[sourceBeat - 1]);
            int8 echoY = int8(historyY[sourceBeat - 1]);
            if (cellX == echoX && cellY == echoY) return true;

            bool charged = (sourceBeat + chargedOffset) % 7 == 0;
            if (charged && (uint8(_abs(cellX - echoX) + _abs(cellY - echoY)) == 1)) return true;
        }

        (bool hasPulse, uint8 pulseOrdinal) = _pulseOrdinal(beat);
        if (hasPulse) {
            uint256 pulseEntropy = _entropy(height, blockHash, 1, pulseOrdinal);
            bool isRow = pulseEntropy % 2 == 0;
            uint8 pulseIndex = uint8((pulseEntropy >> 8) % GRID_SIZE);
            if (isRow && uint8(cellY) == pulseIndex) return true;
            if (!isRow && uint8(cellX) == pulseIndex) return true;
        }

        return false;
    }

    function _pulseOrdinal(uint8 beat) internal pure returns (bool, uint8) {
        if (beat >= 9 && beat <= 33 && (beat - 9) % 3 == 0) return (true, (beat - 9) / 3);
        if (beat == 34) return (true, 9);
        if (beat == 35) return (true, 10);
        if (beat == 36) return (true, 11);
        return (false, 0);
    }

    function _entropy(uint32 height, bytes32 blockHash, uint8 domain, uint8 index)
        internal
        pure
        returns (uint256)
    {
        return uint256(keccak256(abi.encodePacked(height, blockHash, domain, index)));
    }

    function _abs(int8 value) internal pure returns (uint8) {
        return uint8(value < 0 ? -value : value);
    }
}
