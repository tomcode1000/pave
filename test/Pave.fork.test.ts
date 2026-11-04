// Runs against a copy of Robinhood Chain mainnet: `npm run test:fork`.
// The real $WIF, USDG, Pons pool (via Uniswap's StateView) and Chainlink ETH/USD feed.
import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { parseEther, toHex } from "viem";
import { MAINNET, PARAMS } from "../scripts/config";

chai.use(chaiAsPromised);

const USDG = (n: number) => BigInt(Math.round(n * 1_000_000));
const WIF = (n: number) => BigInt(n) * 10n ** 18n;
const HOUR = 3_600n;
const BURN = "0x000000000000000000000000000000000000dEaD";

async function impersonate(address: string) {
  await hre.network.provider.request({ method: "hardhat_impersonateAccount", params: [address] });
  await hre.network.provider.request({ method: "hardhat_setBalance", params: [address, toHex(parseEther("10"))] });
  return hre.viem.getWalletClient(address as `0x${string}`);
}

async function setup(overrides: Partial<typeof PARAMS> = {}) {
  if (!process.env.FORK) throw new Error("run with FORK=1 (npm run test:fork)");
  const [deployer, borrower, alice, bob, lender, stranger] = await hre.viem.getWalletClients();
  const pave = await hre.viem.deployContract("Pave", [{
    wif: MAINNET.wif, usdg: MAINNET.usdg, stateView: MAINNET.stateView, poolId: MAINNET.poolId,
    wifIsCurrency1: MAINNET.wifIsCurrency1, ethUsd: MAINNET.ethUsd, ...PARAMS, ...overrides,
  }]);
  const wif = await hre.viem.getContractAt("MockERC20", MAINNET.wif);
  const usdg = await hre.viem.getContractAt("MockERC20", MAINNET.usdg);
  const wifWhale = await impersonate(MAINNET.wifHolder);
  const usdgWhale = await impersonate(MAINNET.usdgHolder);
  for (const w of [borrower, alice, bob, lender, stranger]) {
    await (await hre.viem.getContractAt("MockERC20", MAINNET.wif, { client: { wallet: wifWhale } })).write.transfer([w.account.address, WIF(500_000)]);
    await (await hre.viem.getContractAt("MockERC20", MAINNET.usdg, { client: { wallet: usdgWhale } })).write.transfer([w.account.address, USDG(500)]);
    const max = 2n ** 256n - 1n;
    await (await hre.viem.getContractAt("MockERC20", MAINNET.wif, { client: { wallet: w } })).write.approve([pave.address, max]);
    await (await hre.viem.getContractAt("MockERC20", MAINNET.usdg, { client: { wallet: w } })).write.approve([pave.address, max]);
  }
  const as = (w: typeof deployer) => hre.viem.getContractAt("Pave", pave.address, { client: { wallet: w } });
  return { borrower, alice, bob, lender, stranger, pave, wif, usdg, as };
}

const addr = (w: { account: { address: `0x${string}` } }) => w.account.address;

/// The keeper's job: a price mark every hour, as many hours as borrowing asks for (12 on mainnet).
async function keep(s: Awaited<ReturnType<typeof setup>>, hours = Number(PARAMS.minMarks)) {
  for (let i = 0; i < hours; i++) {
    await (await s.as(s.stranger)).write.poke();
    await time.increase(HOUR);
  }
}

