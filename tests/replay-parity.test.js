import assert from "node:assert/strict";
import test from "node:test";

import { encodePacked, keccak256 } from "viem";

import { createChallenge, serializeMoves } from "../src/gameLogic.js";
import { createPixelGameState, stepPixelGame } from "../src/pixelScoreRules.js";

const GRID_SIZE = 5;
const TOTAL_BEATS = 36;
const SCORE = Object.freeze({
  survival: 10,
  shard: 40,
  closeCall: 15,
  cleared: 200,
  clean: 150,
  flipReserve: 75,
  hitPenalty: 100,
});
const ACTION_CODES = Object.freeze({ stay: 0, up: 1, right: 2, down: 3, left: 4, flip: 5 });

const WIN_ROUTE = [
  "up", "up", "right", "stay", "stay", "stay", "right", "stay", "stay",
  "stay", "left", "down", "right", "stay", "stay", "stay", "left", "stay",
  "down", "up", "down", "stay", "left", "up", "right", "left", "stay",
  "right", "up", "down", "stay", "down", "left", "down", "up", "stay",
];
const ONE_HIT_ROUTE = [...WIN_ROUTE];
ONE_HIT_ROUTE[0] = "stay";
const TWO_HIT_ROUTE = [...ONE_HIT_ROUTE];
TWO_HIT_ROUTE[5] = "right";
const STAY_ROUTE = Array.from({ length: TOTAL_BEATS }, () => "stay");
const FLIP_ROUTE = [...WIN_ROUTE];
FLIP_ROUTE[0] = "flip";
const ZIGZAG_ROUTE = Array.from({ length: TOTAL_BEATS }, (_, index) => (
  ["up", "right", "down", "left", "stay"][index % 5]
));

const BLOCKS = [
  {
    number: 912845,
    hash: "0x00000000000000000000000000000000000000000000000000000000000dedcd",
  },
  {
    number: 912846,
    hash: "0x10000000000000000000000000000000000000000000000000000000000dedce",
  },
  {
    number: 1_000_000,
    hash: "0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
  },
];

function entropy(height, blockHash, domain, index) {
  return BigInt(keccak256(encodePacked(
    ["uint32", "bytes32", "uint8", "uint8"],
    [height, blockHash, domain, index],
  )));
}

function pulseOrdinal(beat) {
  if (beat >= 9 && beat <= 33 && (beat - 9) % 3 === 0) return (beat - 9) / 3;
  if (beat === 34) return 9;
  if (beat === 35) return 10;
  if (beat === 36) return 11;
  return null;
}

function isHazard({ height, blockHash, beat, cellX, cellY, history, chargedOffset }) {
  if (cellX < 0 || cellY < 0 || cellX >= GRID_SIZE || cellY >= GRID_SIZE) return false;

  if (beat > 4) {
    const sourceBeat = beat - 4;
    const echo = history[sourceBeat - 1];
    if (cellX === echo.x && cellY === echo.y) return true;
    const charged = (sourceBeat + chargedOffset) % 7 === 0;
    if (charged && Math.abs(cellX - echo.x) + Math.abs(cellY - echo.y) === 1) return true;
  }

  const ordinal = pulseOrdinal(beat);
  if (ordinal !== null) {
    const value = entropy(height, blockHash, 1, ordinal);
    const isRow = value % 2n === 0n;
    const index = Number((value >> 8n) % BigInt(GRID_SIZE));
    if (isRow && cellY === index) return true;
    if (!isRow && cellX === index) return true;
  }
  return false;
}

