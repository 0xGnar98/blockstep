import {
  ECHO_DELAY,
  GRID_SIZE,
  MAX_LIVES,
  TOTAL_BEATS,
  createChallenge,
  getBeatDuration,
  getHazardCells,
  getPulseForBeat,
  getVisibleShards,
  serializeMoves,
} from "./gameLogic.js";
import { loadLatestBitcoinContext } from "./hemi.js";
import { BLOCKSTEP_MAINNET } from "./blockstepConfig.js";
import { createPixelAudioSystem } from "./pixelAudio.js";
import {
  createRunVerifier,
  loadRelayedBitcoinContext,
} from "./runVerification.js";
import { buildRunTypedData } from "./scoreProof.js";
import {
  PIXEL_SCORE_VALUES,
  createPixelGameState,
  stepPixelGame,
} from "./pixelScoreRules.js";

const ART_WIDTH = 1680;
const ART_HEIGHT = 945;
const MOVE_DURATION_MS = 180;
const HIT_DURATION_MS = 450;
const IMPACT_DURATION_MS = 260;
const FLIP_DURATION_MS = 420;
const COUNTDOWN_DURATION_MS = 2400;
const GUIDANCE_DURATION_MS = 900;

const COLORS = Object.freeze({
  black: "#000000",
  nearBlack: "#07090a",
  white: "#f5f3f2",
  gray: "#777b7e",
  darkGray: "#343739",
  orange: "#ff4600",
  orangeLight: "#ffb090",
  impact: "#ffd5c4",
});

const DEFAULT_BLOCK = Object.freeze({
  number: 912845,
  hash: "0x00000000000000000000000000000000000000000000000000000000000dedcd",
  source: "offline practice",
  network: "fallback",
  verificationEligible: false,
  header: null,
});

const LIFE_SLOT_ANCHORS = Object.freeze([
  Object.freeze({ x: 156, y: 88 }),
  Object.freeze({ x: 226, y: 88 }),
  Object.freeze({ x: 296, y: 88 }),
]);

const ASSET_ROOT = "/assets/";
const URLS = Object.freeze({
  metadata: `${ASSET_ROOT}blockstep-sprite-atlas.json`,
  atlas: `${ASSET_ROOT}blockstep-sprite-atlas.png`,
  board: `${ASSET_ROOT}blockstep-board.png`,
  boardManifest: `${ASSET_ROOT}blockstep-board.json`,
  beatMetadata: `${ASSET_ROOT}blockstep-beat-counter.json`,
  beatAtlas: `${ASSET_ROOT}blockstep-beat-counter.png`,
  deltaMetadata: `${ASSET_ROOT}blockstep-effects-atlas.json`,
  deltaAtlas: `${ASSET_ROOT}blockstep-effects-atlas.png`,
  fontMetadata: `${ASSET_ROOT}blockstep-font.json`,
});

const canvas = document.querySelector("#pixel-game-canvas");
const displayContext = canvas.getContext("2d", { alpha: false });
const context = displayContext;
const gameFrame = document.querySelector("#game-frame");
const gameGate = document.querySelector("#game-gate");
const gameStatus = document.querySelector("#game-status");
const glyphCache = new Map();
const baseFrameCache = new Map();
const deltaFrameCache = new Map();
const beatFrameCache = new Map();
const opacitySurfaceCache = new WeakMap();
const rotatedSurfaceCache = new WeakMap();

context.imageSmoothingEnabled = false;
displayContext.imageSmoothingEnabled = false;

const search = new URLSearchParams(window.location.search);
const scoreContractAddress = BLOCKSTEP_MAINNET.scoreContractAddress;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const audio = createPixelAudioSystem();

let blockContext = { ...DEFAULT_BLOCK };
let challenge = createChallenge(blockContext.number, blockContext.hash);

const game = {
  ready: false,
  networkReady: false,
  assets: null,
  assetHashes: null,
  mode: "ready",
  state: createPixelGameState(challenge),
  queuedAction: "stay",
  countdownMs: 0,
  countdownCue: null,
  beatElapsedMs: 0,
  animationTimeMs: 0,
  transitionAgeMs: Number.POSITIVE_INFINITY,
  hitAgeMs: Number.POSITIVE_INFINITY,
  flipAgeMs: Number.POSITIVE_INFINITY,
  resultAgeMs: 0,
  lastCollection: null,
  lastPulse: null,
  moveHistory: [],
  lastProof: null,
  panel: null,
  completedRuns: 0,
  guidanceEnabled: false,
  guidanceSeen: new Set(),
  guidanceQueue: [],
  guidance: null,
  scoreNotice: null,
  verification: {
    state: "idle",
    message: "Replay proof ready for optional Hemi verification.",
    player: null,
    transactionHash: null,
    score: null,
  },
  manualTime: reducedMotion || search.get("manual") === "1",
  lastRender: createLastRenderState(),
};

function createLastRenderState() {
  return {
    tileStates: {},
    tileInstanceCount: 0,
    pipPose: "idle",
    pipTravelProgress: 1,
    currentBeatLampState: "off",
    topBeatText: "1/36",
    lifeStates: ["active", "active", "active"],
    hemiFlipMode: "full_active",
    pulseStage: "idle",
    pulseAxis: null,
    pulseIndex: null,
    visibleShardCount: 0,
    resultFrame: null,
    cameraOffset: { x: 0, y: 0 },
  };
}

function setStatus(message) {
  gameStatus.textContent = message;
}

function updateVerification(next) {
  game.verification = {
    ...game.verification,
    ...next,
    transactionHash: next.txHash ?? next.transactionHash ?? game.verification.transactionHash,
  };
  if (next.message) setStatus(next.message);
  if (game.ready) render();
}

