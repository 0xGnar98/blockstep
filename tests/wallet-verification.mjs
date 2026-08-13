import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

import { chromium } from "playwright";
import { privateKeyToAccount } from "viem/accounts";

import { BLOCKSTEP_MAINNET } from "../src/blockstepConfig.js";
import { buildRunTypedData } from "../src/scoreProof.js";

const BASE_URL = process.env.BLOCKSTEP_URL || "http://127.0.0.1:4173";
const OUTPUT_DIR = path.resolve("artifacts/wallet-verification-qa");
const NOW_MS = 1_900_000_000_000;
const CHALLENGE = Object.freeze({
  bitcoinHeight: 912845,
  bitcoinBlockHash: "0x00000000000000000000000000000000000000000000000000000000000dedcd",
  latestHeight: 912846,
  expiresAfterHeight: 912850,
});
const WIN_ROUTE = [
  "up", "up", "right", "stay", "stay", "stay", "right", "stay", "stay",
  "stay", "left", "down", "right", "stay", "stay", "stay", "left", "stay",
  "down", "up", "down", "stay", "left", "up", "right", "left", "stay",
  "right", "up", "down", "stay", "down", "left", "down", "up", "stay",
];
const account = privateKeyToAccount(`0x${"31".repeat(32)}`);

fs.mkdirSync(OUTPUT_DIR, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=angle", "--use-angle=swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1680, height: 945 } });
const errors = [];
const relayerRequests = [];
page.on("console", (message) => {
  if (message.type() === "error") errors.push(`console: ${message.text()}`);
});
page.on("pageerror", (error) => errors.push(`pageerror: ${String(error)}`));

await page.addInitScript(({ address, chainId, nowMs }) => {
  Date.now = () => nowMs;
  window.__verificationTest = { signature: null, walletCalls: [] };
  window.ethereum = {
    async request(request) {
      window.__verificationTest.walletCalls.push(request.method);
      if (request.method === "eth_requestAccounts") return [address];
      if (request.method === "eth_chainId") return chainId;
      if (request.method === "eth_signTypedData_v4") {
        if (!window.__verificationTest.signature) throw new Error("test signature not prepared");
        window.__verificationTest.typedData = JSON.parse(request.params[1]);
        return window.__verificationTest.signature;
      }
      throw new Error(`unexpected wallet method ${request.method}`);
    },
  };
}, { address: account.address, chainId: BLOCKSTEP_MAINNET.chainIdHex, nowMs: NOW_MS });

await page.route("**/api/challenge", async (route) => {
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      challenge: CHALLENGE,
      chainId: BLOCKSTEP_MAINNET.chainId,
      contractAddress: BLOCKSTEP_MAINNET.scoreContractAddress,
    }),
  });
});
await page.route("**/api/verify", async (route) => {
  relayerRequests.push(JSON.parse(route.request().postData() ?? "{}"));
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      transactionHash: `0x${"ab".repeat(32)}`,
      blockNumber: "5057000",
      score: 1585,
      explorerUrl: `${BLOCKSTEP_MAINNET.explorerUrl}/tx/0x${"ab".repeat(32)}`,
    }),
  });
});

try {
  await page.goto(`${BASE_URL}/?manual=1`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector("#game-frame")?.dataset.ready === "true");
  const readState = () => page.evaluate(() => JSON.parse(window.render_game_to_text()));
  const advance = (milliseconds) => page.evaluate((amount) => window.advanceTime(amount), milliseconds);

  let state = await readState();
  assert.equal(state.network, "live");
  assert.equal(state.currentBlock, CHALLENGE.bitcoinHeight);
  assert.equal(state.verification.challengeEligible, true);
  assert.equal(state.verificationCanSubmit, false);

  await page.keyboard.press("Enter");
  await advance(2_402);
  for (const action of WIN_ROUTE) {
    assert.equal(await page.evaluate((next) => window.__blockstep.queueMove(next), action), true);
    state = await readState();
    await advance(Math.ceil(state.secondsUntilNextBeat * 1000) + 2);
  }

  state = await readState();
  assert.equal(state.mode, "won");
  assert.equal(state.score, 1585);
  assert.equal(state.verificationCanSubmit, true);
  assert.equal(state.audio.unlocked, true);
  const deadline = BigInt(Math.floor(NOW_MS / 1000) + 5 * 60);
  const signature = await account.signTypedData(buildRunTypedData({
    player: account.address,
    proof: state.proof,
    contractAddress: BLOCKSTEP_MAINNET.scoreContractAddress,
    deadline,
  }));
  await page.evaluate((value) => { window.__verificationTest.signature = value; }, signature);

  await page.keyboard.press("v");
  assert.equal((await readState()).activePanel, "verification");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).verification.state === "verified");
  state = await readState();
  assert.equal(state.verification.state, "verified");
  assert.equal(state.verification.player, account.address);
  assert.equal(state.verification.transactionHash, `0x${"ab".repeat(32)}`);
  assert.equal(relayerRequests.length, 1);
  assert.equal(relayerRequests[0].player, account.address);
  assert.equal(relayerRequests[0].bitcoinHeight, CHALLENGE.bitcoinHeight);
  assert.equal(relayerRequests[0].packedMoves, state.proof.packedMoves);
  assert.equal(relayerRequests[0].signature, signature);

  await page.keyboard.press("m");
  assert.equal((await readState()).audio.muted, true);
  await page.keyboard.press("m");
  assert.equal((await readState()).audio.muted, false);

  await page.locator("#pixel-game-canvas").screenshot({ path: path.join(OUTPUT_DIR, "verified-score.png") });
  fs.writeFileSync(path.join(OUTPUT_DIR, "verified-score.json"), JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(OUTPUT_DIR, "relayer-request.json"), JSON.stringify(relayerRequests[0], null, 2));
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({
    checks: 18,
    score: state.score,
    walletCalls: await page.evaluate(() => window.__verificationTest.walletCalls),
    relayerRequests: relayerRequests.length,
    externalWrites: 0,
  }, null, 2));
} finally {
  await browser.close();
}

