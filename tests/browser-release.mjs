import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE_URL = process.env.BLOCKSTEP_URL || "http://127.0.0.1:4173";
const OUTPUT_DIR = path.resolve("artifacts/browser-qa");
const MANUAL_URL = `${BASE_URL}/?offline=1&manual=1`;
const LIVE_URL = `${BASE_URL}/?offline=1`;
const ART_WIDTH = 1680;
const ART_HEIGHT = 945;
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
const VIEWPORTS = [
  { width: 1040, height: 900, label: "1040x900-compact" },
  { width: 1366, height: 768, label: "1366x768" },
  { width: 1680, height: 945, label: "1680x945-native" },
  { width: 1920, height: 1080, label: "1920x1080" },
  { width: 2560, height: 1440, label: "2560x1440" },
  { width: 3360, height: 1890, label: "3360x1890-2x" },
];
const PERFORMANCE_VIEWPORTS = VIEWPORTS.filter(({ width }) => [1366, 1920, 2560].includes(width));
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

function hashFile(relativePath) {
  return sha256(fs.readFileSync(path.resolve(relativePath)));
}

function percentile(values, fraction) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)];
}

const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader"],
});
const allErrors = [];

async function openGame(viewport, { manual = true, name = "page" } = {}) {
  const page = await browser.newPage({ viewport });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));
  await page.goto(manual ? MANUAL_URL : LIVE_URL, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#game-frame")?.dataset.ready === "true");
  allErrors.push({ name, errors });
  return { page, errors };
}

async function state(page) {
  return JSON.parse(await page.evaluate(() => window.render_game_to_text()));
}

async function advance(page, milliseconds) {
  await page.evaluate((amount) => window.advanceTime(amount), milliseconds);
}

async function compositorFrame(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function captureCanvas(page, name) {
  await compositorFrame(page);
  await page.locator("#pixel-game-canvas").screenshot({ path: path.join(OUTPUT_DIR, `${name}.png`) });
  fs.writeFileSync(path.join(OUTPUT_DIR, `${name}.json`), JSON.stringify(await state(page), null, 2));
}

async function nativeCanvasBytes(page) {
  const dataUrl = await page.evaluate(() => document.querySelector("#pixel-game-canvas").toDataURL("image/png"));
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(",") + 1), "base64");
}

async function finishCountdown(page) {
  const current = await state(page);
  assert.equal(current.mode, "countdown");
  await advance(page, Math.ceil(current.countdownSeconds * 1000) + 2);
  assert.equal((await state(page)).mode, "playing");
}

async function resolveBeat(page, afterMilliseconds = 2) {
  const current = await state(page);
  assert.equal(current.mode, "playing");
  await advance(page, Math.ceil(current.secondsUntilNextBeat * 1000) + afterMilliseconds);
}

async function queueAndResolve(page, action, afterMilliseconds = 2) {
  const accepted = await page.evaluate((nextAction) => window.__blockstep.queueMove(nextAction), action);
  assert.equal(accepted, true, `action ${action} should be accepted`);
  await resolveBeat(page, afterMilliseconds);
}

async function beginRun(page) {
  await page.keyboard.press("Enter");
  assert.equal((await state(page)).mode, "countdown");
  await finishCountdown(page);
}

async function runRoute(page, route) {
  for (const action of route) await queueAndResolve(page, action);
  return state(page);
}

async function clickHemiFlip(page) {
  const box = await page.locator("#pixel-game-canvas").boundingBox();
  assert.ok(box, "canvas must have a clickable box");
  await page.mouse.click(
    box.x + box.width * (1547 / ART_WIDTH),
    box.y + box.height * (819 / ART_HEIGHT),
  );
}

