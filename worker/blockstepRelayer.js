import {
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  isAddress,
  recoverTypedDataAddress,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hemi } from "hemi-viem";

import {
  BITCOIN_KIT_ABI,
  BLOCKSTEP_MAINNET,
  BLOCKSTEP_SCORE_ABI,
} from "../src/blockstepConfig.js";
import { buildRunTypedData } from "../src/scoreProof.js";

const MAX_BODY_BYTES = 4096;
const MAX_DEADLINE_SECONDS = 10 * 60;
const MAX_CANONICAL_MOVES = (1n << 108n) - 1n;
const PRIVATE_KEY_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
const PACKED_MOVES_PATTERN = /^0x[0-9a-fA-F]{1,32}$/;
const DEFAULT_GAS_LIMIT_CEILING = 700_000n;
const DEFAULT_MAX_FEE_PER_GAS_CEILING = 2_000_000n;

export class RelayerError extends Error {
  constructor(status, code, message, options) {
    super(message, options);
    this.name = "RelayerError";
    this.status = status;
    this.code = code;
  }
}

function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...headers,
    },
  });
}

function errorResponse(error, corsHeaders) {
  const normalized = error instanceof RelayerError
    ? error
    : new RelayerError(503, "SERVICE_UNAVAILABLE", "Verification is temporarily unavailable.", { cause: error });
  return json({ error: { code: normalized.code, message: normalized.message } }, normalized.status, corsHeaders);
}

function allowedOrigin(request, configuredOrigins) {
  const origin = request.headers.get("origin");
  if (!origin) return null;
  if (origin === new URL(request.url).origin || configuredOrigins.includes(origin)) return origin;
  throw new RelayerError(403, "ORIGIN_REJECTED", "This origin is not allowed to use the verification service.");
}

function cors(origin) {
  if (!origin) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "600",
    vary: "origin",
  };
}

async function readLimitedJson(request) {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    throw new RelayerError(415, "JSON_REQUIRED", "Send the verification request as JSON.");
  }
  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new RelayerError(413, "REQUEST_TOO_LARGE", "The verification request is too large.");
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > MAX_BODY_BYTES) {
    throw new RelayerError(413, "REQUEST_TOO_LARGE", "The verification request is too large.");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new RelayerError(400, "INVALID_JSON", "The verification request is not valid JSON.");
  }
}

function parseUnsignedInteger(value, field, maximum = null) {
  if (!/^\d+$/.test(String(value ?? ""))) {
    throw new RelayerError(400, "INVALID_REQUEST", `${field} must be an unsigned integer.`);
  }
  const parsed = BigInt(value);
  if (maximum !== null && parsed > maximum) {
    throw new RelayerError(400, "INVALID_REQUEST", `${field} is out of range.`);
  }
  return parsed;
}

function environmentLimit(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  if (!/^\d+$/.test(String(value)) || BigInt(value) <= 0n) {
    throw new RelayerError(500, "INVALID_RELAYER_CONFIG", `${name} must be a positive integer.`);
  }
  return BigInt(value);
}

export function validateVerifyRequest(body, nowSeconds = Math.floor(Date.now() / 1000)) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RelayerError(400, "INVALID_REQUEST", "The verification request must be an object.");
  }
  const exactKeys = ["bitcoinHeight", "deadline", "packedMoves", "player", "signature"];
  const receivedKeys = Object.keys(body).sort();
  if (receivedKeys.length !== exactKeys.length || receivedKeys.some((key, index) => key !== exactKeys[index])) {
    throw new RelayerError(400, "INVALID_REQUEST", "The verification request has unexpected or missing fields.");
  }
  if (!isAddress(body.player)) {
    throw new RelayerError(400, "INVALID_PLAYER", "The player address is invalid.");
  }
  const bitcoinHeight = parseUnsignedInteger(body.bitcoinHeight, "bitcoinHeight", 0xffffffffn);
  if (!PACKED_MOVES_PATTERN.test(body.packedMoves ?? "")) {
    throw new RelayerError(400, "INVALID_MOVES", "The packed replay must be a uint128 hex value.");
  }
  const packedMoves = BigInt(body.packedMoves);
  if (packedMoves > MAX_CANONICAL_MOVES) {
    throw new RelayerError(400, "NON_CANONICAL_MOVES", "The replay contains data outside its 108 move bits.");
  }
  const deadline = parseUnsignedInteger(body.deadline, "deadline");
  if (deadline <= BigInt(nowSeconds)) {
    throw new RelayerError(400, "SIGNATURE_EXPIRED", "The run signature has expired.");
  }
  if (deadline > BigInt(nowSeconds + MAX_DEADLINE_SECONDS)) {
    throw new RelayerError(400, "DEADLINE_TOO_FAR", "The run signature deadline is too far in the future.");
  }
  if (!SIGNATURE_PATTERN.test(body.signature ?? "")) {
    throw new RelayerError(400, "INVALID_SIGNATURE", "The run signature must be a 65-byte hex value.");
  }
  return {
    player: getAddress(body.player),
    bitcoinHeight: Number(bitcoinHeight),
    packedMoves,
    packedMovesHex: `0x${packedMoves.toString(16).padStart(32, "0")}`,
    deadline,
    signature: body.signature,
  };
}

