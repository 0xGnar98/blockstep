import test from "node:test";
import assert from "node:assert/strict";

import { privateKeyToAccount } from "viem/accounts";

import { BLOCKSTEP_MAINNET } from "../src/blockstepConfig.js";
import { buildRunTypedData } from "../src/scoreProof.js";
import {
  createBlockstepRelayer,
  createInMemoryRateLimiter,
} from "../worker/blockstepRelayer.js";

const NOW_MS = 1_900_000_000_000;
const NOW_SECONDS = Math.floor(NOW_MS / 1000);
const player = privateKeyToAccount(`0x${"21".repeat(32)}`);
const bitcoinHeight = 1_000_004;
const packedMoves = "0x0000025c6194223035224524d3283288";

async function signedBody(overrides = {}) {
  const deadline = BigInt(NOW_SECONDS + 300);
  const typedData = buildRunTypedData({
    player: player.address,
    proof: { bitcoinHeight, packedMoves },
    contractAddress: BLOCKSTEP_MAINNET.scoreContractAddress,
    deadline,
  });
  return {
    player: player.address,
    bitcoinHeight,
    packedMoves,
    deadline: deadline.toString(),
    signature: await player.signTypedData(typedData),
    ...overrides,
  };
}

function service(overrides = {}) {
  const calls = [];
  return {
    calls,
    async getChallenge() {
      calls.push("challenge");
      return {
        bitcoinHeight,
        bitcoinBlockHash: `0x${"31".repeat(32)}`,
        latestHeight: bitcoinHeight + 1,
        expiresAfterHeight: bitcoinHeight + 5,
      };
    },
    async getLatestHeight() {
      calls.push("latest");
      return bitcoinHeight + 1;
    },
    async submitRunFor(input) {
      calls.push({ submit: input });
      return { transactionHash: `0x${"ab".repeat(32)}`, blockNumber: "5057000", score: 865 };
    },
    ...overrides,
  };
}

function request(path, { method = "GET", body, origin = "https://game.example" } = {}) {
  const headers = { origin };
  if (body !== undefined) headers["content-type"] = "application/json";
  return new Request(`https://game.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test("the relayer exposes only a read-only challenge and one fixed verification method", async () => {
  const chain = service();
  const handle = createBlockstepRelayer({ service: chain, now: () => NOW_MS });
  const challengeResponse = await handle(request("/api/challenge"));
  assert.equal(challengeResponse.status, 200);
  const challenge = await challengeResponse.json();
  assert.equal(challenge.contractAddress, BLOCKSTEP_MAINNET.scoreContractAddress);
  assert.equal(challenge.challenge.bitcoinHeight, bitcoinHeight);

  const unknown = await handle(request("/api/send-transaction", { method: "POST", body: {} }));
  assert.equal(unknown.status, 404);
  const wrongMethod = await handle(request("/api/verify"));
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(chain.calls, ["challenge"]);
});

test("a valid player signature reaches exactly one simulated relayer submission", async () => {
  const chain = service();
  const handle = createBlockstepRelayer({ service: chain, now: () => NOW_MS });
  const response = await handle(request("/api/verify", { method: "POST", body: await signedBody() }));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.score, 865);
  assert.equal(result.player, player.address);
  assert.match(result.explorerUrl, /explorer\.hemi\.xyz\/tx\/0x/);
  assert.equal(chain.calls.filter((entry) => typeof entry === "object").length, 1);
  assert.equal(chain.calls[0], "latest");
});

test("unexpected fields and non-canonical upper proof bits fail before chain access", async () => {
  const chain = service();
  const handle = createBlockstepRelayer({ service: chain, now: () => NOW_MS });
  const extra = await handle(request("/api/verify", {
    method: "POST",
    body: { ...(await signedBody()), transaction: { to: player.address } },
  }));
  assert.equal(extra.status, 400);
  const aliased = await handle(request("/api/verify", {
    method: "POST",
    body: await signedBody({ packedMoves: `0x${(1n << 108n).toString(16)}` }),
  }));
  assert.equal(aliased.status, 400);
  assert.deepEqual(chain.calls, []);
});

test("wrong signers, stale heights, and non-allowlisted origins cannot spend relayer gas", async () => {
  const chain = service({ getLatestHeight: async () => bitcoinHeight + 6 });
  const handle = createBlockstepRelayer({
    service: chain,
    now: () => NOW_MS,
    allowedOrigins: ["https://game.example"],
  });
  const wrongSignature = await handle(request("/api/verify", {
    method: "POST",
    body: await signedBody({ signature: `0x${"11".repeat(65)}` }),
  }));
  assert.equal(wrongSignature.status, 401);
  const stale = await handle(request("/api/verify", { method: "POST", body: await signedBody() }));
  assert.equal(stale.status, 409);
  const wrongOrigin = await handle(request("/api/verify", {
    method: "POST",
    body: await signedBody(),
    origin: "https://attacker.example",
  }));
  assert.equal(wrongOrigin.status, 403);
  assert.equal(chain.calls.some((entry) => typeof entry === "object"), false);
});

test("per-player rate limiting stops the third local attempt before submission", async () => {
  const chain = service();
  const handle = createBlockstepRelayer({
    service: chain,
    now: () => NOW_MS,
    rateLimiter: createInMemoryRateLimiter({ limit: 2, now: () => NOW_MS }),
  });
  const body = await signedBody();
  assert.equal((await handle(request("/api/verify", { method: "POST", body }))).status, 200);
  assert.equal((await handle(request("/api/verify", { method: "POST", body }))).status, 200);
  assert.equal((await handle(request("/api/verify", { method: "POST", body }))).status, 429);
  assert.equal(chain.calls.filter((entry) => typeof entry === "object").length, 2);
});
