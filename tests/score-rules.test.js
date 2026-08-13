import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { createChallenge } from "../src/gameLogic.js";
import {
  SCORE_RULES_VERSION,
  PIXEL_SCORE_VALUES,
  calculatePixelScore,
  createPixelGameState,
  createScoreBreakdown,
  stepPixelGame,
} from "../src/pixelScoreRules.js";

const BLOCK_NUMBER = 912845;
const BLOCK_HASH = "0x00000000000000000000000000000000000000000000000000000000000dedcd";
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

function playingState() {
  const state = createPixelGameState(createChallenge(BLOCK_NUMBER, BLOCK_HASH));
  state.status = "playing";
  return state;
}

test("component scoring formula applies the locked values and floors the net score at zero", () => {
  assert.equal(SCORE_RULES_VERSION, "1.0.0");
  assert.deepEqual(PIXEL_SCORE_VALUES, {
    survivalPerBeat: 10,
    shard: 40,
    closeCall: 15,
    runCleared: 200,
    cleanRun: 150,
    flipReserve: 75,
    hitPenalty: 100,
  });
  assert.equal(calculatePixelScore({
    survival: 360,
    shards: 320,
    closeCalls: 480,
    runCleared: 200,
    cleanRun: 150,
    flipReserve: 75,
    hitPenalty: 0,
  }), 1585);
  assert.equal(calculatePixelScore({
    ...createScoreBreakdown(),
    survival: 10,
    hitPenalty: 100,
  }), 0);
});

test("a safe beat awards at most one close call even beside multiple hazards", () => {
  const state = playingState();
  state.beat = 4;
  state.player = { x: 2, y: 2 };
  state.previousPlayer = { x: 2, y: 2 };
  state.echoes = [
    { id: "left", x: 1, y: 2, createdBeat: 1, detonateBeat: 5, charged: false },
    { id: "right", x: 3, y: 2, createdBeat: 1, detonateBeat: 5, charged: false },
  ];

  const next = stepPixelGame(state, "stay");
  assert.equal(next.status, "playing");
  assert.equal(next.closeCalls, 1);
  assert.equal(next.scoreBreakdown.closeCalls, 15);
  assert.equal(next.score, 25);
});

test("a hit applies -100 immediately, stays separate from earned points, and never shows a negative score", () => {
  const state = playingState();
  state.beat = 4;
  state.player = { x: 2, y: 2 };
  state.previousPlayer = { x: 2, y: 2 };
  state.echoes = [
    { id: "direct", x: 2, y: 2, createdBeat: 1, detonateBeat: 5, charged: false },
  ];

  const next = stepPixelGame(state, "stay");
  assert.equal(next.hits, 1);
  assert.equal(next.lives, 2);
  assert.equal(next.scoreBreakdown.survival, 10);
  assert.equal(next.scoreBreakdown.hitPenalty, 100);
  assert.equal(next.score, 0);
});

test("a hit and shard collected on the same beat remain separate score components", () => {
  const state = playingState();
  state.beat = 4;
  state.player = { x: 2, y: 2 };
  state.previousPlayer = { x: 2, y: 2 };
  state.echoes = [
    { id: "direct", x: 2, y: 2, createdBeat: 1, detonateBeat: 5, charged: false },
  ];
  state.challenge = {
    ...state.challenge,
    pulses: [],
    shards: [{ id: "test-shard", spawnBeat: 5, expiresBeat: 5, x: 2, y: 2 }],
  };

  const next = stepPixelGame(state, "stay");
  assert.equal(next.lastEvent, "hit-and-shard");
  assert.equal(next.scoreBreakdown.survival, 10);
  assert.equal(next.scoreBreakdown.shards, 40);
  assert.equal(next.scoreBreakdown.hitPenalty, 100);
  assert.equal(next.score, 0);
});

