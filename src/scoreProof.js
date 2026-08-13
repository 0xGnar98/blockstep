export const HEMI_CHAIN_ID = 43111;

export const RUN_TYPES = {
  Run: [
    { name: "player", type: "address" },
    { name: "bitcoinHeight", type: "uint32" },
    { name: "packedMoves", type: "uint128" },
    { name: "deadline", type: "uint256" },
  ],
};

export function buildRunTypedData({ player, proof, contractAddress, deadline }) {
  if (!proof) throw new Error("A completed BLOCKSTEP proof is required.");
  if (!contractAddress) throw new Error("The BLOCKSTEP score contract is not configured.");
  return {
    domain: {
      name: "BLOCKSTEP Scores",
      version: "1",
      chainId: HEMI_CHAIN_ID,
      verifyingContract: contractAddress,
    },
    types: RUN_TYPES,
    primaryType: "Run",
    message: {
      player,
      bitcoinHeight: proof.bitcoinHeight,
      packedMoves: BigInt(proof.packedMoves),
      deadline: BigInt(deadline),
    },
  };
}
