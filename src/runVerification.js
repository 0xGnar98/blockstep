import { getAddress, isAddress, recoverTypedDataAddress } from "viem";

import { BLOCKSTEP_MAINNET, relayerEndpoint } from "./blockstepConfig.js";
import { buildRunTypedData } from "./scoreProof.js";

const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;
const PACKED_MOVES_PATTERN = /^0x[0-9a-fA-F]{1,32}$/;
const MAX_CANONICAL_MOVES = (1n << 108n) - 1n;

export class VerificationError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "VerificationError";
    this.code = code;
  }
}

function providerErrorCode(error) {
  return error?.code ?? error?.data?.originalError?.code ?? error?.cause?.code;
}

function requireProof(proof) {
  if (!proof || !Number.isInteger(proof.bitcoinHeight) || proof.bitcoinHeight < 0) {
    throw new VerificationError("INVALID_PROOF", "The completed run is missing its Bitcoin height.");
  }
  if (!PACKED_MOVES_PATTERN.test(proof.packedMoves ?? "")) {
    throw new VerificationError("INVALID_PROOF", "The completed run has an invalid packed replay.");
  }
  if (BigInt(proof.packedMoves) > MAX_CANONICAL_MOVES) {
    throw new VerificationError("NON_CANONICAL_PROOF", "The replay contains data outside its 108 move bits.");
  }
  return proof;
}

export function toWalletTypedData(typedData) {
  return {
    domain: {
      ...typedData.domain,
      chainId: typedData.domain.chainId,
    },
    primaryType: typedData.primaryType,
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" },
      ],
      ...typedData.types,
    },
    message: {
      ...typedData.message,
      bitcoinHeight: String(typedData.message.bitcoinHeight),
      packedMoves: typedData.message.packedMoves.toString(),
      deadline: typedData.message.deadline.toString(),
    },
  };
}

export async function connectHemiWallet(provider) {
  if (!provider?.request) {
    throw new VerificationError("WALLET_UNAVAILABLE", "Install or open an EVM wallet to verify this run.");
  }

  const accounts = await provider.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || !accounts[0] || !isAddress(accounts[0])) {
    throw new VerificationError("WALLET_ACCOUNT_UNAVAILABLE", "The wallet did not provide a valid account.");
  }

  let currentChain = await provider.request({ method: "eth_chainId" });
  if (String(currentChain).toLowerCase() !== BLOCKSTEP_MAINNET.chainIdHex) {
    try {
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BLOCKSTEP_MAINNET.chainIdHex }],
      });
    } catch (error) {
      if (providerErrorCode(error) !== 4902) throw error;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: BLOCKSTEP_MAINNET.chainIdHex,
          chainName: BLOCKSTEP_MAINNET.chainName,
          nativeCurrency: BLOCKSTEP_MAINNET.nativeCurrency,
          rpcUrls: [BLOCKSTEP_MAINNET.rpcUrl],
          blockExplorerUrls: [BLOCKSTEP_MAINNET.explorerUrl],
        }],
      });
      await provider.request({
        method: "wallet_switchEthereumChain",
        params: [{ chainId: BLOCKSTEP_MAINNET.chainIdHex }],
      });
    }
    currentChain = await provider.request({ method: "eth_chainId" });
    if (String(currentChain).toLowerCase() !== BLOCKSTEP_MAINNET.chainIdHex) {
      throw new VerificationError("WRONG_NETWORK", "Switch the wallet to Hemi Network and try again.");
    }
  }

  return getAddress(accounts[0]);
}

