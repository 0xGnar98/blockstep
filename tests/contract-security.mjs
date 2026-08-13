import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  createPublicClient,
  createWalletClient,
  decodeErrorResult,
  defineChain,
  encodeAbiParameters,
  encodePacked,
  http,
  keccak256,
  parseEventLogs,
  parseEther,
  toHex,
  zeroAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

import {
  COMPILER_SETTINGS,
  MOCK_CONTRACT_NAME,
  MOCK_SOURCE_NAME,
  SCORE_CONTRACT_NAME,
  SCORE_SOURCE_NAME,
  buildArtifact,
  compileInput,
  compilerVersion,
  createCompilerInput,
  getCompiledContract,
  prefixedBytecode,
} from "../scripts/contract-build-config.mjs";
import { serializeMoves } from "../src/gameLogic.js";
import { buildRunTypedData } from "../src/scoreProof.js";

const ROOT = process.cwd();
const BITCOIN_KIT = "0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12";
const CHAIN_ID = 43111;
const ARTIFACT_DIRECTORY = path.join(ROOT, "artifacts", "contract-security");
const REPORT_PATH = path.join(ARTIFACT_DIRECTORY, "local-evm-report.json");
const HARDHAT_CLI = path.join(ROOT, "node_modules", "hardhat", "dist", "src", "cli.js");

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
const STAY_ROUTE = Array.from({ length: 36 }, () => "stay");
const DOUBLE_FLIP_ROUTE = [...WIN_ROUTE];
DOUBLE_FLIP_ROUTE[0] = "flip";
DOUBLE_FLIP_ROUTE[5] = "flip";

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
const LATEST_HEADER = {
  number: 912850,
  hash: keccak256(toHex("blockstep-latest-912850")),
};
const STALE_HEADER = {
  number: 912844,
  hash: keccak256(toHex("blockstep-stale-912844")),
};

function privateKey(index) {
  return `0x${BigInt(index).toString(16).padStart(64, "0")}`;
}

const accounts = {
  deployer: privateKeyToAccount(privateKey(101)),
  directPlayer: privateKeyToAccount(privateKey(102)),
  sponsoredPlayer: privateKeyToAccount(privateKey(103)),
  scorePlayer: privateKeyToAccount(privateKey(104)),
  relayer: privateKeyToAccount(privateKey(105)),
  outsider: privateKeyToAccount(privateKey(106)),
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function rpc(url, method, params = []) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const payload = await response.json();
  if (payload.error) {
    const error = new Error(`${method}: ${payload.error.message}`);
    error.rpcData = payload.error.data;
    throw error;
  }
  return payload.result;
}