test("the third hit ends the run without survival or clear bonuses", () => {
  const state = playingState();
  state.beat = 4;
  state.lives = 1;
  state.hits = 2;
  state.player = { x: 2, y: 2 };
  state.previousPlayer = { x: 2, y: 2 };
  state.echoes = [
    { id: "fatal", x: 2, y: 2, createdBeat: 1, detonateBeat: 5, charged: false },
  ];

  const next = stepPixelGame(state, "stay");
  assert.equal(next.status, "lost");
  assert.equal(next.lives, 0);
  assert.equal(next.hits, 3);
  assert.equal(next.scoreBreakdown.survival, 0);
  assert.equal(next.scoreBreakdown.runCleared, 0);
  assert.equal(next.scoreBreakdown.hitPenalty, 100);
  assert.equal(next.score, 0);
});

test("the reference zero-hit route remains a 1585-point Run Cleared result", () => {
  let state = playingState();
  for (const action of WIN_ROUTE) state = stepPixelGame(state, action);

  assert.equal(state.status, "won");
  assert.equal(state.beat, 36);
  assert.equal(state.hits, 0);
  assert.equal(state.shardsCollected.length, 8);
  assert.equal(state.closeCalls, 32);
  assert.deepEqual(state.scoreBreakdown, {
    survival: 360,
    shards: 320,
    closeCalls: 480,
    runCleared: 200,
    cleanRun: 150,
    flipReserve: 75,
    hitPenalty: 0,
  });
  assert.equal(state.score, 1585);
});

test("one-hit and two-hit cleared routes apply exact penalties without invalidating the clear", () => {
  let oneHitState = playingState();
  for (const action of ONE_HIT_ROUTE) oneHitState = stepPixelGame(oneHitState, action);
  assert.equal(oneHitState.status, "won");
  assert.equal(oneHitState.hits, 1);
  assert.deepEqual(oneHitState.scoreBreakdown, {
    survival: 360,
    shards: 120,
    closeCalls: 465,
    runCleared: 200,
    cleanRun: 0,
    flipReserve: 75,
    hitPenalty: 100,
  });
  assert.equal(oneHitState.score, 1120);

  let twoHitState = playingState();
  for (const action of TWO_HIT_ROUTE) twoHitState = stepPixelGame(twoHitState, action);
  assert.equal(twoHitState.status, "won");
  assert.equal(twoHitState.hits, 2);
  assert.deepEqual(twoHitState.scoreBreakdown, {
    survival: 360,
    shards: 120,
    closeCalls: 435,
    runCleared: 200,
    cleanRun: 0,
    flipReserve: 75,
    hitPenalty: 200,
  });
  assert.equal(twoHitState.score, 990);
});

test("using Hemi Flip on a cleared run removes only the Flip Reserve component", () => {
  const state = playingState();
  state.beat = 35;
  state.scoreBreakdown.survival = 350;
  state.score = 350;
  state.challenge = { ...state.challenge, pulses: [], shards: [] };
  state.echoes = [];

  const next = stepPixelGame(state, "flip");
  assert.equal(next.status, "won");
  assert.equal(next.flipAvailable, false);
  assert.equal(next.scoreBreakdown.survival, 360);
  assert.equal(next.scoreBreakdown.runCleared, 200);
  assert.equal(next.scoreBreakdown.cleanRun, 150);
  assert.equal(next.scoreBreakdown.flipReserve, 0);
  assert.equal(next.score, 710);
});

test("the Solidity replay exposes the same locked score constants", () => {
  const source = fs.readFileSync(new URL("../contracts/BlockstepScores.sol", import.meta.url), "utf8");
  const constantNames = {
    SURVIVAL_POINTS: 10,
    SHARD_POINTS: 40,
    CLOSE_CALL_POINTS: 15,
    RUN_CLEARED_POINTS: 200,
    CLEAN_RUN_POINTS: 150,
    FLIP_RESERVE_POINTS: 75,
    HIT_PENALTY: 100,
  };
  for (const [name, value] of Object.entries(constantNames)) {
    assert.match(source, new RegExp(`uint32 public constant ${name} = ${value};`));
  }
  assert.match(source, /earnedScore > hitPenalty \? earnedScore - hitPenalty : 0/);
});
