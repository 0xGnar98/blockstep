import { createInitialState, stepGame } from "./gameLogic.js";

export const SCORE_RULES_VERSION = "1.0.0";

export const PIXEL_SCORE_VALUES = Object.freeze({
  survivalPerBeat: 10,
  shard: 40,
  closeCall: 15,
  runCleared: 200,
  cleanRun: 150,
  flipReserve: 75,
  hitPenalty: 100,
});

export function createScoreBreakdown() {
  return {
    survival: 0,
    shards: 0,
    closeCalls: 0,
    runCleared: 0,
    cleanRun: 0,
    flipReserve: 0,
    hitPenalty: 0,
  };
}

export function calculatePixelScore(breakdown) {
  const earned =
    breakdown.survival
    + breakdown.shards
    + breakdown.closeCalls
    + breakdown.runCleared
    + breakdown.cleanRun
    + breakdown.flipReserve;
  return Math.max(0, earned - breakdown.hitPenalty);
}

export function createPixelGameState(challenge) {
  return {
    ...createInitialState(challenge),
    score: 0,
    closeCalls: 0,
    scoreBreakdown: createScoreBreakdown(),
    scoreRulesVersion: SCORE_RULES_VERSION,
  };
}

function isSafeCloseCall(state) {
  if (state.lastEvent.includes("hit")) return false;
  return state.lastHazards.some(
    (hazard) => Math.abs(state.player.x - hazard.x) + Math.abs(state.player.y - hazard.y) === 1,
  );
}

export function stepPixelGame(inputState, action = "stay") {
  if (inputState.status !== "playing") return inputState;

  const next = stepGame(inputState, action);
  const breakdown = {
    ...createScoreBreakdown(),
    ...inputState.scoreBreakdown,
  };
  const beatAdvanced = next.beat > inputState.beat;
  const newHits = Math.max(0, next.hits - inputState.hits);
  const newShards = Math.max(0, next.shardsCollected.length - inputState.shardsCollected.length);
  const closeCall = beatAdvanced && isSafeCloseCall(next);
  const newlyCleared = inputState.status !== "won" && next.status === "won";

  if (beatAdvanced && next.lives > 0) {
    breakdown.survival += PIXEL_SCORE_VALUES.survivalPerBeat;
  }
  breakdown.shards += newShards * PIXEL_SCORE_VALUES.shard;
  if (closeCall) breakdown.closeCalls += PIXEL_SCORE_VALUES.closeCall;
  breakdown.hitPenalty += newHits * PIXEL_SCORE_VALUES.hitPenalty;

  if (newlyCleared) {
    breakdown.runCleared += PIXEL_SCORE_VALUES.runCleared;
    if (next.hits === 0) breakdown.cleanRun += PIXEL_SCORE_VALUES.cleanRun;
    if (next.flipAvailable) breakdown.flipReserve += PIXEL_SCORE_VALUES.flipReserve;
  }

  return {
    ...next,
    closeCalls: (inputState.closeCalls ?? 0) + (closeCall ? 1 : 0),
    scoreBreakdown: breakdown,
    scoreRulesVersion: SCORE_RULES_VERSION,
    score: calculatePixelScore(breakdown),
  };
}