async function runEndToEnd() {
  const { page, errors } = await openGame({ width: 1680, height: 945 }, { name: "end-to-end" });
  let current = await state(page);
  assert.equal(current.mode, "ready");
  assert.equal(current.ready, true);
  assert.equal(current.networkReady, true);
  assert.equal(current.renderer.tileInstances, 25);
  assert.equal(current.renderer.imageSmoothingEnabled, false);
  assert.equal(current.renderer.entry, "/");
  assert.deepEqual(current.integration, {
    gameLogicConnected: true,
    hemiBitcoinContextConnected: true,
    scoreProofConnected: true,
    componentScoringConnected: true,
    fullClearBeats: 36,
  });
  assert.equal(await page.title(), "BLOCKSTEP // Every Step Comes Back");
  await captureCanvas(page, "01-ready");

  await page.keyboard.press("h");
  assert.equal((await state(page)).activePanel, "help");
  await captureCanvas(page, "02-help");
  await page.keyboard.press("Escape");
  assert.equal((await state(page)).activePanel, null);

  await page.keyboard.press("f");
  await page.waitForFunction(() => Boolean(document.fullscreenElement));
  assert.equal(await page.evaluate(() => Boolean(document.fullscreenElement)), true);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.fullscreenElement);

  await page.keyboard.press("Enter");
  assert.equal((await state(page)).mode, "countdown");
  await captureCanvas(page, "03-countdown");
  await finishCountdown(page);
  await page.keyboard.press("h");
  assert.equal((await state(page)).activePanel, null, "help must not interrupt a live run");

  await page.keyboard.press("ArrowLeft");
  assert.equal((await state(page)).queuedAction, "left");
  await resolveBeat(page);
  assert.deepEqual((await state(page)).player, { x: 1, y: 3 });
  assert.equal((await state(page)).contextualGuidance, "ECHO ARMED - RETURNS IN 4");
  await captureCanvas(page, "05-first-beat-guidance");
  await page.keyboard.press("w");
  assert.equal((await state(page)).queuedAction, "up");
  await resolveBeat(page);
  assert.deepEqual((await state(page)).player, { x: 1, y: 2 });
  await page.keyboard.press("Space");
  assert.equal((await state(page)).queuedAction, "flip");
  await resolveBeat(page, 180);
  assert.deepEqual((await state(page)).player, { x: 3, y: 2 });
  assert.equal((await state(page)).flipAvailable, false);
  assert.equal(await page.evaluate(() => window.__blockstep.queueMove("flip")), false);
  await captureCanvas(page, "04-keyboard-and-flip");

  await page.keyboard.press("r");
  await finishCountdown(page);
  await clickHemiFlip(page);
  assert.equal((await state(page)).queuedAction, "flip", "scaled Hemi Flip click should queue the move");
  await page.keyboard.press("r");
  await finishCountdown(page);

  for (let index = 0; index < WIN_ROUTE.length; index += 1) {
    const targetBeat = index + 1;
    assert.equal(
      await page.evaluate((action) => window.__blockstep.queueMove(action), WIN_ROUTE[index]),
      true,
    );
    if (targetBeat === 9) {
      current = await state(page);
      await advance(page, Math.max(0, Math.round(current.secondsUntilNextBeat * 1000) - 200));
      current = await state(page);
      assert.equal(current.targetBeat, 9);
      assert.ok(current.upcomingPulse);
      assert.ok(current.echoes.some((echo) => echo.charged));
      assert.equal(current.renderer.pulseStage, "axis-hot");
      await captureCanvas(page, "06-bitcoin-pulse-and-charged-echo");
    }
    await resolveBeat(page);
  }

  current = await state(page);
  assert.equal(current.mode, "won");
  assert.equal(current.resultLabel, "RUN CLEARED");
  assert.equal(current.score, 1585);
  assert.equal(current.hits, 0);
  assert.equal(current.shardsCollected, 8);
  assert.equal(current.closeCalls, 32);
  assert.equal(current.verificationAvailable, true);
  assert.match(current.proof.packedMoves, /^0x[0-9a-f]{32}$/);
  assert.deepEqual(current.scoreBreakdown, {
    survival: 360,
    shards: 320,
    closeCalls: 480,
    runCleared: 200,
    cleanRun: 150,
    flipReserve: 75,
    hitPenalty: 0,
  });
  await advance(page, 500);
  await captureCanvas(page, "07-zero-hit-clear");

  await page.keyboard.press("v");
  assert.equal((await state(page)).activePanel, "verification");
  await captureCanvas(page, "08-verification");
  await page.keyboard.press("Escape");

  await beginRun(page);
  current = await runRoute(page, ONE_HIT_ROUTE);
  assert.equal(current.mode, "won");
  assert.equal(current.hits, 1);
  assert.equal(current.score, 1120);
  assert.equal(current.scoreBreakdown.hitPenalty, 100);
  await advance(page, 500);
  await captureCanvas(page, "09-one-hit-clear");

  await beginRun(page);
  current = await runRoute(page, TWO_HIT_ROUTE);
  assert.equal(current.mode, "won");
  assert.equal(current.hits, 2);
  assert.equal(current.score, 990);
  assert.equal(current.scoreBreakdown.hitPenalty, 200);
  await advance(page, 500);
  await captureCanvas(page, "10-two-hit-clear");

  await beginRun(page);
  for (let beat = 1; beat <= 7; beat += 1) await queueAndResolve(page, "stay", beat === 7 ? 500 : 2);
  current = await state(page);
  assert.equal(current.mode, "lost");
  assert.equal(current.beat, 7);
  assert.equal(current.hits, 3);
  assert.equal(current.lives, 0);
  assert.equal(current.proof, null);
  await captureCanvas(page, "11-third-hit-defeat");
  await page.keyboard.press("h");
  assert.equal((await state(page)).activePanel, "help");
  await page.keyboard.press("Escape");

  assert.equal(await page.locator("#faq details").count(), 18);
  const bodyCopy = await page.locator("body").textContent();
  assert.match(bodyCopy, /PLAYER GUIDE/i);
  assert.match(bodyCopy, /currently optimized for desktop keyboard play/i);
  assert.match(bodyCopy, /Every hit subtracts 100 points/i);
  await page.locator("#faq details").last().evaluate((element) => { element.open = true; });
  await page.locator("#faq").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(OUTPUT_DIR, "12-public-faq.png") });
  assert.deepEqual(errors, []);
  await page.close();

  return {
    zeroHitScore: 1585,
    oneHitScore: 1120,
    twoHitScore: 990,
    defeatBeat: 7,
    controls: ["Enter", "Arrow keys", "WASD", "Space", "H", "V", "R", "F", "Escape", "Hemi Flip click"],
  };
}

