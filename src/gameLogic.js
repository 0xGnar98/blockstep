import { encodePacked, keccak256, stringToHex } from "viem";

export const GRID_SIZE = 5;
export const TOTAL_BEATS = 36;
export const MAX_LIVES = 3;
export const ECHO_DELAY = 4;

const MOVES = {
  up: [0, -1],
  down: [0, 1],
  left: [-1, 0],
  right: [1, 0],
  stay: [0, 0],
};

export function normalizeBlockHash(blockHash) {
  if (/^0x[0-9a-fA-F]{64}$/.test(blockHash)) return blockHash.toLowerCase();
  return keccak256(stringToHex(String(blockHash)));
}

export function deriveChallengeEntropy(blockNumber, blockHash, domain, index) {
  const packed = encodePacked(
    ["uint32", "bytes32", "uint8", "uint8"],
    [blockNumber, normalizeBlockHash(blockHash), domain, index],
  );
  return BigInt(keccak256(packed));
}

function cellKey(x, y) {
  return `${x},${y}`;
}

function inBounds(x, y) {
  return x >= 0 && x < GRID_SIZE && y >= 0 && y < GRID_SIZE;
}

export function createChallenge(blockNumber, blockHash) {
  const normalizedHash = normalizeBlockHash(blockHash);
  const pulseBeats = [9, 12, 15, 18, 21, 24, 27, 30, 33, 34, 35, 36];
  const pulses = pulseBeats.map((beat, index) => {
    const entropy = deriveChallengeEntropy(blockNumber, normalizedHash, 1, index);
    return {
      beat,
      axis: entropy % 2n === 0n ? "row" : "column",
      index: Number((entropy >> 8n) % BigInt(GRID_SIZE)),
      id: `pulse-${index}`,
    };
  });

  const shardBeats = [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35];
  const shards = shardBeats.map((spawnBeat, index) => {
    const entropy = deriveChallengeEntropy(blockNumber, normalizedHash, 2, index);
    return {
      id: `shard-${index}`,
      spawnBeat,
      expiresBeat: Math.min(TOTAL_BEATS, spawnBeat + 6),
      x: Number(entropy % BigInt(GRID_SIZE)),
      y: Number((entropy >> 8n) % BigInt(GRID_SIZE)),
    };
  });

  const chargedEntropy = deriveChallengeEntropy(blockNumber, normalizedHash, 3, 0);

  return {
    blockNumber,
    blockHash: normalizedHash,
    pulses,
    shards,
    chargedOffset: 1 + Number(chargedEntropy % 6n),
  };
}

export function createInitialState(challenge) {
  return {
    status: "ready",
    challenge,
    beat: 0,
    player: { x: 2, y: 3 },
    previousPlayer: { x: 2, y: 3 },
    lives: MAX_LIVES,
    score: 0,
    hits: 0,
    shardsCollected: [],
    echoes: [],
    flipAvailable: true,
    lastAction: "stay",
    lastHazards: [],
    lastEvent: "ready",
    fullClear: false,
  };
}

export function getPulseForBeat(challenge, beat) {
  return challenge.pulses.find((pulse) => pulse.beat === beat) ?? null;
}

export function getVisibleShards(state, beat = state.beat + 1) {
  const collected = new Set(state.shardsCollected);
  return state.challenge.shards.filter(
    (shard) =>
      !collected.has(shard.id) &&
      shard.spawnBeat <= beat &&
      shard.expiresBeat >= beat,
  );
}