async function fetchBytes(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

async function sha256(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

async function imageFromBytes(bytes, mimeType = "image/png") {
  const objectUrl = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
  const image = new Image();
  image.src = objectUrl;
  try {
    await image.decode();
    const stableSurface = document.createElement("canvas");
    stableSurface.width = image.naturalWidth;
    stableSurface.height = image.naturalHeight;
    const stableContext = stableSurface.getContext("2d");
    stableContext.imageSmoothingEnabled = false;
    stableContext.drawImage(image, 0, 0);
    return stableSurface;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function requireContract(condition, message) {
  if (!condition) throw new Error(`BLOCKSTEP asset validation failed: ${message}`);
}

function validateAssetContract(parts) {
  const {
    metadata,
    atlasHash,
    boardHash,
    boardManifest,
    beatMetadata,
    beatHash,
    deltaMetadata,
    deltaHash,
    fontMetadata,
  } = parts;

  requireContract(metadata.meta.version === 1, "unexpected base metadata version");
  requireContract(metadata.meta.atlasSha256 === atlasHash, "base atlas SHA-256 mismatch");
  requireContract(metadata.meta.size.w === 2048 && metadata.meta.size.h === 2048, "base atlas size drifted");
  requireContract(metadata.validation.frameCount === 211, "base atlas frame count drifted");
  requireContract(Object.keys(metadata.frames).length === 211, "base frame table is incomplete");
  requireContract(Object.keys(metadata.tiles.cells).length === 25, "25-cell geometry is incomplete");
  requireContract(metadata.tiles.completeIndependentStateSprites === true, "tile states are no longer complete sprites");
  requireContract(metadata.tiles.runtimeDecalsRequired === false, "floating tile decals were reintroduced");
  requireContract(metadata.validation.overlapPairs.length === 0, "base atlas frames overlap");

  requireContract(boardManifest.output.sha256 === boardHash, "HUD-clean board SHA-256 mismatch");
  requireContract(boardManifest.hemiCorrection.changedPixelsOutsideRegion === 0, "Hemi-clean board changed outside its lock");
  requireContract(boardManifest.hudCorrection.changedPixelsOutsideRegion === 0, "HUD-clean board changed outside its lock");
  requireContract(beatMetadata.meta.sha256 === beatHash, "top Beat counter SHA-256 mismatch");
  requireContract(beatMetadata.meta.frameCount === TOTAL_BEATS, "top Beat counter is not 36 frames");

  requireContract(deltaMetadata.meta.version === 1, "unexpected pixel add-on version");
  requireContract(deltaMetadata.meta.sha256 === deltaHash, "pixel add-on SHA-256 mismatch");
  requireContract(deltaMetadata.meta.additiveOnly === true, "pixel add-on is not additive-only");
  requireContract(deltaMetadata.meta.baseAtlas.sha256 === atlasHash, "pixel add-on targets another base atlas");
  requireContract(deltaMetadata.meta.baseAtlas.changed === false, "pixel add-on metadata reports a changed base atlas");
  requireContract(deltaMetadata.validation.baseAtlasChanged === false, "pixel add-on validation reports base-atlas drift");
  requireContract(deltaMetadata.validation.frameCount === 25, "pixel add-on frame count drifted");
  requireContract(Object.keys(deltaMetadata.frames).length === 25, "pixel add-on frame table is incomplete");
  requireContract(deltaMetadata.validation.overlapPairs.length === 0, "pixel add-on frames overlap");
  requireContract(deltaMetadata.validation.sevenDigitBlockWidthPx <= deltaMetadata.validation.blockHousingSafeWidthPx,
    "seven-digit Bitcoin block text no longer fits its housing");
  requireContract(deltaMetadata.font.atlasFrame === "font/blockstep_5x7", "bitmap font atlas binding drifted");
  requireContract(deltaMetadata.font.name === fontMetadata.name, "embedded bitmap font identity drifted");
  requireContract(fontMetadata.glyphSize.w === 5 && fontMetadata.glyphSize.h === 7, "bitmap glyph geometry drifted");

  for (const stateName of ["active", "hit", "empty"]) {
    requireContract(Boolean(metadata.frames[`ui/life/${stateName}`]), `missing Life ${stateName}`);
  }
  for (const stateName of ["off", "charging_a", "charging_b", "flash", "locked"]) {
    requireContract(Boolean(metadata.frames[`ui/beat/${stateName}`]), `missing Beat Lamp ${stateName}`);
  }
  for (const resultName of ["result.clear", "result.defeat", "echo.place", "tile.break", "result.victoryFx"]) {
    requireContract(Boolean(deltaMetadata.runtimeMappings[resultName]), `missing pixel mapping ${resultName}`);
  }
}

function sourceWithOpacity(source, requestedAlpha) {
  const alphaByte = Math.max(0, Math.min(255, Math.round(requestedAlpha * 255)));
  if (alphaByte >= 255) return source;
  let variants = opacitySurfaceCache.get(source);
  if (!variants) {
    variants = new Map();
    opacitySurfaceCache.set(source, variants);
  }
  if (variants.has(alphaByte)) return variants.get(alphaByte);

  const surface = document.createElement("canvas");
  surface.width = source.width;
  surface.height = source.height;
  const surfaceContext = surface.getContext("2d");
  surfaceContext.imageSmoothingEnabled = false;
  const sourceContext = source.getContext("2d");
  const pixels = sourceContext.getImageData(0, 0, source.width, source.height);
  for (let index = 3; index < pixels.data.length; index += 4) {
    pixels.data[index] = Math.round((pixels.data[index] * alphaByte) / 255);
  }
  surfaceContext.putImageData(pixels, 0, 0);
  variants.set(alphaByte, surface);
  return surface;
}

function sourceRotatedByQuarterTurns(source, requestedTurns) {
  const turns = ((requestedTurns % 4) + 4) % 4;
  if (turns === 0) return source;
  let variants = rotatedSurfaceCache.get(source);
  if (!variants) {
    variants = new Map();
    rotatedSurfaceCache.set(source, variants);
  }
  if (variants.has(turns)) return variants.get(turns);

  const sourceContext = source.getContext("2d");
  const sourcePixels = sourceContext.getImageData(0, 0, source.width, source.height);
  const outputWidth = turns % 2 === 1 ? source.height : source.width;
  const outputHeight = turns % 2 === 1 ? source.width : source.height;
  const surface = document.createElement("canvas");
  surface.width = outputWidth;
  surface.height = outputHeight;
  const surfaceContext = surface.getContext("2d");
  const output = surfaceContext.createImageData(outputWidth, outputHeight);

  for (let sourceY = 0; sourceY < source.height; sourceY += 1) {
    for (let sourceX = 0; sourceX < source.width; sourceX += 1) {
      let targetX;
      let targetY;
      if (turns === 1) {
        targetX = source.height - 1 - sourceY;
        targetY = sourceX;
      } else if (turns === 2) {
        targetX = source.width - 1 - sourceX;
        targetY = source.height - 1 - sourceY;
      } else {
        targetX = sourceY;
        targetY = source.width - 1 - sourceX;
      }
      const sourceIndex = (sourceY * source.width + sourceX) * 4;
      const targetIndex = (targetY * outputWidth + targetX) * 4;
      output.data[targetIndex] = sourcePixels.data[sourceIndex];
      output.data[targetIndex + 1] = sourcePixels.data[sourceIndex + 1];
      output.data[targetIndex + 2] = sourcePixels.data[sourceIndex + 2];
      output.data[targetIndex + 3] = sourcePixels.data[sourceIndex + 3];
    }
  }
  surfaceContext.putImageData(output, 0, 0);
  variants.set(turns, surface);
  return surface;
}

function baseFrameSource(frameName) {
  if (baseFrameCache.has(frameName)) return baseFrameCache.get(frameName);
  const entry = game.assets.metadata.frames[frameName];
  if (!entry) throw new Error(`Unknown base atlas frame: ${frameName}`);
  const source = document.createElement("canvas");
  source.width = entry.sourceSize.w;
  source.height = entry.sourceSize.h;
  const sourceContext = source.getContext("2d");
  sourceContext.imageSmoothingEnabled = false;
  const packed = entry.frame;
  const placement = entry.spriteSourceSize;
  sourceContext.drawImage(
    game.assets.atlas,
    packed.x,
    packed.y,
    packed.w,
    packed.h,
    placement.x,
    placement.y,
    placement.w,
    placement.h,
  );
  baseFrameCache.set(frameName, source);
  return source;
}

function baseFrame(frameName, x, y, options = {}) {
  const source = sourceWithOpacity(baseFrameSource(frameName), options.alpha ?? 1);
  const target = options.targetContext ?? context;
  const width = options.width ?? source.width;
  const height = options.height ?? source.height;
  const previousAlpha = target.globalAlpha;
  target.globalAlpha = 1;
  target.drawImage(source, Math.round(x), Math.round(y), Math.round(width), Math.round(height));
  target.globalAlpha = previousAlpha;
}

function baseFrameAtPivot(frameName, anchorX, anchorY, options = {}) {
  const entry = game.assets.metadata.frames[frameName];
  const width = Math.round(options.width ?? entry.sourceSize.w * (options.scale ?? 1));
  const height = Math.round(options.height ?? entry.sourceSize.h * (options.scale ?? 1));
  const pivotX = Math.round(entry.pivotPixels.x * (width / entry.sourceSize.w));
  const pivotY = Math.round(entry.pivotPixels.y * (height / entry.sourceSize.h));
  baseFrame(frameName, anchorX - pivotX, anchorY - pivotY, { ...options, width, height });
}

function baseFrameRotatedAtPivot(frameName, anchorX, anchorY, quarterTurns, options = {}) {
  const entry = game.assets.metadata.frames[frameName];
  const turns = ((quarterTurns % 4) + 4) % 4;
  const source = sourceRotatedByQuarterTurns(
    sourceWithOpacity(baseFrameSource(frameName), options.alpha ?? 1),
    turns,
  );
  const width = Math.round(options.width ?? entry.sourceSize.w * (options.scale ?? 1));
  const height = Math.round(options.height ?? entry.sourceSize.h * (options.scale ?? 1));
  const outputWidth = turns % 2 === 1 ? height : width;
  const outputHeight = turns % 2 === 1 ? width : height;
  let rotatedPivotX = entry.pivotPixels.x;
  let rotatedPivotY = entry.pivotPixels.y;
  if (turns === 1) {
    rotatedPivotX = entry.sourceSize.h - entry.pivotPixels.y;
    rotatedPivotY = entry.pivotPixels.x;
  } else if (turns === 2) {
    rotatedPivotX = entry.sourceSize.w - entry.pivotPixels.x;
    rotatedPivotY = entry.sourceSize.h - entry.pivotPixels.y;
  } else if (turns === 3) {
    rotatedPivotX = entry.pivotPixels.y;
    rotatedPivotY = entry.sourceSize.w - entry.pivotPixels.x;
  }
  const pivotX = Math.round(rotatedPivotX * (outputWidth / source.width));
  const pivotY = Math.round(rotatedPivotY * (outputHeight / source.height));
  context.drawImage(
    source,
    Math.round(anchorX - pivotX),
    Math.round(anchorY - pivotY),
    outputWidth,
    outputHeight,
  );
}

function deltaFrameSource(frameName) {
  if (deltaFrameCache.has(frameName)) return deltaFrameCache.get(frameName);
  const entry = game.assets.deltaMetadata.frames[frameName];
  if (!entry) throw new Error(`Unknown pixel add-on frame: ${frameName}`);
  const source = document.createElement("canvas");
  source.width = entry.sourceSize.w;
  source.height = entry.sourceSize.h;
  const sourceContext = source.getContext("2d");
  sourceContext.imageSmoothingEnabled = false;
  const packed = entry.frame;
  sourceContext.drawImage(game.assets.deltaAtlas, packed.x, packed.y, packed.w, packed.h, 0, 0, source.width, source.height);
  deltaFrameCache.set(frameName, source);
  return source;
}

function deltaFrame(frameName, x, y, options = {}) {
  const entry = game.assets.deltaMetadata.frames[frameName];
  const source = sourceWithOpacity(deltaFrameSource(frameName), options.alpha ?? 1);
  const target = options.targetContext ?? context;
  const width = Math.round(options.width ?? entry.sourceSize.w * (options.scale ?? 1));
  const height = Math.round(options.height ?? entry.sourceSize.h * (options.scale ?? 1));
  const previousAlpha = target.globalAlpha;
  target.globalAlpha = 1;
  target.drawImage(source, Math.round(x), Math.round(y), width, height);
  target.globalAlpha = previousAlpha;
}

function deltaFrameCentered(frameName, centerX, centerY, options = {}) {
  const entry = game.assets.deltaMetadata.frames[frameName];
  const width = Math.round(options.width ?? entry.sourceSize.w * (options.scale ?? 1));
  const height = Math.round(options.height ?? entry.sourceSize.h * (options.scale ?? 1));
  deltaFrame(frameName, centerX - width / 2, centerY - height / 2, { ...options, width, height });
}

function getGlyphCanvas(character, color) {
  const key = `${character}:${color}`;
  if (glyphCache.has(key)) return glyphCache.get(key);
  const font = game.assets.fontMetadata;
  const glyph = font.glyphs[character] ?? font.glyphs["?"];
  const glyphCanvas = document.createElement("canvas");
  glyphCanvas.width = glyph.w;
  glyphCanvas.height = glyph.h;
  const glyphContext = glyphCanvas.getContext("2d");
  glyphContext.imageSmoothingEnabled = false;
  const fontFrame = deltaFrameSource(font.atlasFrame);
  glyphContext.drawImage(
    fontFrame,
    glyph.x,
    glyph.y,
    glyph.w,
    glyph.h,
    0,
    0,
    glyph.w,
    glyph.h,
  );
  glyphContext.globalCompositeOperation = "source-in";
  glyphContext.fillStyle = color;
  glyphContext.fillRect(0, 0, glyph.w, glyph.h);
  glyphCache.set(key, glyphCanvas);
  return glyphCanvas;
}

function measureBitmapText(text, scale) {
  const normalized = String(text).toUpperCase();
  if (!normalized.length) return 0;
  const font = game.assets.fontMetadata;
  return (normalized.length * font.advance - 1) * scale;
}

function bitmapText(text, x, y, options = {}) {
  const normalized = String(text).toUpperCase();
  const scale = options.scale ?? 2;
  const color = options.color ?? COLORS.white;
  const width = measureBitmapText(normalized, scale);
  let cursorX = x;
  if (options.align === "center") cursorX -= Math.round(width / 2);
  if (options.align === "right") cursorX -= width;
  const font = game.assets.fontMetadata;
  for (const rawCharacter of normalized) {
    const character = rawCharacter === " " ? "space" : rawCharacter;
    const glyph = font.glyphs[character] ?? font.glyphs["?"];
    if (character !== "space") {
      const glyphCanvas = getGlyphCanvas(character, color);
      context.drawImage(glyphCanvas, Math.round(cursorX), Math.round(y), glyph.w * scale, glyph.h * scale);
    }
    cursorX += glyph.advance * scale;
  }
  return width;
}

function clamp(value, minimum = 0, maximum = 1) {
  return Math.min(maximum, Math.max(minimum, value));
}

function lerp(start, end, progress) {
  return start + (end - start) * progress;
}

function lerpPoint(start, end, progress) {
  return { x: lerp(start.x, end.x, progress), y: lerp(start.y, end.y, progress) };
}

function easeOutCubic(value) {
  const inverse = 1 - value;
  return 1 - inverse * inverse * inverse;
}

function sampleKeyframes(keyframes, timeMs) {
  let index = 0;
  for (let frameOption = 1; frameOption < keyframes.length; frameOption += 1) {
    if (timeMs < keyframes[frameOption].timeMs) break;
    index = frameOption;
  }
  const current = keyframes[index];
  const next = keyframes[Math.min(index + 1, keyframes.length - 1)];
  const span = Math.max(1, next.timeMs - current.timeMs);
  const mix = current === next ? 0 : clamp((timeMs - current.timeMs) / span);
  return { current, next, mix };
}

function sequenceFrame(mappingName, elapsedMs) {
  const mapping = game.assets.deltaMetadata.runtimeMappings[mappingName];
  let index = 0;
  for (let frameOption = 1; frameOption < mapping.timesMs.length; frameOption += 1) {
    if (elapsedMs < mapping.timesMs[frameOption]) break;
    index = frameOption;
  }
  return mapping.frames[Math.min(index, mapping.frames.length - 1)];
}

function cellKey(x, y) {
  return `r${y + 1}c${x + 1}`;
}

function cellAnchorByKey(key) {
  const cell = game.assets.metadata.tiles.cells[key];
  const faceBottom = Math.max(...cell.facePolygon.map((point) => point[1]));
  return {
    x: cell.boardPosition.x + cell.faceCenter[0],
    y: cell.boardPosition.y + faceBottom - 4,
  };
}

function cellAnchor(x, y) {
  return cellAnchorByKey(cellKey(x, y));
}

function cellFaceGeometry(key) {
  const cell = game.assets.metadata.tiles.cells[key];
  const points = cell.facePolygon.map(([pointX, pointY]) => ({
    x: cell.boardPosition.x + pointX,
    y: cell.boardPosition.y + pointY,
  }));
  return {
    cell,
    points,
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

function traceCellFace(geometry) {
  context.beginPath();
  geometry.points.forEach((point, index) => {
    if (index === 0) context.moveTo(point.x, point.y);
    else context.lineTo(point.x, point.y);
  });
  context.closePath();
}

function drawPixelLine(start, end, color, width = 2, alpha = 1) {
  let x0 = Math.round(start.x);
  let y0 = Math.round(start.y);
  const x1 = Math.round(end.x);
  const y1 = Math.round(end.y);
  const deltaX = Math.abs(x1 - x0);
  const stepX = x0 < x1 ? 1 : -1;
  const deltaY = -Math.abs(y1 - y0);
  const stepY = y0 < y1 ? 1 : -1;
  let error = deltaX + deltaY;
  const previousAlpha = context.globalAlpha;
  context.globalAlpha = alpha;
  context.fillStyle = color;
  while (true) {
    context.fillRect(x0 - Math.floor(width / 2), y0 - Math.floor(width / 2), width, width);
    if (x0 === x1 && y0 === y1) break;
    const twiceError = error * 2;
    if (twiceError >= deltaY) {
      error += deltaY;
      x0 += stepX;
    }
    if (twiceError <= deltaX) {
      error += deltaX;
      y0 += stepY;
    }
  }
  context.globalAlpha = previousAlpha;
}

function drawSegmentedTransferLine(start, end, color, width = 3) {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const steps = Math.max(1, Math.floor(distance / 8));
  context.fillStyle = color;
  for (let index = 0; index <= steps; index += 1) {
    if (index % 3 === 2) continue;
    const progress = index / steps;
    const point = lerpPoint(start, end, progress);
    const size = index === 0 || index === steps ? width + 2 : width;
    context.fillRect(
      Math.round(point.x - size / 2),
      Math.round(point.y - size / 2),
      size,
      size,
    );
  }
}

function pipCoreAlias(pose) {
  const rig = game.assets.metadata.rigs.pip;
  const prefix = Object.keys(rig.coreByPosePrefix).find(
    (frameOption) => frameOption !== "default" && pose.startsWith(frameOption),
  );
  return rig.coreByPosePrefix[prefix ?? "default"];
}

function drawPipParts(targetContext, anchor, pose = "idle", alpha = 1) {
  const rig = game.assets.metadata.rigs.pip;
  const poseX = Math.round(anchor.x - rig.pivotPixels.x);
  const poseY = Math.round(anchor.y - rig.pivotPixels.y);
  const overrides = rig.poseOverrides[pose] ?? {};
  for (const part of rig.drawOrder) {
    const alias = part === "core" ? pipCoreAlias(pose) : part;
    const frameName = rig.frames[alias];
    const transform = overrides[part] ?? rig.defaultTransform;
    const [width, height] = transform.size;
    const [offsetX, offsetY] = transform.offset;
    const x = poseX + rig.poseOrigin.x + Math.floor((rig.sourcePartCanvas.w - width) / 2) + offsetX;
    const y = poseY + rig.poseOrigin.y + Math.floor((rig.sourcePartCanvas.h - height) / 2) + offsetY;
    baseFrame(frameName, x, y, { width, height, alpha, targetContext });
  }
  const effectAlias = rig.effectByPose[pose];
  if (effectAlias) baseFrame(rig.frames[effectAlias], poseX, poseY, { alpha, targetContext });
}

function drawPip(anchor, pose = "idle", alpha = 1) {
  drawPipParts(context, anchor, pose, alpha);
}

function drawHemiParts(anchor, stateName, transformSetName = null, alpha = 1) {
  const rig = game.assets.metadata.rigs.hemiFlip;
  const transforms = transformSetName ? rig[transformSetName] ?? {} : {};
  for (const part of rig.drawOrder) {
    const frameName = rig.frames[`${stateName}_${part}`];
    const transform = transforms[part];
    const offset = transform?.offset ?? [0, 0];
    const size = transform?.size ?? [rig.sourcePartCanvas.w, rig.sourcePartCanvas.h];
    const quarterTurns = transformSetName === "chargeTransforms" && part === "energy_ring"
      ? rig.chargeTransforms.energyRingQuarterTurns
      : 0;
    if (quarterTurns) {
      baseFrameRotatedAtPivot(frameName, anchor.x + offset[0], anchor.y + offset[1], quarterTurns, {
        width: size[0], height: size[1], alpha,
      });
    } else {
      baseFrameAtPivot(frameName, anchor.x + offset[0], anchor.y + offset[1], {
        width: size[0], height: size[1], alpha,
      });
    }
  }
}

function drawHemiFlip() {
  const anchor = game.assets.boardManifest.hemiCorrection.anchorPixels;
  let mode = game.state.flipAvailable ? "full_active" : "full_spent";
  if (game.flipAgeMs < FLIP_DURATION_MS) {
    const sample = sampleKeyframes(game.assets.metadata.animations.hemiFlip.keyframes, game.flipAgeMs);
    mode = sample.current.mode;
  }
  const binding = game.assets.metadata.rigs.hemiFlip.modeBindings[mode];
  if (binding.kind === "fullFrame") {
    baseFrameAtPivot(binding.frame, anchor.x, anchor.y);
  } else {
    drawHemiParts(anchor, binding.state, binding.transformSet);
    if (mode === "modular_charge") {
      baseFrameAtPivot(game.assets.metadata.rigs.hemiFlip.frames.charge_brackets, anchor.x, anchor.y);
    } else if (mode === "modular_release") {
      baseFrameAtPivot(game.assets.metadata.rigs.hemiFlip.frames.release, anchor.x, anchor.y);
    }
  }
  game.lastRender.hemiFlipMode = mode;
}

function drawLifeIcons() {
  const lifeStates = [];
  for (let index = 0; index < MAX_LIVES; index += 1) {
    let stateName = index < game.state.lives ? "active" : "empty";
    if (game.hitAgeMs < HIT_DURATION_MS && index === game.state.lives) {
      const sample = sampleKeyframes(game.assets.metadata.animations.pipHitLife.keyframes, game.hitAgeMs);
      stateName = sample.current.lifeFrame.split("/").at(-1);
    }
    baseFrameAtPivot(`ui/life/${stateName}`, LIFE_SLOT_ANCHORS[index].x, LIFE_SLOT_ANCHORS[index].y);
    lifeStates.push(stateName);
  }
  game.lastRender.lifeStates = lifeStates;
}

function drawTopBeatCounter() {
  const beat = Math.min(TOTAL_BEATS, Math.max(1, game.state.beat + (game.state.status === "won" ? 0 : 1)));
  const entry = game.assets.beatMetadata.frames[String(beat)];
  const anchor = game.assets.beatMetadata.meta.anchorPixels;
  let source = beatFrameCache.get(beat);
  if (!source) {
    source = document.createElement("canvas");
    source.width = entry.sourceSize.w;
    source.height = entry.sourceSize.h;
    const sourceContext = source.getContext("2d");
    sourceContext.imageSmoothingEnabled = false;
    const frame = entry.frame;
    sourceContext.drawImage(game.assets.beatAtlas, frame.x, frame.y, frame.w, frame.h, 0, 0, frame.w, frame.h);
    beatFrameCache.set(beat, source);
  }
  context.drawImage(source, anchor.x, anchor.y);
  game.lastRender.topBeatText = entry.displayText;
}

function beatLampFrame(localBeatMs) {
  const sample = sampleKeyframes(game.assets.metadata.animations.beatLamp.keyframes, localBeatMs);
  return sample.current.frame;
}

function drawBeatRail() {
  const currentIndex = Math.min(TOTAL_BEATS - 1, game.state.beat);
  const currentFrame = game.mode === "playing"
    ? beatLampFrame(Math.min(480, game.beatElapsedMs))
    : "ui/beat/off";
  for (let index = 0; index < TOTAL_BEATS; index += 1) {
    const centerX = Math.round(198 + (index * (1329 - 198)) / (TOTAL_BEATS - 1));
    let frameName = "ui/beat/off";
    if (index < game.state.beat) frameName = "ui/beat/locked";
    if (index === currentIndex && game.state.status === "playing") frameName = currentFrame;
    baseFrameAtPivot(frameName, centerX, 870);
  }
  game.lastRender.currentBeatLampState = currentFrame.split("/").at(-1);
}

function drawHudValues() {
  const score = String(game.state.score).padStart(4, "0").slice(-4);
  bitmapText(score, 461, 67, { scale: 3, color: COLORS.orange, align: "center" });
  bitmapText(`#${game.state.challenge.blockNumber}`, 1126, 70, {
    scale: 3,
    color: COLORS.orange,
    align: "center",
  });
}

function drawBlockPulsePanel() {
  const visual = pulseVisualState();
  if (!visual) return;
  const stage = pulseStageAt(visual.localMs);
  const progress = clamp(visual.localMs / 560);
  context.save();
  context.globalAlpha = 0.42 + progress * 0.48;
  context.strokeStyle = stage === "axis-hot" ? COLORS.impact : COLORS.orange;
  context.lineWidth = stage === "axis-hot" ? 3 : 2;
  context.strokeRect(1039, 21, 176, 82);
  context.fillStyle = stage === "axis-hot" ? COLORS.impact : COLORS.orange;
  const litSegments = Math.max(1, Math.ceil(progress * 7));
  for (let index = 0; index < litSegments; index += 1) {
    context.fillRect(1061 + index * 19, 94, 12, 3);
  }
  context.restore();
}

function drawBoardForeground() {
  const board = game.assets.board;
  const cuts = [
    [0, 120, ART_WIDTH, 30],
    [0, 704, ART_WIDTH, 96],
    [0, 150, 372, 554],
    [1301, 150, ART_WIDTH - 1301, 554],
  ];
  for (const [x, y, width, height] of cuts) {
    context.drawImage(board, x, y, width, height, x, y, width, height);
  }
}

function activeEchoByCell() {
  const echoes = new Map();
  for (const echo of game.state.echoes) {
    const remaining = echo.detonateBeat - game.state.beat;
    if (remaining < 1 || remaining > 4) continue;
    const key = cellKey(echo.x, echo.y);
    const current = echoes.get(key);
    if (!current || remaining < current.remaining) echoes.set(key, { ...echo, remaining });
  }
  return echoes;
}

function impactCells() {
  if (game.transitionAgeMs >= IMPACT_DURATION_MS) return new Set();
  return new Set(game.state.lastHazards.map((hazard) => cellKey(hazard.x, hazard.y)));
}

function drawChargedModifier(key, remaining) {
  const phase = (game.animationTimeMs % 320) / 320;
  const geometry = cellFaceGeometry(key);
  context.save();
  context.globalAlpha = 0.15 + (1 - remaining / 5) * 0.18;
  context.fillStyle = COLORS.orange;
  traceCellFace(geometry);
  context.fill();
  context.globalAlpha = 0.55;
  context.fillStyle = phase < 0.5 ? COLORS.orange : COLORS.orangeLight;
  const inset = 10 + Math.round(phase * 5);
  context.fillRect(
    geometry.minX + inset,
    geometry.minY + 7,
    Math.max(4, geometry.maxX - geometry.minX - inset * 2),
    2,
  );
  context.fillRect(
    geometry.minX + inset,
    geometry.maxY - 9,
    Math.max(4, geometry.maxX - geometry.minX - inset * 2),
    2,
  );
  context.restore();
}

function drawAllTiles() {
  const activeEchoes = activeEchoByCell();
  const impacts = impactCells();
  const showGameplayStates = game.mode !== "won" && game.mode !== "lost";
  const tileStates = {};
  const cells = Object.entries(game.assets.metadata.tiles.cells)
    .sort(([left], [right]) => left.localeCompare(right));
  for (const [key, cell] of cells) {
    let stateName = "neutral";
    if (showGameplayStates && impacts.has(key)) {
      stateName = game.transitionAgeMs < 130 ? "impact_flash" : "cracked";
    } else if (showGameplayStates && activeEchoes.has(key)) {
      stateName = `footprint_${activeEchoes.get(key).remaining}`;
    }
    baseFrame(cell.states[stateName], cell.boardPosition.x, cell.boardPosition.y);
    if (showGameplayStates && activeEchoes.get(key)?.charged) {
      drawChargedModifier(key, activeEchoes.get(key).remaining);
    }
    tileStates[key] = stateName;
  }
  game.lastRender.tileStates = tileStates;
  game.lastRender.tileInstanceCount = cells.length;
}

function pulseVisualState() {
  const nextBeat = Math.min(TOTAL_BEATS, game.state.beat + 1);
  const upcoming = game.state.status === "playing" ? getPulseForBeat(game.state.challenge, nextBeat) : null;
  if (upcoming && game.mode === "playing") {
    const durationMs = getBeatDuration(nextBeat) * 1000;
    const startAt = Math.max(0, durationMs - 560);
    const localMs = clamp(game.beatElapsedMs - startAt, 0, 560);
    return { pulse: upcoming, localMs, resolved: false };
  }
  if (game.lastPulse && game.transitionAgeMs < 260) {
    return { pulse: game.lastPulse, localMs: 420 + game.transitionAgeMs * 0.54, resolved: true };
  }
  return null;
}

function pulseStageAt(localMs) {
  if (localMs < 80) return "acknowledge";
  if (localMs < 160) return "travel";
  if (localMs < 280) return "axis-prime";
  if (localMs < 420) return "axis-hot";
  if (localMs < 560) return "settle";
  return "idle";
}

function drawBlockPulse() {
  const visual = pulseVisualState();
  if (!visual) return;
  const { pulse, localMs } = visual;
  const stage = pulseStageAt(localMs);
  const progress = clamp(localMs / 560);
  const panel = { x: 1126, y: 78 };
  const entryX = pulse.axis === "row" ? 1308 : 1230;
  const targetCell = pulse.axis === "row" ? cellAnchor(4, pulse.index) : cellAnchor(pulse.index, 0);
  const pathEnd = lerpPoint(panel, { x: entryX, y: targetCell.y }, easeOutCubic(clamp((localMs - 80) / 180)));

  context.save();
  context.strokeStyle = localMs > 360 ? COLORS.impact : COLORS.orange;
  context.lineWidth = localMs > 360 ? 3 : 2;
  context.globalAlpha = 0.35 + progress * 0.45;
  context.strokeRect(1039, 21, 176, 82);
  if (localMs >= 80) drawPixelLine(panel, pathEnd, COLORS.orange, localMs > 330 ? 3 : 2, 0.55 + progress * 0.35);

  if (localMs >= 160) {
    const reveal = clamp((localMs - 160) / 180);
    for (let index = 0; index < GRID_SIZE; index += 1) {
      const x = pulse.axis === "row" ? index : pulse.index;
      const y = pulse.axis === "row" ? pulse.index : index;
      const key = cellKey(x, y);
      const geometry = cellFaceGeometry(key);
      const alpha = 0.08 + reveal * (stage === "axis-hot" ? 0.36 : 0.22);
      context.globalAlpha = alpha;
      context.fillStyle = stage === "axis-hot" ? COLORS.orangeLight : COLORS.orange;
      traceCellFace(geometry);
      context.fill();
      context.globalAlpha = 0.7;
      const lineY = geometry.cell.boardPosition.y + geometry.cell.faceCenter[1];
      const lineX = geometry.cell.boardPosition.x + geometry.cell.faceCenter[0];
      if (pulse.axis === "row") {
        context.fillRect(geometry.minX + 8, lineY - 1, Math.max(4, geometry.maxX - geometry.minX - 16), 3);
      } else {
        context.fillRect(lineX - 1, geometry.minY + 8, 3, Math.max(4, geometry.maxY - geometry.minY - 16));
      }
    }
  }
  context.restore();
  game.lastRender.pulseStage = stage;
  game.lastRender.pulseAxis = pulse.axis;
  game.lastRender.pulseIndex = pulse.index;
}

function drawEchoPlacementFx() {
  if (game.transitionAgeMs >= 230 || game.state.beat === 0) return;
  const frameName = sequenceFrame("echo.place", game.transitionAgeMs);
  const anchor = cellAnchor(game.state.player.x, game.state.player.y);
  deltaFrameCentered(frameName, anchor.x, anchor.y - 44);
}

function drawBreakFx() {
  if (game.transitionAgeMs >= 230 || !game.state.lastHazards.length) return;
  const frameName = sequenceFrame("tile.break", game.transitionAgeMs);
  for (const hazard of game.state.lastHazards) {
    const anchor = cellAnchor(hazard.x, hazard.y);
    deltaFrameCentered(frameName, anchor.x, anchor.y - 52, {
      alpha: hazard.sources.includes("block-pulse") ? 0.72 : 1,
    });
  }
}

function drawVisibleShards() {
  const nextBeat = Math.min(TOTAL_BEATS, game.state.beat + 1);
  const visible = getVisibleShards(game.state, nextBeat);
  const rig = game.assets.metadata.rigs.shard;
  const hover = game.assets.metadata.animations.shardHover;
  const hoverIndex = Math.floor((game.animationTimeMs / hover.provisionalFrameDurationMs) % hover.bodyYOffsetPx.length);
  for (const shard of visible) {
    const anchor = cellAnchor(shard.x, shard.y);
    baseFrameAtPivot(rig.frames.shadow, anchor.x, anchor.y, {
      scale: hover.shadowScalePercent[hoverIndex] / 100,
    });
    baseFrameAtPivot(rig.frames.body, anchor.x, anchor.y + hover.bodyYOffsetPx[hoverIndex]);
  }

  if (game.lastCollection && game.transitionAgeMs < 320) {
    const anchor = cellAnchor(game.lastCollection.x, game.lastCollection.y);
    const sample = sampleKeyframes(game.assets.metadata.animations.shardPickup.keyframes, game.transitionAgeMs);
    const scale = lerp(sample.current.bodyScalePercent, sample.next.bodyScalePercent, sample.mix) / 100;
    const arc = lerp(sample.current.arcYOffsetPx, sample.next.arcYOffsetPx, sample.mix);
    if (scale > 0) baseFrameAtPivot(rig.frames.body, anchor.x, anchor.y + arc, { scale });
    if (game.transitionAgeMs >= 160) {
      baseFrameAtPivot(rig.frames.collect_effect, anchor.x, anchor.y - 54, {
        alpha: 1 - clamp((game.transitionAgeMs - 160) / 180) * 0.6,
      });
    }
  }
  game.lastRender.visibleShardCount = visible.length;
}

function movementState() {
  const source = cellAnchor(game.state.previousPlayer.x, game.state.previousPlayer.y);
  const destination = cellAnchor(game.state.player.x, game.state.player.y);
  if (game.transitionAgeMs >= MOVE_DURATION_MS || game.state.beat === 0) {
    const breathe = Math.floor(game.animationTimeMs / 320) % 2 === 1;
    return { anchor: destination, pose: breathe ? "breathe" : "idle", progress: 1 };
  }
  const sample = sampleKeyframes(game.assets.metadata.animations.pipStep.keyframes, game.transitionAgeMs);
  const progress = lerp(sample.current.travelProgress, sample.next.travelProgress, sample.mix);
  return { anchor: lerpPoint(source, destination, progress), pose: sample.current.pose, progress };
}

function drawFlipTransfer() {
  if (game.flipAgeMs >= FLIP_DURATION_MS || game.state.lastAction !== "flip") return;
  const home = cellAnchor(game.state.previousPlayer.x, game.state.previousPlayer.y);
  const mirror = cellAnchor(game.state.player.x, game.state.player.y);
  const local = game.flipAgeMs;
  if (local >= 140 && local < 250) {
    const progress = clamp((local - 140) / 80);
    const from = lerp(0.105, 0.431, progress);
    const to = lerp(0.514, 0.895, progress);
    drawSegmentedTransferLine(
      lerpPoint(home, mirror, from),
      lerpPoint(home, mirror, to),
      progress > 0.62 ? COLORS.impact : COLORS.orange,
      progress > 0.8 ? 3 : 2,
    );
  }
}

function drawPipActor() {
  let movement = movementState();
  let pose = movement.pose;
  if (game.hitAgeMs < HIT_DURATION_MS) {
    const sample = sampleKeyframes(game.assets.metadata.animations.pipHitLife.keyframes, game.hitAgeMs);
    pose = sample.current.pose;
  }

  if (game.flipAgeMs >= 70 && game.flipAgeMs < 300 && game.state.lastAction === "flip") {
    const source = cellAnchor(game.state.previousPlayer.x, game.state.previousPlayer.y);
    const destination = cellAnchor(game.state.player.x, game.state.player.y);
    const transfer = clamp((game.flipAgeMs - 70) / 230);
    const ghost = lerpPoint(source, destination, clamp(0.2 + transfer * 0.62));
    drawPip(ghost, "idle", 0.34 + (1 - transfer) * 0.12);
  }
  drawPip(movement.anchor, pose);
  game.lastRender.pipPose = pose;
  game.lastRender.pipTravelProgress = Number(movement.progress.toFixed(3));
}

function drawQueuedAction() {
  if (game.mode !== "playing" || game.queuedAction === "stay") return;
  const anchor = cellAnchor(game.state.player.x, game.state.player.y);
  const offsets = {
    up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0], flip: [0, 0],
  };
  const [dx, dy] = offsets[game.queuedAction];
  context.save();
  context.globalAlpha = 0.65 + Math.sin(game.animationTimeMs / 70) * 0.18;
  if (game.queuedAction === "flip") {
    context.strokeStyle = COLORS.orange;
    context.lineWidth = 2;
    context.strokeRect(anchor.x - 54, anchor.y - 104, 108, 10);
  } else {
    const start = { x: anchor.x + dx * 45, y: anchor.y - 50 + dy * 24 };
    const end = { x: start.x + dx * 18, y: start.y + dy * 18 };
    drawPixelLine(start, end, COLORS.orange, 3, 0.9);
    context.fillStyle = COLORS.impact;
    context.fillRect(end.x - 3, end.y - 3, 7, 7);
  }
  context.restore();
}

function cameraResponse() {
  if (game.transitionAgeMs >= 130 || !game.state.lastHazards.length) return { x: 0, y: 0, alpha: 0 };
  const local = game.transitionAgeMs;
  if (local < 26) return { x: 2, y: -1, alpha: 0.1 };
  if (local < 58) return { x: -2, y: 1, alpha: 0.075 };
  if (local < 92) return { x: 1, y: 0, alpha: 0.04 };
  return { x: 0, y: 0, alpha: 0.02 };
}

function panelRule(x, y, width, color = COLORS.darkGray) {
  context.fillStyle = color;
  context.fillRect(x, y, width, 2);
}

function queueGuidance(id, text) {
  if (!game.guidanceEnabled || game.guidanceSeen.has(id)) return;
  game.guidanceSeen.add(id);
  game.guidanceQueue.push({ id, text, ageMs: 0 });
  if (!game.guidance) game.guidance = game.guidanceQueue.shift();
}

function updateGuidanceAfterBeat(state) {
  if (!game.guidanceEnabled) return;
  if (state.beat === 1) queueGuidance("echo", "ECHO ARMED - RETURNS IN 4");
  const newEcho = state.echoes.find((echo) => echo.createdBeat === state.beat);
  if (newEcho?.charged) queueGuidance("charged", "CHARGED ECHO - ADJACENT TILES WILL HIT");
  if (getPulseForBeat(state.challenge, state.beat + 1)) {
    queueGuidance("pulse", "BLOCK PULSE - CLEAR THE LIT LINE");
  }
  if (getVisibleShards(state, state.beat + 1).length > 0) {
    queueGuidance("shard", "SHARD +40");
  }
}

function drawGuidanceRail() {
  if (game.mode !== "playing") return;
  const notice = game.scoreNotice?.text ?? game.guidance?.text;
  if (!notice) return;
  const ageMs = game.scoreNotice?.ageMs ?? game.guidance?.ageMs ?? 0;
  const alpha = clamp((GUIDANCE_DURATION_MS - ageMs) / 180);
  context.save();
  context.globalAlpha = alpha;
  context.fillStyle = "rgba(0,0,0,0.92)";
  context.fillRect(508, 768, 664, 34);
  panelRule(508, 768, 664, COLORS.orange);
  bitmapText(notice, 840, 780, {
    scale: 2,
    color: game.scoreNotice ? COLORS.impact : COLORS.orangeLight,
    align: "center",
  });
  context.restore();
}

function drawMenuOverlay() {
  context.save();
  context.fillStyle = "rgba(0,0,0,0.68)";
  context.fillRect(0, 0, ART_WIDTH, ART_HEIGHT);
  panelRule(532, 286, 616, COLORS.orange);
  panelRule(652, 620, 376);
  bitmapText("BLOCKSTEP", 840, 316, { scale: 7, color: COLORS.orange, align: "center" });
  bitmapText("SURVIVE 36 BEATS", 840, 398, { scale: 3, color: COLORS.white, align: "center" });
  bitmapText("YOUR STEPS RETURN IN FOUR", 840, 438, { scale: 2, color: COLORS.gray, align: "center" });
  bitmapText("BITCOIN SETS THE RUN - HEMI CHECKS THE REPLAY", 840, 462, {
    scale: 2, color: COLORS.orangeLight, align: "center",
  });
  bitmapText("ARROWS / WASD", 590, 486, { scale: 2, color: COLORS.white, align: "center" });
  bitmapText("MOVE", 590, 516, { scale: 2, color: COLORS.gray, align: "center" });
  bitmapText("SPACE", 1090, 486, { scale: 2, color: COLORS.white, align: "center" });
  bitmapText("HEMI FLIP", 1090, 516, { scale: 2, color: COLORS.gray, align: "center" });
  if (!blockContext.verificationEligible) {
    bitmapText("ONCHAIN SCORE SUBMISSION OFFLINE", 840, 550, {
      scale: 2, color: COLORS.orange, align: "center",
    });
    bitmapText("HEMI UPDATE PENDING - YOU CAN STILL PLAY", 840, 580, {
      scale: 1, color: COLORS.gray, align: "center",
    });
  }
  const networkText = game.networkReady
    ? `${blockContext.network === "live" ? "LIVE HEMI RUN" : "OFFLINE PRACTICE"} - BTC #${blockContext.number}`
    : "SYNCING BITCOIN THROUGH HEMI";
  bitmapText(networkText, 840, 620, { scale: 2, color: COLORS.gray, align: "center" });
  const promptColor = Math.floor(game.animationTimeMs / 420) % 2 === 0 ? COLORS.impact : COLORS.orange;
  bitmapText(game.networkReady ? "ENTER - START RUN" : "VERIFYING BLOCK", 840, 678, {
    scale: 3,
    color: promptColor,
    align: "center",
  });
  bitmapText("H - HOW TO PLAY     F - FULLSCREEN", 840, 734, {
    scale: 2,
    color: COLORS.gray,
    align: "center",
  });
  context.restore();
}

function drawCountdownOverlay() {
  if (game.mode !== "countdown") return;
  const segment = Math.floor((COUNTDOWN_DURATION_MS - game.countdownMs) / 700);
  const label = countdownLabel(game.countdownMs);
  const supportingCopy = ["YOUR STEPS RETURN", "FOUR BEATS LATER", "READ THE FLOOR", "MOVE"];
  const local = (COUNTDOWN_DURATION_MS - game.countdownMs) % 700;
  const scale = label === "GO" ? 7 : 11;
  context.save();
  context.fillStyle = `rgba(0,0,0,${0.24 + (1 - clamp(local / 700)) * 0.18})`;
  context.fillRect(0, 126, ART_WIDTH, 674);
  bitmapText(label, 840, label === "GO" ? 338 : 300, {
    scale,
    color: local < 130 ? COLORS.impact : COLORS.orange,
    align: "center",
  });
  bitmapText(supportingCopy[Math.min(segment, 3)], 840, 438, {
    scale: 3,
    color: COLORS.white,
    align: "center",
  });
  context.restore();
}

function countdownLabel(remainingMs) {
  const segment = Math.floor((COUNTDOWN_DURATION_MS - remainingMs) / 700);
  return segment < 3 ? String(3 - segment) : "GO";
}

function drawHowToPlayOverlay() {
  if (game.panel !== "help") return;
  context.save();
  context.fillStyle = "rgba(0,0,0,0.92)";
  context.fillRect(0, 0, ART_WIDTH, ART_HEIGHT);
  context.fillStyle = COLORS.nearBlack;
  context.fillRect(288, 86, 1104, 772);
  panelRule(288, 86, 1104, COLORS.orange);
  panelRule(288, 856, 1104, COLORS.orange);
  bitmapText("HOW TO PLAY", 352, 126, { scale: 4, color: COLORS.orange });
  bitmapText("SURVIVE 36 BEATS. KEEP AT LEAST ONE LIFE.", 352, 174, {
    scale: 2,
    color: COLORS.white,
  });
  panelRule(352, 210, 976);

  const rows = [
    ["MOVE", "ARROWS / WASD", "CHOOSE ONE TILE BEFORE EACH BEAT LOCKS."],
    ["RETURN", "4 3 2 1", "EVERY STEP DETONATES FOUR BEATS LATER."],
    ["BLOCK", "LIT ROW OR COLUMN", "CLEAR THE LIT LINE BEFORE THE PULSE."],
    ["CHARGED", "ORANGE EDGE", "HITS ITS TILE + FOUR NEIGHBORS."],
    ["SHARD", "+40", "COLLECT IT BEFORE ITS WINDOW CLOSES."],
    ["FLIP", "SPACE", "MIRRORS PIP ONCE PER RUN."],
  ];
  rows.forEach(([label, control, detail], index) => {
    const y = 246 + index * 86;
    bitmapText(label, 352, y, { scale: 2, color: COLORS.orange });
    bitmapText(control, 548, y, { scale: 2, color: COLORS.white });
    bitmapText(detail, 548, y + 30, { scale: 2, color: COLORS.gray });
    if (index < rows.length - 1) panelRule(352, y + 64, 976, "#202325");
  });
  panelRule(352, 744, 976, "#202325");
  bitmapText("BITCOIN SETS THE RUN - HEMI CHECKS THE REPLAY", 840, 764, {
    scale: 2, color: COLORS.orangeLight, align: "center",
  });
  bitmapText("ENTER - START RUN", 352, 806, { scale: 2, color: COLORS.orangeLight });
  bitmapText("ESC - BACK", 1328, 806, { scale: 2, color: COLORS.gray, align: "right" });
  context.restore();
}

function drawResultOverlay() {
  if (game.mode !== "won" && game.mode !== "lost") return;
  const won = game.mode === "won";
  const mappingName = won ? "result.clear" : "result.defeat";
  const frameName = sequenceFrame(mappingName, Math.min(game.resultAgeMs, won ? 480 : 640));
  const accent = won ? COLORS.orange : COLORS.white;
  context.save();
  context.fillStyle = "rgba(0,0,0,0.74)";
  context.fillRect(0, 0, ART_WIDTH, ART_HEIGHT);
  context.fillStyle = won ? COLORS.orange : COLORS.darkGray;
  context.fillRect(440, 174, 800, 3);
  context.fillRect(520, 776, 640, 2);
  if (won) {
    const effect = sequenceFrame("result.victoryFx", Math.min(game.resultAgeMs, 280));
    deltaFrameCentered(effect, 840, 286, { scale: 2, alpha: 0.86 });
  }
  deltaFrameCentered(frameName, 840, 286, { scale: 2 });
  game.lastRender.resultFrame = frameName;
  bitmapText(won ? "RUN CLEARED" : "RUN ENDED", 840, 426, { scale: 6, color: accent, align: "center" });
  context.fillStyle = COLORS.nearBlack;
  context.fillRect(446, 506, 788, won ? 248 : 174);
  context.fillStyle = won ? COLORS.orange : COLORS.darkGray;
  context.fillRect(446, 506, 788, 2);
  context.fillRect(446, won ? 752 : 678, 788, 2);
  bitmapText(`SCORE ${String(game.state.score).padStart(4, "0")}`, 840, 526, {
    scale: 3, color: COLORS.white, align: "center",
  });
  if (won) {
    const points = game.state.scoreBreakdown;
    bitmapText(`BEATS ${points.survival}  SHARDS ${points.shards}  CLOSE ${points.closeCalls}`, 840, 574, {
      scale: 2, color: COLORS.gray, align: "center",
    });
    const hitDisplay = points.hitPenalty > 0 ? `-${points.hitPenalty}` : "0";
    bitmapText(
      `CLEAR ${points.runCleared}  CLEAN ${points.cleanRun}  FLIP ${points.flipReserve}  HITS ${hitDisplay}`,
      840,
      608,
      { scale: 2, color: COLORS.gray, align: "center" },
    );
    bitmapText(`PROOF READY - BTC #${game.state.challenge.blockNumber}`, 840, 654, {
      scale: 2, color: COLORS.orangeLight, align: "center",
    });
    bitmapText(blockContext.verificationEligible
      ? "V - VERIFY RUN     ENTER - RUN AGAIN"
      : "V - VIEW RUN PROOF     ENTER - RUN AGAIN", 840, 692, {
      scale: 2, color: COLORS.white, align: "center",
    });
    bitmapText(blockContext.verificationEligible
      ? "WALLET ONLY TO VERIFY - GAS SPONSORED"
      : "ONCHAIN SCORE SUBMISSION OFFLINE", 840, 720, {
      scale: 2, color: COLORS.gray, align: "center",
    });
    if (!blockContext.verificationEligible) {
      bitmapText("HEMI UPDATE PENDING - YOUR RUN PROOF STAYS LOCAL", 840, 740, {
        scale: 1, color: COLORS.darkGray, align: "center",
      });
    }
  } else {
    bitmapText(`BEAT ${game.state.beat}/36  SCORE ${String(game.state.score).padStart(4, "0")}`, 840, 574, {
      scale: 2, color: COLORS.gray, align: "center",
    });
    bitmapText(`${game.state.hits} HITS  RUN NOT VERIFIABLE`, 840, 610, {
      scale: 2, color: COLORS.white, align: "center",
    });
    bitmapText("SURVIVE BEAT 36 TO VERIFY", 840, 650, {
      scale: 2, color: COLORS.gray, align: "center",
    });
  }
  const promptColor = Math.floor(game.animationTimeMs / 420) % 2 === 0 ? COLORS.impact : COLORS.orange;
  if (!won) bitmapText("ENTER - TRY AGAIN     H - HOW TO PLAY", 840, 722, {
    scale: 2, color: promptColor, align: "center",
  });
  context.restore();
}

function drawVerificationOverlay() {
  if (game.panel !== "verification") return;
  const state = game.verification.state;
  const liveRun = blockContext.network === "live";
  const canSubmit = blockContext.verificationEligible === true;
  const title = canSubmit
    ? {
        wallet: "CONNECT WALLET",
        signing: "SIGN RUN",
        relaying: "VERIFYING RUN",
        verified: "SCORE VERIFIED",
        error: "VERIFY AGAIN",
      }[state] ?? "VERIFY ON HEMI"
    : "SCORE SUBMISSION OFFLINE";
  const detail = state === "verified"
    ? `SCORE ${String(game.verification.score ?? game.state.score).padStart(4, "0")} - RECORDED ON HEMI`
    : `SCORE ${String(game.state.score).padStart(4, "0")} - BTC #${game.state.challenge.blockNumber}`;
  const message = canSubmit
    ? {
        idle: "FREE SIGNATURE - RELAYER PAYS NETWORK GAS",
        wallet: "CONFIRM THE WALLET CONNECTION",
        signing: "CONFIRM THE FREE RUN SIGNATURE",
        relaying: "WAITING FOR HEMI CONFIRMATION",
        verified: "YOUR BEST VERIFIED RUN IS NOW UPDATED",
        error: String(game.verification.message || "VERIFICATION COULD NOT FINISH").toUpperCase().slice(0, 54),
      }[state] ?? "RUN PROOF READY"
    : liveRun
      ? "HEMI NETWORK UPDATE PENDING"
      : "LIVE HEMI RUN REQUIRED FOR VERIFICATION";
  const availabilityDetail = canSubmit
    ? "NO WALLET OR GAS NEEDED TO PLAY"
    : liveRun
      ? "YOU CAN STILL PLAY - THIS RUN STAYS LOCAL"
      : "OFFLINE PRACTICE PROOFS STAY LOCAL";
  const action = state === "verified"
    ? "ESC - BACK"
    : state === "wallet" || state === "signing" || state === "relaying"
      ? "COMPLETE THE WALLET STEP"
      : canSubmit
        ? "ENTER - CONNECT WALLET AND SIGN"
        : "ESC - BACK";
  context.save();
  context.fillStyle = "rgba(0,0,0,0.9)";
  context.fillRect(0, 0, ART_WIDTH, ART_HEIGHT);
  context.fillStyle = COLORS.nearBlack;
  context.fillRect(430, 270, 820, 406);
  panelRule(430, 270, 820, COLORS.orange);
  panelRule(430, 674, 820, COLORS.orange);
  bitmapText(title, 840, 324, { scale: 5, color: COLORS.orange, align: "center" });
  bitmapText(detail, 840, 408, {
    scale: 2, color: COLORS.white, align: "center",
  });
  bitmapText(message, 840, 474, {
    scale: 2, color: COLORS.orangeLight, align: "center",
  });
  bitmapText(availabilityDetail, 840, 522, {
    scale: 2, color: COLORS.gray, align: "center",
  });
  bitmapText(`CONTRACT ${scoreContractAddress.slice(0, 8)}...${scoreContractAddress.slice(-6)}`.toUpperCase(), 840, 558, {
    scale: 2, color: COLORS.darkGray, align: "center",
  });
  bitmapText(action, 840, 620, { scale: 2, color: COLORS.white, align: "center" });
  context.restore();
}

function render() {
  if (!game.ready) return;
  game.lastRender = createLastRenderState();
  const camera = cameraResponse();

  // Reset the full drawing state, including any prior clip path. setTransform
  // alone does not clear clipping state across frames.
  context.reset?.();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  context.imageSmoothingEnabled = false;
  context.fillStyle = COLORS.black;
  context.fillRect(0, 0, ART_WIDTH, ART_HEIGHT);

  context.save();
  context.translate(camera.x, camera.y);
  context.drawImage(game.assets.board, 0, 0, ART_WIDTH, ART_HEIGHT);
  drawAllTiles();
  drawBlockPulse();
  drawVisibleShards();
  drawEchoPlacementFx();
  drawBreakFx();
  drawFlipTransfer();
  if (game.mode !== "won" && game.mode !== "lost") drawPipActor();
  drawQueuedAction();
  drawBoardForeground();
  if (camera.alpha > 0) {
    context.save();
    context.globalAlpha = camera.alpha;
    context.fillStyle = COLORS.orange;
    context.fillRect(0, 0, ART_WIDTH, ART_HEIGHT);
    context.restore();
  }
  context.restore();

  context.drawImage(game.assets.board, 0, 0, ART_WIDTH, 126, 0, 0, ART_WIDTH, 126);
  context.drawImage(game.assets.board, 0, 800, ART_WIDTH, ART_HEIGHT - 800, 0, 800, ART_WIDTH, ART_HEIGHT - 800);
  drawHudValues();
  drawBlockPulsePanel();
  drawTopBeatCounter();
  drawLifeIcons();
  drawBeatRail();
  drawHemiFlip();
  drawGuidanceRail();

  if (game.mode === "ready") drawMenuOverlay();
  drawCountdownOverlay();
  drawResultOverlay();
  drawHowToPlayOverlay();
  drawVerificationOverlay();

  game.lastRender.cameraOffset = { x: camera.x, y: camera.y };
}

function createProof() {
  if (game.state.status !== "won") return null;
  const packedMoves = serializeMoves(game.moveHistory);
  return {
    bitcoinHeight: game.state.challenge.blockNumber,
    bitcoinBlockHash: game.state.challenge.blockHash,
    packedMoves: `0x${packedMoves.toString(16).padStart(32, "0")}`,
    score: game.state.score,
    scoreBreakdown: { ...game.state.scoreBreakdown },
    scoreRulesVersion: game.state.scoreRulesVersion,
    contractAddress: scoreContractAddress,
  };
}

function startGame() {
  if (!game.ready || !game.networkReady) return false;
  void audio.unlock().then((ready) => {
    if (ready) audio.playCountdown(3);
  });
  challenge = createChallenge(blockContext.number, blockContext.hash);
  game.state = createPixelGameState(challenge);
  game.state.status = "playing";
  game.mode = "countdown";
  game.panel = null;
  game.queuedAction = "stay";
  game.countdownMs = COUNTDOWN_DURATION_MS;
  game.countdownCue = "3";
  game.beatElapsedMs = 0;
  game.transitionAgeMs = Number.POSITIVE_INFINITY;
  game.hitAgeMs = Number.POSITIVE_INFINITY;
  game.flipAgeMs = Number.POSITIVE_INFINITY;
  game.resultAgeMs = 0;
  game.lastCollection = null;
  game.lastPulse = null;
  game.moveHistory = [];
  game.lastProof = null;
  game.verification = {
    state: "idle",
    message: "Replay proof ready for optional Hemi verification.",
    player: null,
    transactionHash: null,
    score: null,
  };
  game.guidanceEnabled = game.completedRuns === 0;
  game.guidanceQueue = [];
  game.guidance = null;
  game.scoreNotice = null;
  setStatus(`Run armed on Bitcoin block #${blockContext.number} through ${blockContext.source}.`);
  canvas.focus();
  render();
  return true;
}

function queueMove(action) {
  if (game.mode !== "playing" || game.state.status !== "playing") return false;
  if (action === "flip" && !game.state.flipAvailable) return false;
  game.queuedAction = action;
  audio.playQueue(action);
  render();
  return true;
}

function completeBeat() {
  const before = game.state;
  const visibleBefore = getVisibleShards(before, before.beat + 1);
  const pulse = getPulseForBeat(before.challenge, before.beat + 1);
  const previousCollected = new Set(before.shardsCollected);
  const next = stepPixelGame(before, game.queuedAction);
  game.state = next;
  game.moveHistory.push(next.lastAction);
  game.transitionAgeMs = 0;
  game.hitAgeMs = next.lastEvent.includes("hit") ? 0 : Number.POSITIVE_INFINITY;
  game.flipAgeMs = next.lastAction === "flip" ? 0 : Number.POSITIVE_INFINITY;
  game.lastPulse = pulse;
  const collectedId = next.shardsCollected.find((id) => !previousCollected.has(id));
  game.lastCollection = collectedId ? visibleBefore.find((shard) => shard.id === collectedId) ?? null : null;
  game.queuedAction = "stay";
  audio.playBeat({
    action: next.lastAction,
    echoAction: next.beat > ECHO_DELAY ? game.moveHistory[next.beat - ECHO_DELAY - 1] : null,
    event: next.lastEvent,
    hasPulse: Boolean(pulse),
  });
  updateGuidanceAfterBeat(next);

  const hitDelta = next.hits - before.hits;
  const shardDelta = next.shardsCollected.length - before.shardsCollected.length;
  if (hitDelta > 0 || shardDelta > 0) {
    game.scoreNotice = {
      text: hitDelta > 0 && shardDelta > 0
        ? `HIT -${PIXEL_SCORE_VALUES.hitPenalty} / SHARD +${PIXEL_SCORE_VALUES.shard}`
        : hitDelta > 0
          ? `HIT -${PIXEL_SCORE_VALUES.hitPenalty}`
          : `SHARD +${PIXEL_SCORE_VALUES.shard}`,
      ageMs: 0,
    };
  }

  if (next.status === "won" || next.status === "lost") {
    game.mode = next.status;
    game.completedRuns += 1;
    game.guidanceEnabled = false;
    game.resultAgeMs = 0;
    game.lastProof = createProof();
    audio.playResult(next.status === "won");
    setStatus(next.status === "won" ? "Run cleared. Replay proof ready." : "Run ended. Press Enter or R to retry.");
  }
}

function update(deltaMs) {
  const dt = clamp(deltaMs, 0, 100);
  game.animationTimeMs += dt;
  game.transitionAgeMs += dt;
  game.hitAgeMs += dt;
  game.flipAgeMs += dt;
  if (game.scoreNotice) {
    game.scoreNotice.ageMs += dt;
    if (game.scoreNotice.ageMs >= GUIDANCE_DURATION_MS) game.scoreNotice = null;
  }
  if (game.guidance) {
    game.guidance.ageMs += dt;
    if (game.guidance.ageMs >= GUIDANCE_DURATION_MS) {
      game.guidance = game.guidanceQueue.shift() ?? null;
    }
  }
  if (game.mode === "won" || game.mode === "lost") game.resultAgeMs += dt;

  if (game.mode === "countdown") {
    const previousCue = countdownLabel(game.countdownMs);
    game.countdownMs = Math.max(0, game.countdownMs - dt);
    const nextCue = countdownLabel(game.countdownMs);
    if (nextCue !== previousCue && nextCue !== game.countdownCue) {
      game.countdownCue = nextCue;
      audio.playCountdown(nextCue);
    }
    if (game.countdownMs === 0) {
      game.mode = "playing";
      game.beatElapsedMs = 0;
      setStatus("Run live. Read the floor, choose a move, and commit on each beat.");
    }
  } else if (game.mode === "playing" && game.state.status === "playing") {
    game.beatElapsedMs += dt;
    let durationMs = getBeatDuration(game.state.beat + 1) * 1000;
    while (game.beatElapsedMs >= durationMs && game.state.status === "playing") {
      game.beatElapsedMs -= durationMs;
      completeBeat();
      durationMs = getBeatDuration(Math.min(TOTAL_BEATS, game.state.beat + 1)) * 1000;
    }
  }
}

function renderGameToText() {
  const nextBeat = Math.min(TOTAL_BEATS, game.state.beat + 1);
  const pulse = game.state.status === "playing" ? getPulseForBeat(game.state.challenge, nextBeat) : null;
  return JSON.stringify({
    mode: game.mode,
    ready: game.ready,
    coordinateSystem: "5x5 gameplay grid; (0,0) top-left; +x right; +y down. Renderer uses 1680x945 art pixels.",
    countdownSeconds: Number((game.countdownMs / 1000).toFixed(2)),
    beat: game.state.beat,
    targetBeat: game.state.status === "playing" ? nextBeat : game.state.beat,
    totalBeats: TOTAL_BEATS,
    secondsUntilNextBeat: game.mode === "playing"
      ? Number(Math.max(0, getBeatDuration(nextBeat) - game.beatElapsedMs / 1000).toFixed(3))
      : null,
    player: game.state.player,
    previousPlayer: game.state.previousPlayer,
    lives: game.state.lives,
    score: game.state.score,
    scoreBreakdown: game.state.scoreBreakdown,
    scoreRulesVersion: game.state.scoreRulesVersion,
    closeCalls: game.state.closeCalls,
    hits: game.state.hits,
    shardsCollected: game.state.shardsCollected.length,
    queuedAction: game.queuedAction,
    flipAvailable: game.state.flipAvailable,
    currentBlock: game.state.challenge.blockNumber,
    bitcoinBlockHash: game.state.challenge.blockHash,
    network: blockContext.network,
    networkSource: blockContext.source,
    networkReady: game.networkReady,
    upcomingPulse: pulse,
    upcomingHazards: game.state.status === "playing" ? getHazardCells(game.state, nextBeat) : [],
    echoes: game.state.echoes
      .filter((echo) => echo.detonateBeat > game.state.beat)
      .map((echo) => ({
        x: echo.x,
        y: echo.y,
        inBeats: echo.detonateBeat - game.state.beat,
        charged: echo.charged,
      })),
    visibleShards: game.state.status === "playing"
      ? getVisibleShards(game.state, nextBeat).map(({ id, x, y, expiresBeat }) => ({
          id, x, y, expiresInBeats: expiresBeat - game.state.beat,
        }))
      : [],
    lastAction: game.state.lastAction,
    lastEvent: game.state.lastEvent,
    lastHazards: game.state.lastHazards,
    resultLabel: game.mode === "won" ? "RUN CLEARED" : game.mode === "lost" ? "RUN ENDED" : null,
    activePanel: game.panel,
    contextualGuidance: game.guidance?.text ?? null,
    scoreNotice: game.scoreNotice?.text ?? null,
    completedRuns: game.completedRuns,
    proof: game.lastProof,
    verificationAvailable: game.mode === "won" && Boolean(game.lastProof),
    verificationCanSubmit: game.mode === "won" && Boolean(game.lastProof) && blockContext.verificationEligible === true,
    verification: {
      ...game.verification,
      contractAddress: scoreContractAddress,
      liveRunRequired: blockContext.network !== "live",
      challengeEligible: blockContext.verificationEligible === true,
    },
    audio: {
      available: audio.isAvailable(),
      unlocked: audio.isUnlocked(),
      muted: audio.isMuted(),
      implementation: "procedural-web-audio",
    },
    renderer: {
      entry: "/",
      canvas: { width: canvas.width, height: canvas.height },
      imageSmoothingEnabled: displayContext.imageSmoothingEnabled,
      doubleBuffered: false,
      frameTransfer: "direct-visible-canvas",
      automatedCaptureSource: "native-canvas",
      tileInstances: game.lastRender.tileInstanceCount,
      tileStates: game.lastRender.tileStates,
      pipPose: game.lastRender.pipPose,
      pipTravelProgress: game.lastRender.pipTravelProgress,
      lifeStates: game.lastRender.lifeStates,
      lifeSlotAnchors: LIFE_SLOT_ANCHORS,
      hemiFlipMode: game.lastRender.hemiFlipMode,
      beatLampState: game.lastRender.currentBeatLampState,
      topBeatText: game.lastRender.topBeatText,
      pulseStage: game.lastRender.pulseStage,
      pulseAxis: game.lastRender.pulseAxis,
      pulseIndex: game.lastRender.pulseIndex,
      visibleShardCount: game.lastRender.visibleShardCount,
      resultFrame: game.lastRender.resultFrame,
      cameraOffset: game.lastRender.cameraOffset,
    },
    integration: {
      gameLogicConnected: true,
      hemiBitcoinContextConnected: true,
      scoreProofConnected: true,
      componentScoringConnected: true,
      fullClearBeats: TOTAL_BEATS,
    },
    assetHashes: game.assetHashes,
  });
}

window.render_game_to_text = renderGameToText;
window.advanceTime = (milliseconds) => {
  game.manualTime = true;
  const amount = Math.max(0, Number(milliseconds) || 0);
  const steps = Math.max(1, Math.ceil(amount / (1000 / 60)));
  const stepMs = amount / steps;
  for (let index = 0; index < steps; index += 1) update(stepMs);
  render();
  return renderGameToText();
};

window.__blockstep = {
  startGame,
  queueMove,
  getState: () => game.state,
  getMoveHistory: () => [...game.moveHistory],
  getProof: () => game.lastProof,
  getScoreBreakdown: () => ({ ...game.state.scoreBreakdown }),
  getRunTypedData: (player, deadline) =>
    game.lastProof && scoreContractAddress
      ? buildRunTypedData({ player, proof: game.lastProof, contractAddress: scoreContractAddress, deadline })
      : null,
  getVerificationState: () => ({ ...game.verification }),
  verifyRun: () => verifyCurrentRun(),
  toggleMute: () => {
    const muted = audio.toggleMute();
    setStatus(muted ? "Sound muted." : "Sound enabled.");
    return muted;
  },
  setManualTime: (enabled) => {
    game.manualTime = Boolean(enabled);
    return renderGameToText();
  },
};

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.();
  else document.exitFullscreen?.();
}

function toggleHelp() {
  if (game.mode !== "ready" && game.mode !== "won" && game.mode !== "lost") return false;
  game.panel = game.panel === "help" ? null : "help";
  setStatus(game.panel === "help" ? "How to Play open. Press Escape to return." : "How to Play closed.");
  render();
  return true;
}

function openVerificationPreview() {
  if (game.mode !== "won" || !game.lastProof) return false;
  game.panel = "verification";
  setStatus(blockContext.verificationEligible === true
    ? "Run proof ready. Press Enter to connect a wallet and sign."
    : blockContext.network === "live"
      ? "Onchain score submission is temporarily offline while Hemi completes a network update. Your run proof stays local."
      : "Offline practice proofs stay local. Start a Live Hemi Run to verify a score.");
  render();
  return true;
}

async function verifyCurrentRun() {
  if (game.mode !== "won" || !game.lastProof || game.panel !== "verification") return false;
  if (blockContext.verificationEligible !== true) {
    updateVerification({
      state: "error",
      message: blockContext.network === "live"
        ? "Onchain score submission is temporarily offline while Hemi completes a network update."
        : "Live Hemi Run required for verification.",
    });
    return false;
  }
  if (["wallet", "signing", "relaying", "verified"].includes(game.verification.state)) return false;
  const verifier = createRunVerifier({
    provider: window.ethereum,
    fetchImpl: window.fetch.bind(window),
    onState: updateVerification,
  });
  try {
    await verifier.verify(game.lastProof);
    audio.playResult(true);
    return true;
  } catch {
    return false;
  }
}

function artPoint(event) {
  const bounds = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - bounds.left) / bounds.width) * ART_WIDTH,
    y: ((event.clientY - bounds.top) / bounds.height) * ART_HEIGHT,
  };
}

document.addEventListener("keydown", (event) => {
  const keyMap = {
    ArrowUp: "up", w: "up", W: "up",
    ArrowDown: "down", s: "down", S: "down",
    ArrowLeft: "left", a: "left", A: "left",
    ArrowRight: "right", d: "right", D: "right",
  };
  if (event.key === "Escape") {
    if (game.panel) {
      event.preventDefault();
      game.panel = null;
      setStatus("Returned to BLOCKSTEP.");
      render();
    } else if (document.fullscreenElement) {
      event.preventDefault();
      document.exitFullscreen?.();
    }
  } else if (event.key === "Enter") {
    event.preventDefault();
    if (game.panel === "verification") void verifyCurrentRun();
    else if (game.mode === "ready" || game.mode === "won" || game.mode === "lost") startGame();
  } else if (event.key === "r" || event.key === "R") {
    event.preventDefault();
    startGame();
  } else if (event.key === "f" || event.key === "F") {
    event.preventDefault();
    toggleFullscreen();
  } else if (event.key === "m" || event.key === "M") {
    event.preventDefault();
    const muted = audio.toggleMute();
    setStatus(muted ? "Sound muted." : "Sound enabled.");
    render();
  } else if (event.key === "h" || event.key === "H") {
    event.preventDefault();
    toggleHelp();
  } else if (event.key === "v" || event.key === "V") {
    event.preventDefault();
    openVerificationPreview();
  } else if (event.code === "Space") {
    event.preventDefault();
    queueMove("flip");
  } else if (keyMap[event.key]) {
    event.preventDefault();
    queueMove(keyMap[event.key]);
  }
});

canvas.addEventListener("click", (event) => {
  canvas.focus();
  if (game.panel) return;
  if (game.mode === "ready" || game.mode === "won" || game.mode === "lost") {
    startGame();
    return;
  }
  const point = artPoint(event);
  const anchor = game.assets?.boardManifest?.hemiCorrection?.anchorPixels;
  if (anchor && Math.hypot(point.x - anchor.x, point.y - anchor.y) <= 92) queueMove("flip");
});

document.addEventListener("visibilitychange", () => {
  previousRealTime = performance.now();
});

let previousRealTime = performance.now();
function animationLoop(now) {
  const delta = Math.min(50, Math.max(0, now - previousRealTime));
  previousRealTime = now;
  // Manual time is a deterministic capture/test mode. window.advanceTime()
  // performs the single requested render, so drawing again on every RAF can
  // let an automated capture observe a partially rasterized frame.
  if (game.ready && !game.manualTime) {
    update(delta);
    render();
  }
  requestAnimationFrame(animationLoop);
}

async function loadAssets() {
  const [
    metadataBytes,
    atlasBytes,
    boardBytes,
    boardManifestBytes,
    beatMetadataBytes,
    beatAtlasBytes,
    deltaMetadataBytes,
    deltaAtlasBytes,
    fontMetadataBytes,
  ] = await Promise.all([
    fetchBytes(URLS.metadata),
    fetchBytes(URLS.atlas),
    fetchBytes(URLS.board),
    fetchBytes(URLS.boardManifest),
    fetchBytes(URLS.beatMetadata),
    fetchBytes(URLS.beatAtlas),
    fetchBytes(URLS.deltaMetadata),
    fetchBytes(URLS.deltaAtlas),
    fetchBytes(URLS.fontMetadata),
  ]);

  const decoder = new TextDecoder();
  const metadata = JSON.parse(decoder.decode(metadataBytes));
  const boardManifest = JSON.parse(decoder.decode(boardManifestBytes));
  const beatMetadata = JSON.parse(decoder.decode(beatMetadataBytes));
  const deltaMetadata = JSON.parse(decoder.decode(deltaMetadataBytes));
  const fontMetadata = JSON.parse(decoder.decode(fontMetadataBytes));
  const runtimeFontMetadata = {
    ...fontMetadata,
    atlasFrame: deltaMetadata.font.atlasFrame,
    glyphAtlasOrigin: deltaMetadata.font.glyphAtlasOrigin,
  };
  const [atlasHash, boardHash, beatHash, deltaHash, atlas, board, beatAtlas, deltaAtlas] = await Promise.all([
    sha256(atlasBytes),
    sha256(boardBytes),
    sha256(beatAtlasBytes),
    sha256(deltaAtlasBytes),
    imageFromBytes(atlasBytes),
    imageFromBytes(boardBytes),
    imageFromBytes(beatAtlasBytes),
    imageFromBytes(deltaAtlasBytes),
  ]);

  validateAssetContract({
    metadata,
    atlasHash,
    boardHash,
    boardManifest,
    beatMetadata,
    beatHash,
    deltaMetadata,
    deltaHash,
    fontMetadata: runtimeFontMetadata,
  });
  requireContract(atlas.width === 2048 && atlas.height === 2048, "decoded base atlas dimensions drifted");
  requireContract(board.width === ART_WIDTH && board.height === ART_HEIGHT, "decoded board dimensions drifted");
  requireContract(deltaAtlas.width === 1024 && deltaAtlas.height === 640, "decoded pixel add-on dimensions drifted");
  requireContract(
    beatAtlas.width === beatMetadata.meta.atlasSize.w && beatAtlas.height === beatMetadata.meta.atlasSize.h,
    "decoded top Beat atlas dimensions drifted",
  );

  game.assets = {
    metadata,
    atlas,
    board,
    boardManifest,
    beatMetadata,
    beatAtlas,
    deltaMetadata,
    deltaAtlas,
    fontMetadata: runtimeFontMetadata,
  };
  game.assetHashes = {
    baseAtlas: atlasHash,
    board: boardHash,
    beatCounter: beatHash,
    effectsAtlas: deltaHash,
    effectsMetadata: await sha256(deltaMetadataBytes),
    baseAtlasChangedByEffects: deltaMetadata.meta.baseAtlas.changed,
  };
  game.ready = true;
  gameFrame.dataset.ready = "true";
  setStatus(blockContext.verificationEligible
    ? "BLOCKSTEP is ready. Onchain score submission is available after a cleared run."
    : "BLOCKSTEP is ready. Onchain score submission is temporarily offline while Hemi completes a network update. You can still play normally.");
  render();
  canvas.focus();
  window.dispatchEvent(new CustomEvent("blockstep-ready"));
}

async function syncBitcoinContext() {
  if (search.has("offline")) {
    blockContext = { ...DEFAULT_BLOCK };
    challenge = createChallenge(blockContext.number, blockContext.hash);
    game.state = createPixelGameState(challenge);
    game.networkReady = true;
    setStatus(`Bitcoin block #${blockContext.number}. Offline practice.`);
    if (game.ready) render();
    return;
  }
  setStatus("Syncing Bitcoin through Hemi Mainnet.");
  try {
    blockContext = await loadRelayedBitcoinContext();
    if (!blockContext) {
      blockContext = { ...(await loadLatestBitcoinContext()), verificationEligible: false };
    }
  } catch (error) {
    console.warn("Hemi sync unavailable; using deterministic offline practice block.", error);
    blockContext = { ...DEFAULT_BLOCK };
  }
  challenge = createChallenge(blockContext.number, blockContext.hash);
  if (game.mode === "ready") game.state = createPixelGameState(challenge);
  game.networkReady = true;
  setStatus(`Bitcoin block #${blockContext.number}. ${blockContext.source}.`);
  if (game.ready) render();
}

requestAnimationFrame(animationLoop);
Promise.all([loadAssets(), syncBitcoinContext()]).catch((error) => {
  gameFrame.dataset.ready = "error";
  gameGate.querySelector("strong").textContent = "BLOCKSTEP COULD NOT START";
  gameGate.querySelector("span").textContent = error.message;
  setStatus(`BLOCKSTEP could not start: ${error.message}`);
  console.error(error);
});