async function runLayoutMatrix() {
  const results = [];
  for (const viewport of VIEWPORTS) {
    const { page, errors } = await openGame(viewport, { name: `layout-${viewport.label}` });
    const layout = await page.evaluate(() => {
      const frame = document.querySelector("#game-frame");
      const canvas = document.querySelector("#pixel-game-canvas");
      const frameBox = frame.getBoundingClientRect();
      const canvasBox = canvas.getBoundingClientRect();
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: document.documentElement.scrollWidth,
        frame: { x: frameBox.x, y: frameBox.y, width: frameBox.width, height: frameBox.height },
        canvas: { width: canvasBox.width, height: canvasBox.height },
        imageRendering: getComputedStyle(canvas).imageRendering,
      };
    });
    assert.ok(layout.documentWidth <= viewport.width + 1, `${viewport.label} must not overflow horizontally`);
    assert.ok(Math.abs(layout.canvas.width / layout.canvas.height - 16 / 9) < 0.002, `${viewport.label} must remain 16:9`);
    assert.ok(layout.frame.y >= -1, `${viewport.label} frame must stay visible`);
    assert.ok(layout.canvas.height <= viewport.height + 1, `${viewport.label} game must fit the viewport height`);
    assert.match(layout.imageRendering, /pixelated|crisp-edges/);
    const current = await state(page);
    assert.equal(current.renderer.imageSmoothingEnabled, false);
    assert.equal(current.renderer.tileInstances, 25);
    await captureCanvas(page, `layout-${viewport.label}`);

    await beginRun(page);
    await clickHemiFlip(page);
    assert.equal((await state(page)).queuedAction, "flip", `${viewport.label} Hemi Flip hit target`);

    if (viewport.width === 1040 || viewport.width === 1920) {
      await page.keyboard.press("r");
      await finishCountdown(page);
      for (let beat = 0; beat < 4; beat += 1) await queueAndResolve(page, WIN_ROUTE[beat]);
      await page.keyboard.press("r");
      await advance(page, 2402);
      await page.keyboard.press("r");
      await advance(page, 2402);
      for (let beat = 1; beat <= 7; beat += 1) await queueAndResolve(page, "stay");
      await page.keyboard.press("h");
      await captureCanvas(page, `layout-${viewport.label}-help`);
      await page.keyboard.press("Escape");
      await page.locator("#faq").scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUTPUT_DIR, `layout-${viewport.label}-faq.png`) });
    }

    assert.deepEqual(errors, []);
    results.push({ label: viewport.label, ...layout });
    await page.close();
  }
  return results;
}

async function runRepeatabilityPass(passLabel) {
  const { page, errors } = await openGame({ width: 1680, height: 945 }, { name: `repeat-${passLabel}` });
  const hashes = {};
  const save = async (label) => {
    const bytes = await nativeCanvasBytes(page);
    hashes[label] = sha256(bytes);
    if (passLabel === "a") fs.writeFileSync(path.join(OUTPUT_DIR, `repeat-${label}.png`), bytes);
  };

  await save("ready");
  await page.keyboard.press("h");
  await save("help");
  await page.keyboard.press("Escape");
  await page.keyboard.press("Enter");
  await advance(page, 350);
  await save("countdown");
  await finishCountdown(page);
  await queueAndResolve(page, WIN_ROUTE[0]);
  await advance(page, 100);
  await save("first-guidance");

  for (let index = 1; index < 8; index += 1) await queueAndResolve(page, WIN_ROUTE[index]);
  assert.equal(await page.evaluate((action) => window.__blockstep.queueMove(action), WIN_ROUTE[8]), true);
  const current = await state(page);
  await advance(page, Math.max(0, Math.round(current.secondsUntilNextBeat * 1000) - 200));
  await save("bitcoin-pulse");
  await resolveBeat(page);
  for (let index = 9; index < WIN_ROUTE.length; index += 1) await queueAndResolve(page, WIN_ROUTE[index]);
  await advance(page, 500);
  await save("result");

  assert.deepEqual(errors, []);
  await page.close();
  return hashes;
}