export function createInMemoryRateLimiter({ limit = 5, windowMs = 60_000, now = () => Date.now() } = {}) {
  const entries = new Map();
  return {
    check(key) {
      const time = now();
      const previous = entries.get(key);
      const current = !previous || time - previous.startedAt >= windowMs
        ? { startedAt: time, count: 1 }
        : { ...previous, count: previous.count + 1 };
      entries.set(key, current);
      if (current.count > limit) {
        throw new RelayerError(429, "RATE_LIMITED", "Too many verification attempts. Try again in a minute.");
      }
    },
  };
}

function normalizeHeader(header) {
  return {
    height: Number(header.height),
    blockHash: header.blockHash,
    previousBlockHash: header.previousBlockHash,
    merkleRoot: header.merkleRoot,
    timestamp: Number(header.timestamp),
    bits: Number(header.bits),
    nonce: Number(header.nonce),
    version: Number(header.version),
  };
}

export function createHemiRelayerService(env = {}) {
  const rpcUrl = env.HEMI_RPC_URL || BLOCKSTEP_MAINNET.rpcUrl;
  const scoreContractAddress = env.SCORE_CONTRACT_ADDRESS || BLOCKSTEP_MAINNET.scoreContractAddress;
  const gasLimitCeiling = environmentLimit(
    env.RELAYER_MAX_GAS,
    DEFAULT_GAS_LIMIT_CEILING,
    "RELAYER_MAX_GAS",
  );
  const maxFeePerGasCeiling = environmentLimit(
    env.RELAYER_MAX_FEE_PER_GAS_WEI,
    DEFAULT_MAX_FEE_PER_GAS_CEILING,
    "RELAYER_MAX_FEE_PER_GAS_WEI",
  );
  if (getAddress(scoreContractAddress) !== getAddress(BLOCKSTEP_MAINNET.scoreContractAddress)) {
    throw new RelayerError(500, "CONTRACT_MISMATCH", "The relayer is not configured for the canonical score contract.");
  }
  const publicClient = createPublicClient({
    chain: hemi,
    transport: http(rpcUrl, { retryCount: 1, timeout: 8_000 }),
  });

  async function getLatestHeader() {
    return publicClient.readContract({
      address: BLOCKSTEP_MAINNET.bitcoinKitAddress,
      abi: BITCOIN_KIT_ABI,
      functionName: "getLastHeader",
    });
  }

  return {
    async getChallenge() {
      const latest = await getLatestHeader();
      const latestHeight = Number(latest.height);
      if (!Number.isInteger(latestHeight) || latestHeight < 2 || /^0x0+$/.test(latest.blockHash)) {
        throw new RelayerError(503, "BITCOIN_HEADER_UNAVAILABLE", "Hemi has not returned a usable Bitcoin header.");
      }
      const bitcoinHeight = latestHeight - 1;
      const header = await publicClient.readContract({
        address: BLOCKSTEP_MAINNET.bitcoinKitAddress,
        abi: BITCOIN_KIT_ABI,
        functionName: "getHeaderN",
        args: [bitcoinHeight],
      });
      if (Number(header.height) !== bitcoinHeight || /^0x0+$/.test(header.blockHash)) {
        throw new RelayerError(503, "BITCOIN_HEADER_UNAVAILABLE", "Hemi has not archived the selected Bitcoin header yet.");
      }
      return {
        bitcoinHeight,
        bitcoinBlockHash: header.blockHash,
        latestHeight,
        expiresAfterHeight: bitcoinHeight + BLOCKSTEP_MAINNET.submissionHeightWindow - 1,
        header: normalizeHeader(header),
      };
    },

    async getLatestHeight() {
      return Number((await getLatestHeader()).height);
    },

    async submitRunFor(input) {
      const privateKey = env.RELAYER_PRIVATE_KEY;
      if (!PRIVATE_KEY_PATTERN.test(privateKey ?? "")) {
        throw new RelayerError(503, "RELAYER_NOT_FUNDED", "Score verification is not active yet.");
      }
      const account = privateKeyToAccount(privateKey);
      const walletClient = createWalletClient({ account, chain: hemi, transport: http(rpcUrl) });
      const { request, result } = await publicClient.simulateContract({
        account,
        address: scoreContractAddress,
        abi: BLOCKSTEP_SCORE_ABI,
        functionName: "submitRunFor",
        args: [input.player, input.bitcoinHeight, input.packedMoves, input.deadline, input.signature],
      });
      const gas = await publicClient.estimateContractGas(request);
      const fees = await publicClient.estimateFeesPerGas();
      const feePerGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n;
      const priorityFeePerGas = fees.maxPriorityFeePerGas ?? 0n;
      if (gas > gasLimitCeiling) {
        throw new RelayerError(503, "GAS_LIMIT_EXCEEDED", "The verification transaction exceeds its gas safety limit.");
      }
      if (feePerGas === 0n || feePerGas > maxFeePerGasCeiling || priorityFeePerGas > maxFeePerGasCeiling) {
        throw new RelayerError(503, "FEE_LIMIT_EXCEEDED", "Hemi network fees exceed the relayer safety limit.");
      }
      const requiredBalance = gas * feePerGas;
      const balance = await publicClient.getBalance({ address: account.address });
      if (requiredBalance === 0n || balance < requiredBalance) {
        throw new RelayerError(503, "RELAYER_NOT_FUNDED", "Score verification is temporarily unavailable.");
      }
      const transactionHash = await walletClient.writeContract({
        ...request,
        gas,
        maxFeePerGas: feePerGas,
        maxPriorityFeePerGas: priorityFeePerGas,
      });
      const receipt = await publicClient.waitForTransactionReceipt({ hash: transactionHash });
      if (receipt.status !== "success") {
        throw new RelayerError(502, "TRANSACTION_REVERTED", "The verification transaction did not succeed.");
      }
      return {
        transactionHash,
        blockNumber: receipt.blockNumber.toString(),
        score: Number(result),
      };
    },
  };
}