export async function signRunProof({
  provider,
  player,
  proof,
  contractAddress = BLOCKSTEP_MAINNET.scoreContractAddress,
  deadline,
}) {
  requireProof(proof);
  const typedData = buildRunTypedData({ player, proof, contractAddress, deadline });
  const walletTypedData = toWalletTypedData(typedData);
  const signature = await provider.request({
    method: "eth_signTypedData_v4",
    params: [player, JSON.stringify(walletTypedData)],
  });
  if (!SIGNATURE_PATTERN.test(signature ?? "")) {
    throw new VerificationError("INVALID_WALLET_SIGNATURE", "The wallet returned an invalid signature.");
  }
  const recovered = await recoverTypedDataAddress({ ...typedData, signature });
  if (getAddress(recovered) !== getAddress(player)) {
    throw new VerificationError("SIGNER_MISMATCH", "The signature does not match the connected wallet.");
  }
  return { signature, typedData, walletTypedData };
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export async function submitSignedRun({
  fetchImpl = globalThis.fetch,
  relayerUrl = BLOCKSTEP_MAINNET.relayerUrl,
  player,
  proof,
  deadline,
  signature,
}) {
  if (typeof fetchImpl !== "function") {
    throw new VerificationError("RELAYER_UNAVAILABLE", "The verification service is unavailable.");
  }
  requireProof(proof);
  const response = await fetchImpl(relayerEndpoint("/api/verify", relayerUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      player,
      bitcoinHeight: proof.bitcoinHeight,
      packedMoves: proof.packedMoves,
      deadline: String(deadline),
      signature,
    }),
  });
  const body = await responseJson(response);
  if (!response.ok) {
    throw new VerificationError(
      body?.error?.code ?? "RELAYER_REJECTED",
      body?.error?.message ?? "The verification service could not submit this run.",
    );
  }
  return body;
}

export async function loadRelayedBitcoinContext({
  fetchImpl = globalThis.fetch,
  relayerUrl = BLOCKSTEP_MAINNET.relayerUrl,
} = {}) {
  if (typeof fetchImpl !== "function") return null;
  const response = await fetchImpl(relayerEndpoint("/api/challenge", relayerUrl), {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store",
  });
  if (!response.ok) return null;
  const body = await responseJson(response);
  const challenge = body?.challenge;
  if (
    body?.chainId !== BLOCKSTEP_MAINNET.chainId
    || !isAddress(body?.contractAddress ?? "")
    || getAddress(body.contractAddress) !== getAddress(BLOCKSTEP_MAINNET.scoreContractAddress)
    ||
    !Number.isInteger(challenge?.bitcoinHeight)
    || !/^0x[0-9a-fA-F]{64}$/.test(challenge?.bitcoinBlockHash ?? "")
  ) {
    throw new VerificationError("INVALID_CHALLENGE", "The verification service returned an invalid Bitcoin challenge.");
  }
  return {
    number: challenge.bitcoinHeight,
    hash: challenge.bitcoinBlockHash,
    source: "Hemi verified challenge",
    network: "live",
    latestHeight: challenge.latestHeight,
    expiresAfterHeight: challenge.expiresAfterHeight,
    verificationEligible: true,
    header: challenge.header ?? null,
  };
}

export function createRunVerifier({
  provider = globalThis.window?.ethereum,
  fetchImpl = globalThis.fetch,
  relayerUrl = BLOCKSTEP_MAINNET.relayerUrl,
  contractAddress = BLOCKSTEP_MAINNET.scoreContractAddress,
  now = () => Date.now(),
  onState = () => {},
} = {}) {
  let busy = false;

  async function verify(proof) {
    if (busy) throw new VerificationError("VERIFICATION_BUSY", "Run verification is already in progress.");
    busy = true;
    try {
      onState({ state: "wallet", message: "Connect your wallet." });
      const player = await connectHemiWallet(provider);
      const deadline = BigInt(Math.floor(now() / 1000) + 5 * 60);
      onState({ state: "signing", message: "Sign the run. This costs no gas." });
      const { signature } = await signRunProof({
        provider,
        player,
        proof,
        contractAddress,
        deadline,
      });
      onState({ state: "relaying", message: "Submitting the signed replay through Hemi." });
      const result = await submitSignedRun({
        fetchImpl,
        relayerUrl,
        player,
        proof,
        deadline,
        signature,
      });
      onState({
        state: "verified",
        message: "Score verified on Hemi.",
        player,
        txHash: result.transactionHash,
        score: result.score,
      });
      return { ...result, player, deadline: deadline.toString(), signature };
    } catch (error) {
      const normalized = error instanceof VerificationError
        ? error
        : new VerificationError("VERIFICATION_FAILED", error?.shortMessage ?? error?.message ?? "Verification failed.", { cause: error });
      onState({ state: "error", message: normalized.message, code: normalized.code });
      throw normalized;
    } finally {
      busy = false;
    }
  }

  return { verify, isBusy: () => busy };
}