function replayLikeSolidity(height, blockHash, packedMoves) {
  const history = [];
  const collected = new Set();
  let x = 2;
  let y = 3;
  let lives = 3;
  let hits = 0;
  let shards = 0;
  let closeCalls = 0;
  let beatsSurvived = 0;
  let earned = 0;
  let flipUnused = true;
  const chargedOffset = 1 + Number(entropy(height, blockHash, 3, 0) % 6n);

  for (let beat = 1; beat <= TOTAL_BEATS; beat += 1) {
    const moveCode = Number((packedMoves >> BigInt((beat - 1) * 3)) & 7n);
    assert.ok(moveCode <= 5, `invalid packed move ${moveCode} at beat ${beat}`);

    if (moveCode === ACTION_CODES.flip && flipUnused) {
      x = GRID_SIZE - 1 - x;
      y = GRID_SIZE - 1 - y;
      flipUnused = false;
    } else if (moveCode !== ACTION_CODES.flip) {
      if (moveCode === ACTION_CODES.up && y > 0) y -= 1;
      else if (moveCode === ACTION_CODES.right && x + 1 < GRID_SIZE) x += 1;
      else if (moveCode === ACTION_CODES.down && y + 1 < GRID_SIZE) y += 1;
      else if (moveCode === ACTION_CODES.left && x > 0) x -= 1;
    }

    const hazardArgs = { height, blockHash, beat, history, chargedOffset };
    const hit = isHazard({ ...hazardArgs, cellX: x, cellY: y });
    if (hit) {
      lives -= 1;
      hits += 1;
    } else {
      const closeCall = [
        [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
      ].some(([cellX, cellY]) => isHazard({ ...hazardArgs, cellX, cellY }));
      if (closeCall) {
        earned += SCORE.closeCall;
        closeCalls += 1;
      }
    }

    if (lives > 0) earned += SCORE.survival;

    for (let shard = 0; shard < 12; shard += 1) {
      if (collected.has(shard)) continue;
      const spawnBeat = 2 + shard * 3;
      const expiresBeat = Math.min(TOTAL_BEATS, spawnBeat + 6);
      if (beat < spawnBeat || beat > expiresBeat) continue;
      const value = entropy(height, blockHash, 2, shard);
      const shardX = Number(value % BigInt(GRID_SIZE));
      const shardY = Number((value >> 8n) % BigInt(GRID_SIZE));
      if (x === shardX && y === shardY) {
        collected.add(shard);
        shards += 1;
        earned += SCORE.shard;
        break;
      }
    }

    history[beat - 1] = { x, y };
    beatsSurvived = beat;
    if (lives === 0) break;
  }

  const cleared = beatsSurvived === TOTAL_BEATS && lives > 0;
  if (cleared) {
    earned += SCORE.cleared;
    if (hits === 0) earned += SCORE.clean;
    if (flipUnused) earned += SCORE.flipReserve;
  }
  const score = Math.max(0, earned - hits * SCORE.hitPenalty);
  return { score, lives, hits, shards, closeCalls, beatsSurvived, flipUnused, cleared };
}

function replayInBrowserRules(height, blockHash, route) {
  let state = createPixelGameState(createChallenge(height, blockHash));
  state.status = "playing";
  for (const action of route) {
    state = stepPixelGame(state, action);
    if (state.status !== "playing") break;
  }
  return {
    score: state.score,
    lives: state.lives,
    hits: state.hits,
    shards: state.shardsCollected.length,
    closeCalls: state.closeCalls,
    beatsSurvived: state.beat,
    flipUnused: state.flipAvailable,
    cleared: state.status === "won",
  };
}

test("independent Solidity-style replay matches browser rules across blocks and packed routes", () => {
  const routes = [WIN_ROUTE, ONE_HIT_ROUTE, TWO_HIT_ROUTE, STAY_ROUTE, FLIP_ROUTE, ZIGZAG_ROUTE];
  let comparisons = 0;
  for (const block of BLOCKS) {
    for (const route of routes) {
      const packedMoves = serializeMoves(route);
      assert.equal(packedMoves, route.reduce(
        (packed, action, index) => packed | (BigInt(ACTION_CODES[action]) << BigInt(index * 3)),
        0n,
      ));
      assert.deepEqual(
        replayLikeSolidity(block.number, block.hash, packedMoves),
        replayInBrowserRules(block.number, block.hash, route),
        `parity drift for block ${block.number}`,
      );
      comparisons += 1;
    }
  }
  assert.equal(comparisons, 18);
});