async function runVisualRepeatability() {
  const first = await runRepeatabilityPass("a");
  const second = await runRepeatabilityPass("b");
  assert.deepEqual(second, first, "fixed game states must render byte-identical native Canvas images");
  return first;
}

async function runPerformance() {
  const results = [];
  for (const viewport of PERFORMANCE_VIEWPORTS) {
    const { page, errors } = await openGame(viewport, { manual: false, name: `performance-${viewport.label}` });
    await page.evaluate((route) => {
      const sample = { active: true, deltas: [], lastFrame: null, lastQueuedBeat: 0, timer: null };
      window.__blockstepPerformance = sample;
      const frame = (now) => {
        if (!sample.active) return;
        const gameState = JSON.parse(window.render_game_to_text());
        if (gameState.mode === "playing") {
          if (sample.lastFrame !== null) sample.deltas.push(now - sample.lastFrame);
          sample.lastFrame = now;
        } else {
          sample.lastFrame = null;
        }
        requestAnimationFrame(frame);
      };
      sample.timer = setInterval(() => {
        const gameState = JSON.parse(window.render_game_to_text());
        if (gameState.mode !== "playing") return;
        if (gameState.targetBeat !== sample.lastQueuedBeat) {
          window.__blockstep.queueMove(route[gameState.targetBeat - 1] ?? "stay");
          sample.lastQueuedBeat = gameState.targetBeat;
        }
      }, 10);
      requestAnimationFrame(frame);
    }, WIN_ROUTE);
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).beat >= 5, null, { timeout: 15000 });
    await page.evaluate(() => {
      window.__blockstepPerformance.deltas = [];
      window.__blockstepPerformance.lastFrame = null;
    });
    await page.waitForTimeout(2500);
    await page.locator("#pixel-game-canvas").screenshot({ path: path.join(OUTPUT_DIR, `performance-${viewport.label}.png`) });
    const deltas = await page.evaluate(() => {
      window.__blockstepPerformance.active = false;
      clearInterval(window.__blockstepPerformance.timer);
      return window.__blockstepPerformance.deltas;
    });
    assert.ok(deltas.length >= 80, `${viewport.label} must produce enough live frames`);
    const mean = deltas.reduce((sum, value) => sum + value, 0) / deltas.length;
    const metrics = {
      label: viewport.label,
      samples: deltas.length,
      meanMs: Number(mean.toFixed(2)),
      fps: Number((1000 / mean).toFixed(1)),
      p50Ms: Number(percentile(deltas, 0.5).toFixed(2)),
      p95Ms: Number(percentile(deltas, 0.95).toFixed(2)),
      p99Ms: Number(percentile(deltas, 0.99).toFixed(2)),
      maxMs: Number(Math.max(...deltas).toFixed(2)),
      over25msRatio: Number((deltas.filter((value) => value > 25).length / deltas.length).toFixed(4)),
    };
    assert.ok(metrics.fps >= 40, `${viewport.label} average FPS must remain at least 40`);
    assert.ok(metrics.p95Ms <= 35, `${viewport.label} p95 frame interval must remain <=35ms`);
    assert.ok(metrics.over25msRatio <= 0.1, `${viewport.label} long-frame ratio must remain <=10%`);
    assert.deepEqual(errors, []);
    results.push(metrics);
    await page.close();
  }
  return results;
}

let report;
try {
  const endToEnd = await runEndToEnd();
  const layouts = await runLayoutMatrix();
  const visualHashes = await runVisualRepeatability();
  const performance = await runPerformance();
  const releaseHashes = Object.fromEntries([
    "index.html",
    "src/pixelGame.js",
    "src/pixelGame.css",
    "src/pixelScoreRules.js",
    "contracts/BlockstepScores.sol",
  ].map((file) => [file, hashFile(file)]));
  const browserErrors = allErrors.flatMap(({ name, errors }) => errors.map((error) => `${name}: ${error}`));
  assert.deepEqual(browserErrors, []);

  report = {
    passed: true,
    scope: "desktop browser release QA",
    endToEnd,
    layouts,
    visualHashes,
    performance,
    releaseHashes,
    browserErrors,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, "qa-report.json"), JSON.stringify(report, null, 2));
  console.log("Desktop browser release QA passed.");
} catch (error) {
  report = {
    passed: false,
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    browserErrors: allErrors,
  };
  fs.writeFileSync(path.join(OUTPUT_DIR, "qa-report-failed.json"), JSON.stringify(report, null, 2));
  throw error;
} finally {
  await browser.close();
}
