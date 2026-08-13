import { createPublicClient, http } from "viem";
import { hemi, hemiPublicBitcoinKitActions } from "hemi-viem";

export const HEMI_MAINNET = {
  chainId: 43111,
  rpcUrl: import.meta.env.VITE_HEMI_RPC_URL || "https://rpc.hemi.network/rpc",
  explorerUrl: "https://explorer.hemi.xyz",
  bitcoinKitAddress:
    import.meta.env.VITE_BITCOIN_KIT_ADDRESS ||
    "0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12",
};

export async function loadLatestBitcoinContext() {
  const client = createPublicClient({
    chain: hemi,
    transport: http(HEMI_MAINNET.rpcUrl, {
      retryCount: 1,
      timeout: 5000,
    }),
  }).extend(hemiPublicBitcoinKitActions());

  const header = await client.getLastHeader({
    bitcoinKitAddress: HEMI_MAINNET.bitcoinKitAddress,
  });

  return {
    number: Number(header.height),
    hash: header.blockHash,
    source: "Hemi Mainnet",
    network: "live",
    header: {
      height: Number(header.height),
      blockHash: header.blockHash,
      previousBlockHash: header.previousBlockHash,
      merkleRoot: header.merkleRoot,
      timestamp: Number(header.timestamp),
      bits: Number(header.bits),
      nonce: Number(header.nonce),
      version: Number(header.version),
    },
  };
}
