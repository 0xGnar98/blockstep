const buildEnv = import.meta.env ?? {};

function envText(name, fallback = "") {
  const value = buildEnv[name];
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function trimTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

export const BLOCKSTEP_MAINNET = Object.freeze({
  chainId: 43111,
  chainIdHex: "0xa867",
  chainName: "Hemi Network",
  nativeCurrency: Object.freeze({ name: "Ether", symbol: "ETH", decimals: 18 }),
  rpcUrl: envText("VITE_HEMI_RPC_URL", "https://rpc.hemi.network/rpc"),
  explorerUrl: "https://explorer.hemi.xyz",
  bitcoinKitAddress: envText(
    "VITE_BITCOIN_KIT_ADDRESS",
    "0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12",
  ),
  scoreContractAddress: envText(
    "VITE_SCORE_CONTRACT_ADDRESS",
    "0x302449c0dcC71c6ef04820D6c55Cc316fAF15457",
  ),
  relayerUrl: trimTrailingSlash(envText("VITE_BLOCKSTEP_RELAYER_URL")),
  submissionHeightWindow: 6,
});

export const BITCOIN_HEADER_COMPONENTS = Object.freeze([
  { name: "height", type: "uint32" },
  { name: "blockHash", type: "bytes32" },
  { name: "version", type: "uint32" },
  { name: "previousBlockHash", type: "bytes32" },
  { name: "merkleRoot", type: "bytes32" },
  { name: "timestamp", type: "uint32" },
  { name: "bits", type: "uint32" },
  { name: "nonce", type: "uint32" },
]);

export const BITCOIN_KIT_ABI = Object.freeze(["getLastHeader", "getHeaderN"].map((name) => ({
  type: "function",
  name,
  stateMutability: "view",
  inputs: name === "getHeaderN" ? [{ name: "height", type: "uint32" }] : [],
  outputs: [{ name: "", type: "tuple", components: BITCOIN_HEADER_COMPONENTS }],
})));

export const BLOCKSTEP_SCORE_ABI = Object.freeze([
  {
    type: "function",
    name: "submitRunFor",
    stateMutability: "nonpayable",
    inputs: [
      { name: "player", type: "address" },
      { name: "bitcoinHeight", type: "uint32" },
      { name: "packedMoves", type: "uint128" },
      { name: "deadline", type: "uint256" },
      { name: "signature", type: "bytes" },
    ],
    outputs: [{ name: "score", type: "uint32" }],
  },
  {
    type: "function",
    name: "verifyRun",
    stateMutability: "view",
    inputs: [
      { name: "bitcoinHeight", type: "uint32" },
      { name: "packedMoves", type: "uint128" },
    ],
    outputs: [
      {
        name: "result",
        type: "tuple",
        components: [
          { name: "score", type: "uint32" },
          { name: "lives", type: "uint8" },
          { name: "hits", type: "uint8" },
          { name: "shards", type: "uint8" },
          { name: "closeCalls", type: "uint8" },
          { name: "beatsSurvived", type: "uint8" },
          { name: "flipUnused", type: "bool" },
          { name: "cleared", type: "bool" },
        ],
      },
      { name: "bitcoinBlockHash", type: "bytes32" },
    ],
  },
]);

export function relayerEndpoint(pathname, baseUrl = BLOCKSTEP_MAINNET.relayerUrl) {
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return baseUrl ? `${trimTrailingSlash(baseUrl)}${normalizedPath}` : normalizedPath;
}