describe("Pave on a mainnet fork", () => {
  it("reads a sane $WIF price from the Pons pool and Chainlink", async () => {
    const s = await setup();
    const [spotX96, lowX96, ethUsd8, millionAtSpot] = await s.pave.read.prices();
    const wifPerEth = Number(spotX96) / 2 ** 96;
    console.log(`      ETH/USD ${Number(ethUsd8) / 1e8}, ${Math.round(wifPerEth).toLocaleString()} WIF per ETH, ` +
      `1M WIF = $${(Number(millionAtSpot) / 1e6).toFixed(2)}, 1 WIF = $${(Number(millionAtSpot) / 1e12).toFixed(6)}`);
    expect(lowX96).to.equal(spotX96);
    expect(ethUsd8 > 500n * 10n ** 8n && ethUsd8 < 20_000n * 10n ** 8n).to.equal(true);
    // DexScreener on 26 Oct: $0.00127 per WIF, i.e. ~$1,270 per million. Allow a wide band.
    expect(millionAtSpot > USDG(50) && millionAtSpot < USDG(100_000)).to.equal(true);
  });

  it("takes real $WIF and USDG at face value (no transfer tax)", async () => {
    const s = await setup({ vouchMaturity: 0n });
    const before = await s.wif.read.balanceOf([s.pave.address]);
    await (await s.as(s.alice)).write.vouch([addr(s.borrower), WIF(100_000)]);
    expect((await s.wif.read.balanceOf([s.pave.address])) - before).to.equal(WIF(100_000));
    await (await s.as(s.lender)).write.deposit([USDG(100)]);
    expect(await s.usdg.read.balanceOf([s.pave.address])).to.equal(USDG(100));
  });

  it("vouch, borrow, repay: the whole road with the real tokens", async () => {
    const s = await setup({ vouchMaturity: HOUR });
    await (await s.as(s.alice)).write.vouch([addr(s.borrower), WIF(150_000)]);
    await (await s.as(s.bob)).write.vouch([addr(s.borrower), WIF(50_000)]);
    await (await s.as(s.lender)).write.deposit([USDG(100)]);
    await expect((await s.as(s.borrower)).write.borrow([USDG(1)])).to.be.rejectedWith("NoPriceHistory");
    await keep(s);
    const c = await s.pave.read.creditOf([addr(s.borrower)]);
    console.log(`      200,000 WIF vouched = $${(Number(c.matureUsdg) / 1e6).toFixed(2)}, backed $${(Number(c.backed) / 1e6).toFixed(2)}, can borrow $${(Number(c.available) / 1e6).toFixed(2)}`);
    expect(c.available > 0n).to.equal(true);

    await (await s.as(s.borrower)).write.borrow([c.available]);
    await (await s.as(s.borrower)).write.repay([addr(s.borrower)]);
    const p = await s.pave.read.pathOf([addr(s.borrower)]);
    expect(p.repaid).to.equal(1);
    expect((await s.pave.read.rewards([addr(s.alice)])) > 0n).to.equal(true);
    await (await s.as(s.alice)).write.claimRewards();
    await (await s.as(s.alice)).write.unvouch([addr(s.borrower)]);
  });

  it("a default burns real $WIF and pays the lender in $WIF", async () => {
    // the fork is frozen in time, so its Chainlink answer ages as the test jumps ahead
    const s = await setup({ vouchMaturity: 0n, loanTerm: HOUR, grace: HOUR, feedMaxAge: 72n * HOUR });
    await (await s.as(s.alice)).write.vouch([addr(s.borrower), WIF(200_000)]);
    await (await s.as(s.lender)).write.deposit([USDG(100)]);
    await keep(s);
    await (await s.as(s.borrower)).write.borrow([USDG(10)]);
    const burnedBefore = await s.wif.read.balanceOf([BURN]);
    await time.increase(2n * HOUR + 1n);
    await (await s.as(s.stranger)).write.markDefault([addr(s.borrower)]);
    const burned = (await s.wif.read.balanceOf([BURN])) - burnedBefore;
    const toLender = await s.pave.read.pendingWif([addr(s.lender)]);
    console.log(`      default on $10.30: ${(Number(toLender) / 1e18).toFixed(0)} WIF to the lender, ${(Number(burned) / 1e18).toFixed(0)} WIF burned`);
    expect(burned > 0n && toLender > 0n).to.equal(true);
    // burned and paid out are each one debt's worth
    const diff = burned > toLender ? burned - toLender : toLender - burned;
    expect(diff <= WIF(1)).to.equal(true);
    await (await s.as(s.lender)).write.claimWif();
  });
});