async function waitForRpc(url, child, output) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (child.exitCode !== null) {
      throw new Error(`Hardhat exited before RPC readiness.\n${output.join("")}`);
    }
    try {
      const chainId = await rpc(url, "eth_chainId");
      if (chainId) return chainId;
    } catch {
      // The local server is still starting.
    }
    await sleep(100);
  }
  throw new Error(`Hardhat RPC did not become ready.\n${output.join("")}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  child.kill();
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(2_000),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

function normalizeRun(result) {
  return {
    score: Number(result.score ?? result[0]),
    lives: Number(result.lives ?? result[1]),
    hits: Number(result.hits ?? result[2]),
    shards: Number(result.shards ?? result[3]),
    closeCalls: Number(result.closeCalls ?? result[4]),
    beatsSurvived: Number(result.beatsSurvived ?? result[5]),
    flipUnused: Boolean(result.flipUnused ?? result[6]),
    cleared: Boolean(result.cleared ?? result[7]),
  };
}

function nestedErrorName(error) {
  let current = error;
  for (let depth = 0; current && depth < 12; depth += 1) {
    if (current.data?.errorName) return current.data.errorName;
    if (current.errorName) return current.errorName;
    if (typeof current.data === "string" && current.data.startsWith("0x")) {
      try {
        return decodeErrorResult({ abi: scoreArtifact.abi, data: current.data }).errorName;
      } catch {
        // Continue through the cause chain.
      }
    }
    current = current.cause;
  }
  const match = String(error?.message ?? error).match(
    /(?:reverted with custom error|errorName[:=]|Error:)\s*["']?([A-Za-z0-9_]+)/,
  );
  return match?.[1] ?? null;
}

async function expectCustomError(expected, action) {
  try {
    await action();
    assert.fail(`Expected custom error ${expected}`);
  } catch (error) {
    if (error?.code === "ERR_ASSERTION") throw error;
    const actual = nestedErrorName(error);
    assert.equal(actual, expected, `Unexpected revert: ${error?.shortMessage ?? error?.message}`);
  }
}

function domainSeparator(contractAddress) {
  const typeHash = keccak256(
    toHex("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
  );
  return keccak256(encodeAbiParameters(
    [
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "bytes32" },
      { type: "uint256" },
      { type: "address" },
    ],
    [
      typeHash,
      keccak256(toHex("BLOCKSTEP Scores")),
      keccak256(toHex("1")),
      BigInt(CHAIN_ID),
      contractAddress,
    ],
  ));
}

function proofId(player, bitcoinHeight, packedMoves) {
  return keccak256(encodePacked(
    ["address", "uint32", "uint128"],
    [player, bitcoinHeight, packedMoves],
  ));
}

function safeGasCeiling(value) {
  return (value * 135n + 99n) / 100n;
}

function maskImmutables(bytecode, immutableReferences) {
  const bytes = Buffer.from(bytecode.slice(2), "hex");
  for (const references of Object.values(immutableReferences)) {
    for (const { start, length } of references) {
      bytes.fill(0, start, start + length);
    }
  }
  return `0x${bytes.toString("hex")}`;
}

const compilerInput = createCompilerInput({ includeMock: true });
const { output: compilerOutput } = compileInput(compilerInput);
const compiledScore = getCompiledContract(
  compilerOutput,
  SCORE_SOURCE_NAME,
  SCORE_CONTRACT_NAME,
);
const compiledMock = getCompiledContract(
  compilerOutput,
  MOCK_SOURCE_NAME,
  MOCK_CONTRACT_NAME,
);
const scoreArtifact = buildArtifact(
  compiledScore,
  compilerInput.sources[SCORE_SOURCE_NAME].content,
);
const mockAbi = compiledMock.abi;
const mockRuntime = prefixedBytecode(compiledMock.evm.deployedBytecode.object);

const cases = [];
async function check(name, action) {
  await action();
  cases.push({ name, passed: true });
}

let hardhat;
const hardhatOutput = [];

try {
  fs.mkdirSync(ARTIFACT_DIRECTORY, { recursive: true });
  const port = await getFreePort();
  assert.ok(port, "Failed to reserve a local RPC port");
  const rpcUrl = `http://127.0.0.1:${port}`;

  hardhat = spawn(
    process.execPath,
    [
      HARDHAT_CLI,
      "--network",
      "blockstepLocal",
      "node",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  hardhat.stdout.on("data", (chunk) => hardhatOutput.push(chunk.toString()));
  hardhat.stderr.on("data", (chunk) => hardhatOutput.push(chunk.toString()));

  const rpcChainId = await waitForRpc(rpcUrl, hardhat, hardhatOutput);
  assert.equal(Number(BigInt(rpcChainId)), CHAIN_ID);

  const localHemi = defineChain({
    id: CHAIN_ID,
    name: "BLOCKSTEP Local Security",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
  const publicClient = createPublicClient({
    chain: localHemi,
    transport: http(rpcUrl, { retryCount: 0 }),
  });
  const wallets = Object.fromEntries(Object.entries(accounts).map(([name, account]) => [
    name,
    createWalletClient({ account, chain: localHemi, transport: http(rpcUrl, { retryCount: 0 }) }),
  ]));

  for (const account of Object.values(accounts)) {
    await rpc(rpcUrl, "hardhat_setBalance", [account.address, toHex(parseEther("100"))]);
  }
  await rpc(rpcUrl, "hardhat_setCode", [BITCOIN_KIT, mockRuntime]);
  assert.equal(await publicClient.getBytecode({ address: BITCOIN_KIT }), mockRuntime);

  async function send(wallet, request) {
    const hash = await wallet.writeContract(request);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
    return receipt;
  }

  for (const block of [...BLOCKS, STALE_HEADER]) {
    await send(wallets.deployer, {
      address: BITCOIN_KIT,
      abi: mockAbi,
      functionName: "setHeader",
      args: [block.number, block.hash],
    });
  }
  await send(wallets.deployer, {
    address: BITCOIN_KIT,
    abi: mockAbi,
    functionName: "setLastHeader",
    args: [LATEST_HEADER.number, LATEST_HEADER.hash],
  });

  const deploymentEstimate = await publicClient.estimateGas({
    account: accounts.deployer.address,
    data: scoreArtifact.bytecode,
  });
  const deploymentHash = await wallets.deployer.deployContract({
    abi: scoreArtifact.abi,
    bytecode: scoreArtifact.bytecode,
  });
  const deploymentReceipt = await publicClient.waitForTransactionReceipt({ hash: deploymentHash });
  assert.equal(deploymentReceipt.status, "success");
  assert.ok(deploymentReceipt.contractAddress);
  const contractAddress = deploymentReceipt.contractAddress;

  await check("compiler, chain, bytecode, and immutable wiring are exact", async () => {
    assert.equal(compilerVersion(), "0.8.30+commit.73712a01.Emscripten.clang");
    assert.deepEqual(COMPILER_SETTINGS, {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "paris",
    });
    assert.equal(await publicClient.getChainId(), CHAIN_ID);
    const deployedCode = await publicClient.getBytecode({ address: contractAddress });
    assert.ok(deployedCode);
    assert.equal(
      keccak256(maskImmutables(deployedCode, scoreArtifact.build.immutableReferences)),
      scoreArtifact.build.runtimeTemplateCodeHash,
    );
    assert.equal(await publicClient.readContract({
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "BITCOIN_KIT",
    }), BITCOIN_KIT);
    assert.equal(Number(await publicClient.readContract({
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "PACKED_MOVE_BITS",
    })), 108);
    assert.equal(Number(await publicClient.readContract({
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "SUBMISSION_HEIGHT_WINDOW",
    })), 6);
    assert.equal(await publicClient.readContract({
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "DOMAIN_SEPARATOR",
    }), domainSeparator(contractAddress));
  });

  const packedWin = serializeMoves(WIN_ROUTE);
  const packedOneHit = serializeMoves(ONE_HIT_ROUTE);
  const packedTwoHit = serializeMoves(TWO_HIT_ROUTE);
  const packedStay = serializeMoves(STAY_ROUTE);
  const packedDoubleFlip = serializeMoves(DOUBLE_FLIP_ROUTE);

  async function verify(height, packedMoves) {
    const [result, blockHash] = await publicClient.readContract({
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "verifyRun",
      args: [height, packedMoves],
    });
    return { result: normalizeRun(result), blockHash };
  }

  await check("valid zero-, one-, and two-hit clears replay to exact scores", async () => {
    assert.deepEqual((await verify(BLOCKS[0].number, packedWin)).result, {
      score: 1585,
      lives: 3,
      hits: 0,
      shards: 8,
      closeCalls: 32,
      beatsSurvived: 36,
      flipUnused: true,
      cleared: true,
    });
    assert.equal((await verify(BLOCKS[0].number, packedOneHit)).result.score, 1120);
    assert.equal((await verify(BLOCKS[0].number, packedTwoHit)).result.score, 990);
  });

  await check("failed runs remain readable but cannot be submitted", async () => {
    const failed = (await verify(BLOCKS[0].number, packedStay)).result;
    assert.equal(failed.cleared, false);
    assert.ok(failed.beatsSurvived < 36);
    await expectCustomError("RunNotCleared", () => publicClient.simulateContract({
      account: accounts.directPlayer.address,
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "submitRun",
      args: [BLOCKS[0].number, packedStay],
    }));
  });

  await check("missing Bitcoin headers and malformed move codes are rejected", async () => {
    await expectCustomError("BitcoinHeaderUnavailable", () => verify(999_999, packedWin));
    const malformed = packedWin | (7n << 12n);
    await expectCustomError("InvalidMove", () => verify(BLOCKS[0].number, malformed));
  });

  await check("only the first Hemi Flip is consumed", async () => {
    const result = (await verify(BLOCKS[0].number, packedDoubleFlip)).result;
    assert.equal(result.flipUnused, false);
    assert.ok(result.beatsSurvived > 0);
  });

  await check("historical reads remain available while writes use exactly the latest six heights", async () => {
    assert.equal(STALE_HEADER.number, LATEST_HEADER.number - 6);
    assert.equal(BLOCKS[0].number, LATEST_HEADER.number - 5);

    await verify(STALE_HEADER.number, packedWin);
    await verify(BLOCKS[2].number, packedWin);

    const oldestAccepted = await publicClient.simulateContract({
      account: accounts.directPlayer.address,
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "submitRun",
      args: [BLOCKS[0].number, packedWin],
    });
    assert.equal(Number(oldestAccepted.result), 1585);

    for (const rejectedHeight of [STALE_HEADER.number, BLOCKS[2].number]) {
      await expectCustomError("StaleBitcoinHeader", () => publicClient.simulateContract({
        account: accounts.directPlayer.address,
        address: contractAddress,
        abi: scoreArtifact.abi,
        functionName: "submitRun",
        args: [rejectedHeight, packedWin],
      }));
    }

    await send(wallets.deployer, {
      address: BITCOIN_KIT,
      abi: mockAbi,
      functionName: "clearHeader",
      args: [LATEST_HEADER.number],
    });
    await expectCustomError("BitcoinHeaderUnavailable", () => publicClient.simulateContract({
      account: accounts.directPlayer.address,
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "submitRun",
      args: [BLOCKS[0].number, packedWin],
    }));
    await send(wallets.deployer, {
      address: BITCOIN_KIT,
      abi: mockAbi,
      functionName: "setLastHeader",
      args: [LATEST_HEADER.number, LATEST_HEADER.hash],
    });
  });

  let directReceipt;
  await check("direct submission records the caller, event, proof, and best run", async () => {
    directReceipt = await send(wallets.directPlayer, {
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "submitRun",
      args: [BLOCKS[0].number, packedWin],
    });
    const events = parseEventLogs({
      abi: scoreArtifact.abi,
      logs: directReceipt.logs,
      eventName: "RunVerified",
      strict: true,
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].args.player, accounts.directPlayer.address);
    assert.equal(Number(events[0].args.score), 1585);
    assert.equal(await publicClient.readContract({
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "proofUsed",
      args: [proofId(accounts.directPlayer.address, BLOCKS[0].number, packedWin)],
    }), true);
    const best = await publicClient.readContract({
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "bestRunByPlayer",
      args: [accounts.directPlayer.address],
    });
    assert.equal(Number(best[0]), 1585);
  });

  const latestBlock = await publicClient.getBlock();
  const deadline = latestBlock.timestamp + 600n;
  const sponsoredTypedData = buildRunTypedData({
    player: accounts.sponsoredPlayer.address,
    proof: {
      bitcoinHeight: BLOCKS[0].number,
      packedMoves: packedWin.toString(),
    },
    contractAddress,
    deadline,
  });
  const sponsoredSignature = await accounts.sponsoredPlayer.signTypedData(sponsoredTypedData);
  const sponsoredArgs = [
    accounts.sponsoredPlayer.address,
    BLOCKS[0].number,
    packedWin,
    deadline,
    sponsoredSignature,
  ];
  const sponsoredEstimate = await publicClient.estimateContractGas({
    account: accounts.relayer.address,
    address: contractAddress,
    abi: scoreArtifact.abi,
    functionName: "submitRunFor",
    args: sponsoredArgs,
  });

  let sponsoredReceipt;
  await check("EIP-712 sponsored submission attributes the score to the signer", async () => {
    sponsoredReceipt = await send(wallets.relayer, {
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "submitRunFor",
      args: sponsoredArgs,
    });
    const playerBest = await publicClient.readContract({
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "bestRunByPlayer",
      args: [accounts.sponsoredPlayer.address],
    });
    const relayerBest = await publicClient.readContract({
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "bestRunByPlayer",
      args: [accounts.relayer.address],
    });
    assert.equal(Number(playerBest[0]), 1585);
    assert.equal(Number(relayerBest[0]), 0);
  });

  await check("sponsored submissions enforce the same six-height write window", async () => {
    const staleTypedData = buildRunTypedData({
      player: accounts.sponsoredPlayer.address,
      proof: {
        bitcoinHeight: STALE_HEADER.number,
        packedMoves: packedWin.toString(),
      },
      contractAddress,
      deadline,
    });
    const staleSignature = await accounts.sponsoredPlayer.signTypedData(staleTypedData);
    await expectCustomError("StaleBitcoinHeader", () => publicClient.simulateContract({
      account: accounts.relayer.address,
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "submitRunFor",
      args: [
        accounts.sponsoredPlayer.address,
        STALE_HEADER.number,
        packedWin,
        deadline,
        staleSignature,
      ],
    }));
  });

  await check("the same direct or sponsored proof cannot be reused", async () => {
    await expectCustomError("ProofAlreadyUsed", () => publicClient.simulateContract({
      account: accounts.directPlayer.address,
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "submitRun",
      args: [BLOCKS[0].number, packedWin],
    }));
    await expectCustomError("ProofAlreadyUsed", () => publicClient.simulateContract({
      account: accounts.relayer.address,
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "submitRunFor",
      args: sponsoredArgs,
    }));
  });

  await check("all twenty unused upper move bits are rejected on every proof path", async () => {
    for (let bit = 108n; bit < 128n; bit += 1n) {
      const aliasedMoves = packedWin | (1n << bit);
      assert.notEqual(aliasedMoves, packedWin);
      assert.notEqual(
        proofId(accounts.directPlayer.address, BLOCKS[0].number, aliasedMoves),
        proofId(accounts.directPlayer.address, BLOCKS[0].number, packedWin),
      );
      await expectCustomError("NonCanonicalMoves", () => verify(BLOCKS[0].number, aliasedMoves));
      await expectCustomError("NonCanonicalMoves", () => publicClient.simulateContract({
        account: accounts.directPlayer.address,
        address: contractAddress,
        abi: scoreArtifact.abi,
        functionName: "submitRun",
        args: [BLOCKS[0].number, aliasedMoves],
      }));
    }

    const sponsoredAlias = packedWin | (1n << 108n);
    const aliasTypedData = buildRunTypedData({
      player: accounts.sponsoredPlayer.address,
      proof: {
        bitcoinHeight: BLOCKS[0].number,
        packedMoves: sponsoredAlias.toString(),
      },
      contractAddress,
      deadline,
    });
    const aliasSignature = await accounts.sponsoredPlayer.signTypedData(aliasTypedData);
    await expectCustomError("NonCanonicalMoves", () => publicClient.simulateContract({
      account: accounts.relayer.address,
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "submitRunFor",
      args: [
        accounts.sponsoredPlayer.address,
        BLOCKS[0].number,
        sponsoredAlias,
        deadline,
        aliasSignature,
      ],
    }));
  });

  await check("expired, wrong-signer, wrong-domain, and malformed signatures fail", async () => {
    const expiredDeadline = 1n;
    const expiredData = buildRunTypedData({
      player: accounts.sponsoredPlayer.address,
      proof: { bitcoinHeight: BLOCKS[0].number, packedMoves: packedOneHit.toString() },
      contractAddress,
      deadline: expiredDeadline,
    });
    const expiredSignature = await accounts.sponsoredPlayer.signTypedData(expiredData);
    await expectCustomError("SignatureExpired", () => publicClient.simulateContract({
      account: accounts.relayer.address,
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "submitRunFor",
      args: [
        accounts.sponsoredPlayer.address,
        BLOCKS[0].number,
        packedOneHit,
        expiredDeadline,
        expiredSignature,
      ],
    }));

    const wrongSigner = await accounts.outsider.signTypedData(sponsoredTypedData);
    await expectCustomError("InvalidSignature", () => publicClient.simulateContract({
      account: accounts.relayer.address,
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "submitRunFor",
      args: [...sponsoredArgs.slice(0, 4), wrongSigner],
    }));

    const wrongDomain = {
      ...sponsoredTypedData,
      domain: { ...sponsoredTypedData.domain, chainId: 1 },
    };
    const wrongDomainSignature = await accounts.sponsoredPlayer.signTypedData(wrongDomain);
    await expectCustomError("InvalidSignature", () => publicClient.simulateContract({
      account: accounts.relayer.address,
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "submitRunFor",
      args: [...sponsoredArgs.slice(0, 4), wrongDomainSignature],
    }));

    await expectCustomError("InvalidSignature", () => publicClient.simulateContract({
      account: accounts.relayer.address,
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "submitRunFor",
      args: [...sponsoredArgs.slice(0, 4), "0x1234"],
    }));
  });

  await check("best score updates upward and ignores later lower valid clears", async () => {
    await send(wallets.scorePlayer, {
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "submitRun",
      args: [BLOCKS[0].number, packedOneHit],
    });
    let best = await publicClient.readContract({
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "bestRunByPlayer",
      args: [accounts.scorePlayer.address],
    });
    assert.equal(Number(best[0]), 1120);

    await send(wallets.scorePlayer, {
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "submitRun",
      args: [BLOCKS[0].number, packedWin],
    });
    best = await publicClient.readContract({
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "bestRunByPlayer",
      args: [accounts.scorePlayer.address],
    });
    assert.equal(Number(best[0]), 1585);

    await send(wallets.scorePlayer, {
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "submitRun",
      args: [BLOCKS[0].number, packedTwoHit],
    });
    best = await publicClient.readContract({
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "bestRunByPlayer",
      args: [accounts.scorePlayer.address],
    });
    assert.equal(Number(best[0]), 1585);
    assert.equal(Number(await publicClient.readContract({
      address: contractAddress,
      abi: scoreArtifact.abi,
      functionName: "totalVerifiedRuns",
    })), 5);
  });

  await check("ABI and source expose no owner, upgrade, withdrawal, value, or arbitrary-call path", async () => {
    const forbiddenFunctions = new Set([
      "owner",
      "transferOwnership",
      "upgradeTo",
      "upgradeToAndCall",
      "withdraw",
      "execute",
      "multicall",
    ]);
    const functions = scoreArtifact.abi.filter((entry) => entry.type === "function");
    assert.equal(functions.some((entry) => forbiddenFunctions.has(entry.name)), false);
    assert.equal(functions.some((entry) => entry.stateMutability === "payable"), false);
    const source = compilerInput.sources[SCORE_SOURCE_NAME].content;
    for (const pattern of [/delegatecall/i, /selfdestruct/i, /call\s*\{\s*value/i]) {
      assert.equal(pattern.test(source), false, `Forbidden source pattern ${pattern}`);
    }
    assert.equal(zeroAddress === contractAddress, false);
  });

  const deploymentGasUsed = deploymentReceipt.gasUsed;
  const sponsoredGasUsed = sponsoredReceipt.gasUsed;
  const report = {
    passed: true,
    scope: "local contract security suite",
    externalActions: {
      mainnetRpcCalls: 0,
      deployments: 0,
      gasSpent: 0,
      credentialsUsed: 0,
    },
    localEvm: {
      tool: "Hardhat",
      version: "3.11.1",
      chainId: CHAIN_ID,
      hardfork: "cancun",
      bitcoinKitAddress: BITCOIN_KIT,
      localContractAddress: contractAddress,
    },
    build: {
      compiler: compilerVersion(),
      settings: COMPILER_SETTINGS,
      sourceHash: scoreArtifact.build.sourceHash,
      creationCodeHash: scoreArtifact.build.creationCodeHash,
      runtimeTemplateCodeHash: scoreArtifact.build.runtimeTemplateCodeHash,
      localDeployedRuntimeCodeHash: keccak256(
        await publicClient.getBytecode({ address: contractAddress }),
      ),
      immutableReferences: scoreArtifact.build.immutableReferences,
      creationBytes: scoreArtifact.build.creationBytes,
      runtimeBytes: scoreArtifact.build.runtimeBytes,
    },
    cases,
    gas: {
      unitsOnly: true,
      warning: "Local EVM gas units are a readiness estimate, not a Hemi fee quote.",
      deployment: {
        estimated: deploymentEstimate.toString(),
        used: deploymentGasUsed.toString(),
        recommendedLimit: safeGasCeiling(
          deploymentEstimate > deploymentGasUsed ? deploymentEstimate : deploymentGasUsed,
        ).toString(),
      },
      sponsoredVerification: {
        estimated: sponsoredEstimate.toString(),
        used: sponsoredGasUsed.toString(),
        recommendedLimit: safeGasCeiling(
          sponsoredEstimate > sponsoredGasUsed ? sponsoredEstimate : sponsoredGasUsed,
        ).toString(),
      },
      fundingFormula: "required wei = configured gas limit * live Hemi maxFeePerGas",
    },
    dependencyAudit: {
      hardhat: "3.11.1 exact",
      solc: "0.8.30 exact",
      admZipOverride: "0.6.0",
      npmVulnerabilitiesAfterInstall: 0,
    },
    findings: [
      {
        id: "SEC-001",
        severity: "high for a sponsored relayer; medium for score integrity",
        status: "RESOLVED LOCALLY - canonical 108-bit guard applied and tested",
        title: "Twenty unused uint128 bits create replay aliases",
        evidence: "verifyRun, submitRun, and submitRunFor reject each tested upper-bit alias with NonCanonicalMoves before replay or proof storage; all bits 108-127 are covered.",
        recommendation: "Applied: keep PACKED_MOVE_BITS fixed at 108 unless TOTAL_BEATS or move encoding changes.",
      },
      {
        id: "FAIR-001",
        severity: "medium product-integrity risk",
        status: "RESOLVED LOCALLY - six-height write window applied and tested",
        title: "Any historical Bitcoin height is eligible for the all-time best score",
        evidence: "verifyRun still reads available historical heights, while submitRun and submitRunFor accept only latestHeight through latestHeight - 5 and reject both older and future heights.",
        recommendation: "Applied: preserve SUBMISSION_HEIGHT_WINDOW at six and serve latest - 1 from the verification challenge endpoint.",
      },
      {
        id: "REL-001",
        severity: "low-to-medium reliability risk",
        status: "MITIGATED IN VERIFICATION SERVICE",
        title: "The current client selects the latest Bitcoin header",
        evidence: "A shallow Bitcoin reorganization between play and submission can change the canonical hash at the signed height.",
        recommendation: "Serve a confirmed recent header from /api/challenge and keep it inside the contract's configured recency window.",
      },
      {
        id: "BUILD-001",
        severity: "resolved",
        status: "RESOLVED",
        title: "Compiler and EVM target were previously floating",
        evidence: "The installed compiler had drifted to 0.8.36 and no evmVersion was explicit.",
        recommendation: "Applied: exact solc 0.8.30, optimizer 200, viaIR true, evmVersion paris.",
      },
      {
        id: "BUILD-002",
        severity: "resolved",
        status: "RESOLVED",
        title: "Compile-time runtime hash did not account for immutable patching",
        evidence: "DOMAIN_SEPARATOR is patched into runtime code at deployment.",
        recommendation: "Applied: manifest now records creation hash, runtime-template hash, immutable references, and the local deployed runtime hash separately.",
      },
    ],
  };

  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Contract security: ${cases.length}/${cases.length} security cases passed`);
  console.log(`Contract: ${scoreArtifact.build.creationBytes} bytes ${scoreArtifact.build.creationCodeHash}`);
  console.log(
    `Gas units: deploy ${deploymentGasUsed}/${report.gas.deployment.recommendedLimit}, sponsored ${sponsoredGasUsed}/${report.gas.sponsoredVerification.recommendedLimit}`,
  );
  console.log(`Report: ${REPORT_PATH}`);
} catch (error) {
  fs.mkdirSync(ARTIFACT_DIRECTORY, { recursive: true });
  fs.writeFileSync(
    REPORT_PATH,
    `${JSON.stringify({
      passed: false,
      cases,
      error: error?.stack ?? String(error),
      hardhatOutput,
    }, null, 2)}\n`,
  );
  console.error(error);
  process.exitCode = 1;
} finally {
  await stopChild(hardhat);
}
