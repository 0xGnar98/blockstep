import test from "node:test";
import assert from "node:assert/strict";

import { privateKeyToAccount } from "viem/accounts";

import { BLOCKSTEP_MAINNET } from "../src/blockstepConfig.js";
import {
  VerificationError,
  connectHemiWallet,
  createRunVerifier,
  loadRelayedBitcoinContext,
  signRunProof,
  toWalletTypedData,
} from "../src/runVerification.js";
import { buildRunTypedData } from "../src/scoreProof.js";

const account = privateKeyToAccount(`0x${"01".repeat(32)}`);
const otherAccount = privateKeyToAccount(`0x${"11".repeat(32)}`);
const proof = Object.freeze({
  bitcoinHeight: 1_000_004,
  bitcoinBlockHash: `0x${"12".repeat(32)}`,
  packedMoves: "0x0000025c6194223035224524d3283288",
  score: 865,
});

function walletProvider(signer = account) {
  let chainId = "0x1";
  let added = false;
  const calls = [];
  return {
    calls,
    async request(request) {
      calls.push(request);
      if (request.method === "eth_requestAccounts") return [account.address];
      if (request.method === "eth_chainId") return chainId;
      if (request.method === "wallet_switchEthereumChain") {
        if (!added) {
          const error = new Error("unknown chain");
          error.code = 4902;
          throw error;
        }
        chainId = request.params[0].chainId;
        return null;
      }
      if (request.method === "wallet_addEthereumChain") {
        assert.equal(request.params[0].chainId, BLOCKSTEP_MAINNET.chainIdHex);
        assert.deepEqual(request.params[0].rpcUrls, [BLOCKSTEP_MAINNET.rpcUrl]);
        added = true;
        chainId = request.params[0].chainId;
        return null;
      }
      if (request.method === "eth_signTypedData_v4") {
        const data = JSON.parse(request.params[1]);
        return signer.signTypedData({
          domain: data.domain,
          types: { Run: data.types.Run },
          primaryType: data.primaryType,
          message: {
            ...data.message,
            bitcoinHeight: Number(data.message.bitcoinHeight),
            packedMoves: BigInt(data.message.packedMoves),
            deadline: BigInt(data.message.deadline),
          },
        });
      }
      throw new Error(`unexpected wallet method ${request.method}`);
    },
  };
}

test("the canonical deployed contract is the default signing domain", () => {
  assert.equal(BLOCKSTEP_MAINNET.chainId, 43111);
  assert.equal(BLOCKSTEP_MAINNET.chainIdHex, "0xa867");
  assert.equal(BLOCKSTEP_MAINNET.scoreContractAddress, "0x302449c0dcC71c6ef04820D6c55Cc316fAF15457");
  const typedData = buildRunTypedData({
    player: account.address,
    proof,
    contractAddress: BLOCKSTEP_MAINNET.scoreContractAddress,
    deadline: 2_000_000_000n,
  });
  assert.equal(typedData.domain.verifyingContract, BLOCKSTEP_MAINNET.scoreContractAddress);
  assert.equal(typedData.domain.chainId, 43111);
  const walletData = toWalletTypedData(typedData);
  assert.equal(walletData.message.packedMoves, BigInt(proof.packedMoves).toString());
  assert.ok(walletData.types.EIP712Domain);
});

test("wallet connection adds and selects Hemi when the chain is unknown", async () => {
  const provider = walletProvider();
  assert.equal(await connectHemiWallet(provider), account.address);
  assert.deepEqual(provider.calls.map(({ method }) => method), [
    "eth_requestAccounts",
    "eth_chainId",
    "wallet_switchEthereumChain",
    "wallet_addEthereumChain",
    "wallet_switchEthereumChain",
    "eth_chainId",
  ]);
});

test("a run signature is locally recovered before relayer submission", async () => {
  const provider = walletProvider();
  await connectHemiWallet(provider);
  const signed = await signRunProof({
    provider,
    player: account.address,
    proof,
    deadline: 2_000_000_000n,
  });
  assert.match(signed.signature, /^0x[0-9a-f]{130}$/i);
});

test("a mismatched wallet signature is rejected without contacting a relayer", async () => {
  const provider = walletProvider(otherAccount);
  await connectHemiWallet(provider);
  await assert.rejects(
    signRunProof({ provider, player: account.address, proof, deadline: 2_000_000_000n }),
    (error) => error instanceof VerificationError && error.code === "SIGNER_MISMATCH",
  );
});

test("the verification controller signs once and posts only the fixed replay payload", async () => {
  const states = [];
  const requests = [];
  const provider = walletProvider();
  const verifier = createRunVerifier({
    provider,
    now: () => 1_900_000_000_000,
    onState: (state) => states.push(state.state),
    fetchImpl: async (url, options) => {
      requests.push({ url, options, body: JSON.parse(options.body) });
      return new Response(JSON.stringify({
        transactionHash: `0x${"ab".repeat(32)}`,
        score: 865,
        blockNumber: "5057000",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await verifier.verify(proof);
  assert.equal(result.player, account.address);
  assert.deepEqual(states, ["wallet", "signing", "relaying", "verified"]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/api/verify");
  assert.deepEqual(Object.keys(requests[0].body).sort(), [
    "bitcoinHeight", "deadline", "packedMoves", "player", "signature",
  ]);
  assert.equal(requests[0].body.bitcoinHeight, proof.bitcoinHeight);
  assert.equal(requests[0].body.packedMoves, proof.packedMoves);
});

test("relayed challenges use a validated archived Bitcoin header", async () => {
  const context = await loadRelayedBitcoinContext({
    fetchImpl: async () => new Response(JSON.stringify({
      chainId: BLOCKSTEP_MAINNET.chainId,
      contractAddress: BLOCKSTEP_MAINNET.scoreContractAddress,
      challenge: {
        bitcoinHeight: 1_000_004,
        bitcoinBlockHash: `0x${"34".repeat(32)}`,
        latestHeight: 1_000_005,
        expiresAfterHeight: 1_000_009,
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  assert.equal(context.number, 1_000_004);
  assert.equal(context.network, "live");
  assert.equal(context.latestHeight, 1_000_005);
  assert.equal(context.verificationEligible, true);
});
