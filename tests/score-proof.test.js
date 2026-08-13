import test from "node:test";
import assert from "node:assert/strict";
import { recoverTypedDataAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildRunTypedData } from "../src/scoreProof.js";

test("a gas-sponsored run signature resolves to the player", async () => {
  const account = privateKeyToAccount(
    `0x${"01".repeat(32)}`,
  );
  const typedData = buildRunTypedData({
    player: account.address,
    proof: {
      bitcoinHeight: 961616,
      packedMoves: "0x0000025c6194223035224524d3283288",
    },
    contractAddress: "0x1111111111111111111111111111111111111111",
    deadline: 2_000_000_000,
  });
  const signature = await account.signTypedData(typedData);
  const signer = await recoverTypedDataAddress({ ...typedData, signature });
  assert.equal(signer, account.address);
  assert.equal(typedData.domain.chainId, 43111);
  assert.equal(typedData.primaryType, "Run");
});
