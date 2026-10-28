// Deploy Pave.
//   testnet: npx hardhat run scripts/deploy.ts --network robinhoodTestnet
//            Test $WIF and USDG (anyone can mint), a settable pool price and an always-fresh
//            ETH/USD feed, the fast clock (TEST_PARAMS), a 200 tUSDG seed pool and a first price mark.
//   local:   npx hardhat node, then the same with --network localhost (for building the site)
//   mainnet: CONFIRM_MAINNET=1 npx hardhat run scripts/deploy.ts --network robinhood
//            The real $WIF, USDG, Pons pool and Chainlink feed (MAINNET, PARAMS). Nothing else.
// Writes deployments/<network>.json, which the site reads.
import hre from "hardhat";
import { writeFileSync, mkdirSync } from "node:fs";
import { MAINNET, PARAMS, TEST_PARAMS } from "./config";

const WIF = (n: number) => BigInt(n) * 10n ** 18n;
const USDG = (n: number) => BigInt(Math.round(n * 1_000_000));

/// sqrtPriceX96 for `price` currency1 per currency0 (both 18 decimals).
function sqrtPriceX96(price: bigint): bigint {
  const target = price << 192n;
  let x = target, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + target / x) / 2n; }
  return x;
}

const plain = (o: object) => JSON.parse(JSON.stringify(o, (_, v) => (typeof v === "bigint" ? v.toString() : v)));

async function main() {
  const net = hre.network.name;
  const [deployer] = await hre.viem.getWalletClients();
  if (!deployer) throw new Error("no deployer: set PAVE_DEPLOYER_KEY (or HYPOTHEC_DEPLOYER_KEY) in this terminal");
  const pub = await hre.viem.getPublicClient();
  const me = deployer.account.address;
  console.log(`${net} (chain ${await pub.getChainId()}), deployer ${me}, ${Number(await pub.getBalance({ address: me })) / 1e18} ETH`);

  let out: Record<string, unknown>;
  const local = net === "hardhat" || net === "localhost";
  if (net === "robinhoodTestnet" || local) {
    const wif = await hre.viem.deployContract("MockERC20", ["Test World is Flat", "tWIF", 18]);
    const usdg = await hre.viem.deployContract("MockERC20", ["Test Global Dollar", "tUSDG", 6]);
    const stateView = await hre.viem.deployContract("MockStateView");
    await stateView.write.set([sqrtPriceX96(2_045_000n)]); // mainnet on 28 Oct: ~2.045M WIF per ETH
    const feed = await hre.viem.deployContract("TestnetFeed", [2_374n * 10n ** 8n]);
    const config = {
      wif: wif.address, usdg: usdg.address, stateView: stateView.address,
      poolId: "0x" + "00".repeat(32), wifIsCurrency1: true, ethUsd: feed.address, ...TEST_PARAMS,
    };
    const pave = await hre.viem.deployContract("Pave", [config as never]);
    console.log(`Pave ${pave.address}`);

    // Seed: the deployer lends 200 tUSDG and records the first price mark.
    await usdg.write.mint([me, USDG(1_000)]);
    await wif.write.mint([me, WIF(10_000_000)]);
    await usdg.write.approve([pave.address, USDG(200)]);
    await pave.write.deposit([USDG(200)]);
    await pave.write.poke();
    out = {
      ...(local
        ? { network: "Local chain", chainId: 31337, rpc: "http://127.0.0.1:8545", explorer: "" }
        : { network: "Robinhood Chain testnet", chainId: 46630, rpc: "https://rpc.testnet.chain.robinhood.com",
            explorer: "https://explorer.testnet.chain.robinhood.com" }),
      Pave: pave.address, wif: wif.address, usdg: usdg.address, stateView: stateView.address, ethUsd: feed.address,
      testTokens: true, params: plain(TEST_PARAMS),
      deployBlock: Number(await pub.getBlockNumber()), deployedAt: new Date().toISOString(),
    };
  } else if (net === "robinhood") {
    if (process.env.CONFIRM_MAINNET !== "1") throw new Error("mainnet: set CONFIRM_MAINNET=1 to deploy for real");
    const config = {
      wif: MAINNET.wif, usdg: MAINNET.usdg, stateView: MAINNET.stateView, poolId: MAINNET.poolId,
      wifIsCurrency1: MAINNET.wifIsCurrency1, ethUsd: MAINNET.ethUsd, ...PARAMS,
    };
    const pave = await hre.viem.deployContract("Pave", [config as never]);
    console.log(`Pave ${pave.address}`);
    await pave.write.poke();
    out = {
      network: "Robinhood Chain", chainId: 4663, rpc: "https://rpc.mainnet.chain.robinhood.com",
      explorer: "https://robinhoodchain.blockscout.com",
      Pave: pave.address, wif: MAINNET.wif, usdg: MAINNET.usdg, stateView: MAINNET.stateView, ethUsd: MAINNET.ethUsd,
      poolId: MAINNET.poolId, testTokens: false, params: plain(PARAMS),
      deployBlock: Number(await pub.getBlockNumber()), deployedAt: new Date().toISOString(),
    };
  } else {
    throw new Error(`deploy to robinhoodTestnet or robinhood, not ${net}`);
  }

  mkdirSync("deployments", { recursive: true });
  const file = `deployments/${net === "robinhood" ? "robinhood" : local ? "local" : "robinhood-testnet"}.json`;
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`wrote ${file}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