export function getHazardCells(state, beat) {
  const hazards = new Map();
  const addHazard = (x, y, source) => {
    if (!inBounds(x, y)) return;
    const key = cellKey(x, y);
    const current = hazards.get(key) ?? { x, y, sources: [] };
    current.sources.push(source);
    hazards.set(key, current);
  };

  state.echoes
    .filter((echo) => echo.detonateBeat === beat)
    .forEach((echo) => {
      addHazard(echo.x, echo.y, "echo");
      if (echo.charged) {
        addHazard(echo.x + 1, echo.y, "charged-echo");
        addHazard(echo.x - 1, echo.y, "charged-echo");
        addHazard(echo.x, echo.y + 1, "charged-echo");
        addHazard(echo.x, echo.y - 1, "charged-echo");
      }
    });

  const pulse = getPulseForBeat(state.challenge, beat);
  if (pulse) {
    for (let index = 0; index < GRID_SIZE; index += 1) {
      if (pulse.axis === "row") addHazard(index, pulse.index, "block-pulse");
      else addHazard(pulse.index, index, "block-pulse");
    }
  }

  return [...hazards.values()];
}

function isAdjacentToHazard(player, hazards) {
  return hazards.some(
    (hazard) => Math.abs(player.x - hazard.x) + Math.abs(player.y - hazard.y) === 1,
  );
}

export function stepGame(inputState, rawAction = "stay") {
  if (inputState.status !== "playing") return inputState;

  const state = {
    ...inputState,
    player: { ...inputState.player },
    previousPlayer: { ...inputState.player },
    shardsCollected: [...inputState.shardsCollected],
    echoes: inputState.echoes.map((echo) => ({ ...echo })),
    lastHazards: [],
  };

  const nextBeat = state.beat + 1;
  let action = rawAction in MOVES || rawAction === "flip" ? rawAction : "stay";

  if (action === "flip" && state.flipAvailable) {
    state.player.x = GRID_SIZE - 1 - state.player.x;
    state.player.y = GRID_SIZE - 1 - state.player.y;
    state.flipAvailable = false;
  } else {
    if (action === "flip") action = "stay";
    const [dx, dy] = MOVES[action];
    const targetX = state.player.x + dx;
    const targetY = state.player.y + dy;
    if (inBounds(targetX, targetY)) {
      state.player.x = targetX;
      state.player.y = targetY;
    }
  }

  const hazards = getHazardCells(state, nextBeat);
  const hit = hazards.some(
    (hazard) => hazard.x === state.player.x && hazard.y === state.player.y,
  );

  if (hit) {
    state.lives -= 1;
    state.hits += 1;
    state.lastEvent = "hit";
  } else {
    state.lastEvent = "safe";
    if (isAdjacentToHazard(state.player, hazards)) {
      state.score += 15;
      state.lastEvent = "close-call";
    }
  }

  if (state.lives > 0) state.score += 10;

  const visibleShards = getVisibleShards(state, nextBeat);
  const collectedShard = visibleShards.find(
    (shard) => shard.x === state.player.x && shard.y === state.player.y,
  );
  if (collectedShard) {
    state.shardsCollected.push(collectedShard.id);
    state.score += 40;
    state.lastEvent = hit ? "hit-and-shard" : "shard";
  }

  const charged = (nextBeat + state.challenge.chargedOffset) % 7 === 0;
  state.echoes = state.echoes
    .filter((echo) => echo.detonateBeat > nextBeat)
    .concat({
      id: `echo-${nextBeat}`,
      x: state.player.x,
      y: state.player.y,
      createdBeat: nextBeat,
      detonateBeat: nextBeat + ECHO_DELAY,
      charged,
    });

  state.lastHazards = hazards;
  state.beat = nextBeat;
  state.lastAction = action;

  if (state.lives <= 0) {
    state.status = "lost";
  } else if (nextBeat >= TOTAL_BEATS) {
    state.status = "won";
    state.fullClear = true;
    state.score += 200;
    if (state.hits === 0) state.score += 150;
    if (state.flipAvailable) state.score += 75;
  }

  return state;
}

export function getBeatDuration(beat) {
  if (beat <= 12) return 0.85;
  if (beat <= 24) return 0.75;
  return 0.65;
}

export function serializeMoves(moves) {
  const codes = { stay: 0, up: 1, right: 2, down: 3, left: 4, flip: 5 };
  return moves.reduce((value, move, index) => {
    return value | (BigInt(codes[move] ?? 0) << BigInt(index * 3));
  }, 0n);
}