export function createBlockstepRelayer({
  service,
  allowedOrigins = [],
  now = () => Date.now(),
  rateLimiter = createInMemoryRateLimiter({ now }),
} = {}) {
  if (!service?.getChallenge || !service?.getLatestHeight || !service?.submitRunFor) {
    throw new TypeError("A fixed-purpose BLOCKSTEP relayer service is required.");
  }
  const normalizedOrigins = allowedOrigins.filter(Boolean).map((origin) => new URL(origin).origin);

  return async function handle(request) {
    let corsHeaders = {};
    try {
      const origin = allowedOrigin(request, normalizedOrigins);
      corsHeaders = cors(origin);
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders });
      const { pathname } = new URL(request.url);

      if (pathname === "/api/challenge") {
        if (request.method !== "GET") throw new RelayerError(405, "METHOD_NOT_ALLOWED", "Use GET for a new challenge.");
        const challenge = await service.getChallenge();
        return json({
          challenge,
          chainId: BLOCKSTEP_MAINNET.chainId,
          contractAddress: BLOCKSTEP_MAINNET.scoreContractAddress,
        }, 200, corsHeaders);
      }

      if (pathname === "/api/verify") {
        if (request.method !== "POST") throw new RelayerError(405, "METHOD_NOT_ALLOWED", "Use POST to verify a signed run.");
        const input = validateVerifyRequest(await readLimitedJson(request), Math.floor(now() / 1000));
        const typedData = buildRunTypedData({
          player: input.player,
          proof: { bitcoinHeight: input.bitcoinHeight, packedMoves: input.packedMovesHex },
          contractAddress: BLOCKSTEP_MAINNET.scoreContractAddress,
          deadline: input.deadline,
        });
        let signer;
        try {
          signer = await recoverTypedDataAddress({ ...typedData, signature: input.signature });
        } catch {
          throw new RelayerError(401, "INVALID_SIGNATURE", "The run signature could not be verified.");
        }
        if (getAddress(signer) !== input.player) {
          throw new RelayerError(401, "SIGNER_MISMATCH", "The run signature does not match the player.");
        }
        await rateLimiter.check(`player:${input.player}`);
        const clientIdentity = request.headers.get("cf-connecting-ip") ?? request.headers.get("origin") ?? "local";
        await rateLimiter.check(`client:${clientIdentity}`);
        const latestHeight = await service.getLatestHeight();
        if (
          input.bitcoinHeight > latestHeight
          || latestHeight - input.bitcoinHeight >= BLOCKSTEP_MAINNET.submissionHeightWindow
        ) {
          throw new RelayerError(409, "STALE_CHALLENGE", "This Bitcoin challenge is no longer inside the verification window.");
        }
        const result = await service.submitRunFor(input);
        return json({
          ...result,
          player: input.player,
          bitcoinHeight: input.bitcoinHeight,
          explorerUrl: `${BLOCKSTEP_MAINNET.explorerUrl}/tx/${result.transactionHash}`,
        }, 200, corsHeaders);
      }

      throw new RelayerError(404, "NOT_FOUND", "No verification route exists at this path.");
    } catch (error) {
      return errorResponse(error, corsHeaders);
    }
  };
}
