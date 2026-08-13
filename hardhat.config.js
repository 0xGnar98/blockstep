import { defineConfig } from "hardhat/config";

export default defineConfig({
  networks: {
    blockstepLocal: {
      type: "edr-simulated",
      chainType: "l1",
      chainId: 43111,
      hardfork: "cancun",
      initialBaseFeePerGas: 1_000_000_000,
      loggingEnabled: false,
    },
  },
});
