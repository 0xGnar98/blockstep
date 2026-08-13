import test from "node:test";
import assert from "node:assert/strict";
import {
  TOTAL_BEATS,
  createChallenge,
  createInitialState,
  deriveChallengeEntropy,
  getHazardCells,
  serializeMoves,
  stepGame,
} from "../src/gameLogic.js";

const TEST_BLOCK_HASH = "0x00000000000000000000000000000000000000000000000000000000000dedcd";
const challenge = createChallenge(912845, TEST_BLOCK_HASH);

function playingState(customChallenge = challenge) {
  const state = createInitialState(customChallenge);
  state.status = "playing";
  return state;
}

test("challenge generation is deterministic", () => {
  assert.deepEqual(
    createChallenge(912845, "0xblockstep-test"),
    createChallenge(912845, "0xblockstep-test"),
  );
});

test("challenge entropy has a stable Solidity-compatible reference vector", () => {
  assert.equal(
    deriveChallengeEntropy(912845, TEST_BLOCK_HASH, 1, 0).toString(16),
    "7ff125f5a4b10a041ed3c1993b16161319f43bd720cf3e52567f98b85df9063d",
  );
});

test("movement cannot leave the 5x5 board", () => {
  let state = playingState();
  state.player = { x: 0, y: 0 };
  state = stepGame(state, "left");
  assert.deepEqual(state.player, { x: 0, y: 0 });
  state = stepGame(state, "up");
  assert.deepEqual(state.player, { x: 0, y: 0 });
});

test("a footprint detonates exactly four beats later", () => {
  let state = playingState({ ...challenge, pulses: [], shards: [] });
  state = stepGame(state, "right");
  const footprint = state.echoes[0];
  assert.equal(footprint.createdBeat, 1);
  assert.equal(footprint.detonateBeat, 5);
  assert.equal(getHazardCells(state, 4).length, 0);
  assert.ok(getHazardCells(state, 5).some((cell) => cell.x === 3 && cell.y === 3));
});

test("Hemi Flip mirrors the player and can only be used once", () => {
  let state = playingState({ ...challenge, pulses: [], shards: [] });
  state.player = { x: 1, y: 0 };
  state = stepGame(state, "flip");
  assert.deepEqual(state.player, { x: 3, y: 4 });
  assert.equal(state.flipAvailable, false);
  state = stepGame(state, "flip");
  assert.deepEqual(state.player, { x: 3, y: 4 });
});

test("a surviving player receives a full-clear result after 36 beats", () => {
  const safeChallenge = { ...challenge, pulses: [], shards: [], chargedOffset: 1000 };
  let state = playingState(safeChallenge);
  const route = ["up", "up", "right", "right", "down", "down", "left", "left"];
  for (let index = 0; index < TOTAL_BEATS; index += 1) {
    state = stepGame(state, route[index % route.length]);
    if (state.status !== "playing") break;
  }
  assert.equal(state.beat, TOTAL_BEATS);
  assert.equal(state.status, "won");
  assert.equal(state.fullClear, true);
});

test("move sequences pack into three bits per beat", () => {
  assert.equal(serializeMoves(["stay", "up", "right"]), 136n);
});
