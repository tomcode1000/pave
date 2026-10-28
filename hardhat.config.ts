import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-viem";

const RPC = process.env.ROBINHOOD_RPC ?? "https://rpc.mainnet.chain.robinhood.com";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 } },
  },
  networks: {
    // FORK=1 runs the tests against a copy of Robinhood Chain mainnet: the real $WIF, USDG,
    // Pons pool and Chainlink feed (test/Pave.fork.test.ts).
    hardhat: process.env.FORK
      ? { chainId: 4663, forking: { url: RPC, ...(process.env.FORK_BLOCK ? { blockNumber: Number(process.env.FORK_BLOCK) } : {}) } }
      : { accounts: { count: 30 } },
    // Live mainnet. The deployer key comes from the environment, never a file in this folder.
    robinhood: {
      url: RPC,
      chainId: 4663,
      accounts: process.env.PAVE_DEPLOYER_KEY ? [process.env.PAVE_DEPLOYER_KEY] : [],
    },
  },
  mocha: { timeout: 300_000 },
};

export default config;
