import hre from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import { getAddress, zeroHash } from "viem";

chai.use(chaiAsPromised);

/// |a - b| <= tol, for bigints (chai 4 closeTo takes numbers only).
function near(a: bigint, b: bigint, tol: bigint) {
  const d = a > b ? a - b : b - a;
  expect(d <= tol, `${a} is not within ${tol} of ${b}`).to.equal(true);
}

// Round test prices: 2,000,000 $WIF per ETH and ETH at $2,000, so 1 $WIF = $0.001 and
// 1,000,000 $WIF = $1,000. (Mainnet on 26 Oct: ~1.83M per ETH, ETH ~$2,374.)
const USDG = (n: number) => BigInt(Math.round(n * 1_000_000));
const WIF = (n: number) => BigInt(n) * 10n ** 18n;
const ETH_USD = 2_000n * 10n ** 8n;
const DAY = 86_400n;
const HOUR = 3_600n;
const BURN = "0x000000000000000000000000000000000000dEaD";

/// sqrtPriceX96 for a pool whose currency1-per-currency0 price is `price` (both 18 decimals).
function sqrtPriceX96(priceNum: bigint, priceDen = 1n): bigint {
  const target = (priceNum << 192n) / priceDen;
  let x = target, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + target / x) / 2n; }
  return x;
}
const SPOT = sqrtPriceX96(2_000_000n); // $WIF is currency1: 2M WIF per ETH

const CONFIG = {
  ltvBps: 4_000n,
  vouchMaturity: 3n * DAY,
  minVouch: WIF(10_000),
  loanTerm: 14n * DAY,
  grace: 1n * DAY,
  feeBps: 300n,
  voucherShareBps: 3_000n,
  caps: [USDG(10), USDG(25), USDG(50), USDG(100)] as [bigint, bigint, bigint, bigint],
  feedMaxAge: 26n * HOUR,
};

async function setup(opts: { wifIsCurrency1?: boolean } = {}) {
  const wallets = await hre.viem.getWalletClients();
  const [deployer, borrower, alice, bob, lender, lender2, stranger] = wallets;
  const wif = await hre.viem.deployContract("MockERC20", ["World is Flat", "WIF", 18]);
  const usdg = await hre.viem.deployContract("MockERC20", ["Global Dollar", "USDG", 6]);
  const sv = await hre.viem.deployContract("MockStateView");
  const feed = await hre.viem.deployContract("MockAggregator");
  const c1 = opts.wifIsCurrency1 ?? true;
  await sv.write.set([c1 ? SPOT : sqrtPriceX96(1n, 2_000_000n)]);
  await feed.write.set([ETH_USD, BigInt(await time.latest())]);
  const pave = await hre.viem.deployContract("Pave", [{
    wif: wif.address, usdg: usdg.address, stateView: sv.address, poolId: zeroHash, wifIsCurrency1: c1,
    ethUsd: feed.address, ...CONFIG,
  }]);
  for (const w of [borrower, alice, bob, lender, lender2, stranger]) {
    await wif.write.mint([w.account.address, WIF(1_000_000)]);
    await usdg.write.mint([w.account.address, USDG(1_000)]);
    const max = 2n ** 256n - 1n;
    await (await hre.viem.getContractAt("MockERC20", wif.address, { client: { wallet: w } })).write.approve([pave.address, max]);
    await (await hre.viem.getContractAt("MockERC20", usdg.address, { client: { wallet: w } })).write.approve([pave.address, max]);
  }
  const as = (w: typeof deployer) => hre.viem.getContractAt("Pave", pave.address, { client: { wallet: w } });
  /// Keep the Chainlink answer fresh after a time jump.
  const refresh = async () => feed.write.set([ETH_USD, BigInt(await time.latest())]);
  return { deployer, borrower, alice, bob, lender, lender2, stranger, wif, usdg, sv, feed, pave, as, refresh };
}

type S = Awaited<ReturnType<typeof setup>>;
const addr = (w: { account: { address: `0x${string}` } }) => w.account.address;

/// Record a price mark, then move into the next hour: borrowing needs a mark from an earlier hour.
async function warm(s: S) {
  await (await s.as(s.stranger)).write.poke();
  await time.increase(HOUR);
  await s.refresh();
}

/// Alice vouches 50,000 $WIF ($50), the lender seeds $200, and the vouch matures.
async function ready(s: S, vouchWif = WIF(50_000)) {
  await (await s.as(s.alice)).write.vouch([addr(s.borrower), vouchWif]);
  await (await s.as(s.lender)).write.deposit([USDG(200)]);
  await time.increase(3n * DAY);
  await warm(s);
  await s.refresh();
}

describe("Pave", () => {
  describe("vouching", () => {
    it("refuses a self-vouch and a vouch below the minimum", async () => {
      const s = await setup();
      await expect((await s.as(s.borrower)).write.vouch([addr(s.borrower), WIF(50_000)])).to.be.rejectedWith("SelfVouch");
      await expect((await s.as(s.alice)).write.vouch([addr(s.borrower), WIF(9_999)])).to.be.rejectedWith("BelowMinVouch");
    });

    it("counts a vouch for credit only once it has matured", async () => {
      const s = await setup();
      await (await s.as(s.lender)).write.deposit([USDG(200)]);
      await (await s.as(s.alice)).write.vouch([addr(s.borrower), WIF(50_000)]);
      let c = await s.pave.read.creditOf([addr(s.borrower)]);
      expect(c.vouchedWif).to.equal(WIF(50_000));
      expect(c.matureWif).to.equal(0n);
      expect(c.available).to.equal(0n);
      await time.increase(3n * DAY);
  await warm(s);
      await s.refresh();
      c = await s.pave.read.creditOf([addr(s.borrower)]);
      expect(c.matureWif).to.equal(WIF(50_000));
      expect(c.matureUsdg).to.equal(USDG(50)); // 50,000 $WIF at $0.001
      expect(c.backed).to.equal(USDG(20)); // 40%
      expect(c.levelCap).to.equal(USDG(10)); // dirt road
      expect(c.available).to.equal(USDG(10));
    });

    it("restarts maturity when a vouch grows", async () => {
      const s = await setup();
      await ready(s);
      await (await s.as(s.alice)).write.vouch([addr(s.borrower), WIF(10_000)]);
      const c = await s.pave.read.creditOf([addr(s.borrower)]);
      expect(c.matureWif).to.equal(0n);
    });

    it("holds at most 20 vouchers per borrower", async () => {
      const s = await setup();
      const wallets = await hre.viem.getWalletClients();
      const extra = wallets.slice(7, 28);
      for (const w of extra) {
        await s.wif.write.mint([addr(w), WIF(10_000)]);
        await (await hre.viem.getContractAt("MockERC20", s.wif.address, { client: { wallet: w } })).write.approve([s.pave.address, WIF(10_000)]);
      }
      for (const w of extra.slice(0, 20)) await (await s.as(w)).write.vouch([addr(s.borrower), WIF(10_000)]);
      await expect((await s.as(extra[20])).write.vouch([addr(s.borrower), WIF(10_000)])).to.be.rejectedWith("TooManyVouchers");
    });

    it("lets a voucher take back, or the borrower hand back, a vouch when no loan is open", async () => {
      const s = await setup();
      await (await s.as(s.alice)).write.vouch([addr(s.borrower), WIF(20_000)]);
      await (await s.as(s.bob)).write.vouch([addr(s.borrower), WIF(30_000)]);
      await (await s.as(s.alice)).write.unvouch([addr(s.borrower)]);
      expect(await s.wif.read.balanceOf([addr(s.alice)])).to.equal(WIF(1_000_000));
      await (await s.as(s.borrower)).write.returnVouch([addr(s.bob)]);
      expect(await s.wif.read.balanceOf([addr(s.bob)])).to.equal(WIF(1_000_000));
      expect((await s.pave.read.vouchesOf([addr(s.borrower)])).length).to.equal(0);
      await expect((await s.as(s.alice)).write.unvouch([addr(s.borrower)])).to.be.rejectedWith("NoVouch");
    });
  });

  describe("borrowing", () => {
    it("lends up to the road's cap and charges the fee on repayment", async () => {
      const s = await setup();
      await ready(s);
      await expect((await s.as(s.borrower)).write.borrow([USDG(10.01)])).to.be.rejectedWith("OverLimit");
      await (await s.as(s.borrower)).write.borrow([USDG(10)]);
      expect(await s.usdg.read.balanceOf([addr(s.borrower)])).to.equal(USDG(1_010));
      const loan = await s.pave.read.loans([addr(s.borrower)]);
      expect(loan[0]).to.equal(USDG(10));
      expect(loan[1]).to.equal(USDG(0.3)); // 3%
      expect(await s.pave.read.idle()).to.equal(USDG(190));
      expect(await s.pave.read.outstanding()).to.equal(USDG(10));
      await expect((await s.as(s.borrower)).write.borrow([USDG(1)])).to.be.rejectedWith("LoanOpen");
    });

    it("is limited by the vouches as well as the cap", async () => {
      const s = await setup();
      await ready(s, WIF(20_000)); // $20 of vouches -> $8 backed
      await expect((await s.as(s.borrower)).write.borrow([USDG(8.01)])).to.be.rejectedWith("OverLimit");
      await (await s.as(s.borrower)).write.borrow([USDG(8)]);
    });

    it("refuses when the pool has too little", async () => {
      const s = await setup();
      await (await s.as(s.alice)).write.vouch([addr(s.borrower), WIF(50_000)]);
      await (await s.as(s.lender)).write.deposit([USDG(5)]);
      await time.increase(3n * DAY);
  await warm(s);
      await s.refresh();
      await expect((await s.as(s.borrower)).write.borrow([USDG(6)])).to.be.rejectedWith("PoolDry");
    });

    it("freezes the vouches while a loan is open", async () => {
      const s = await setup();
      await ready(s);
      await (await s.as(s.borrower)).write.borrow([USDG(10)]);
      await expect((await s.as(s.alice)).write.unvouch([addr(s.borrower)])).to.be.rejectedWith("LoanOpen");
      await expect((await s.as(s.borrower)).write.returnVouch([addr(s.alice)])).to.be.rejectedWith("LoanOpen");
    });

    it("refuses to borrow with no price seen in an earlier hour of the last 24", async () => {
      const s = await setup();
      await (await s.as(s.alice)).write.vouch([addr(s.borrower), WIF(50_000)]);
      await (await s.as(s.lender)).write.deposit([USDG(200)]);
      await time.increase(3n * DAY + HOUR);
      await s.refresh();
      await expect((await s.as(s.borrower)).write.borrow([USDG(10)])).to.be.rejectedWith("NoPriceHistory");
      await warm(s);
      await (await s.as(s.borrower)).write.borrow([USDG(10)]);
    });

    it("refuses a stale Chainlink price", async () => {
      const s = await setup();
      await ready(s);
      await time.increase(27n * HOUR);
      await (await s.as(s.stranger)).write.poke();
      await time.increase(HOUR);
      await expect((await s.as(s.borrower)).write.borrow([USDG(5)])).to.be.rejectedWith("StalePrice");
    });
  });

  describe("repaying (laying road)", () => {
    it("pays the vouchers pro rata, the rest to the pool, and raises the road", async () => {
      const s = await setup();
      await (await s.as(s.alice)).write.vouch([addr(s.borrower), WIF(30_000)]);
      await (await s.as(s.bob)).write.vouch([addr(s.borrower), WIF(10_000)]);
      await (await s.as(s.lender)).write.deposit([USDG(200)]);
      await time.increase(3n * DAY);
  await warm(s);
      await s.refresh();
      await (await s.as(s.borrower)).write.borrow([USDG(10)]);
      await (await s.as(s.borrower)).write.repay([addr(s.borrower)]);

      // fee 0.30, vouchers' 30% = 0.09: alice 3/4, bob 1/4
      expect(await s.pave.read.rewards([addr(s.alice)])).to.equal(67_500n);
      expect(await s.pave.read.rewards([addr(s.bob)])).to.equal(22_500n);
      expect(await s.pave.read.idle()).to.equal(USDG(200.21));
      expect(await s.pave.read.outstanding()).to.equal(0n);
      const lenderShares = await s.pave.read.shares([addr(s.lender)]);
      expect(await s.pave.read.shareValue([lenderShares])).to.equal(USDG(200.21));

      const p = await s.pave.read.pathOf([addr(s.borrower)]);
      expect(p.repaid).to.equal(1);
      expect(p.streak).to.equal(1);
      const c = await s.pave.read.creditOf([addr(s.borrower)]);
      expect(c.level).to.equal(1); // gravel
      expect(c.levelCap).to.equal(USDG(25));

      await (await s.as(s.alice)).write.claimRewards();
      expect(await s.usdg.read.balanceOf([addr(s.alice)])).to.equal(USDG(1_000) + 67_500n);
      await expect((await s.as(s.alice)).write.claimRewards()).to.be.rejectedWith("BadAmount");
      // vouches are free again
      await (await s.as(s.alice)).write.unvouch([addr(s.borrower)]);
    });

    it("shares the fee only with vouches in place when the loan began", async () => {
      const s = await setup();
      await ready(s);
      await (await s.as(s.borrower)).write.borrow([USDG(10)]);
      await (await s.as(s.bob)).write.vouch([addr(s.borrower), WIF(500_000)]); // just in time
      await (await s.as(s.borrower)).write.repay([addr(s.borrower)]);
      expect(await s.pave.read.rewards([addr(s.bob)])).to.equal(0n);
      expect(await s.pave.read.rewards([addr(s.alice)])).to.equal(90_000n); // all of the 30%
    });

    it("counts a late repayment but breaks the streak", async () => {
      const s = await setup();
      await ready(s);
      await (await s.as(s.borrower)).write.borrow([USDG(10)]);
      await (await s.as(s.borrower)).write.repay([addr(s.borrower)]);
      await s.refresh();
      await (await s.as(s.borrower)).write.borrow([USDG(10)]);
      await time.increase(14n * DAY + HOUR);
      await (await s.as(s.borrower)).write.repay([addr(s.borrower)]);
      const p = await s.pave.read.pathOf([addr(s.borrower)]);
      expect(p.repaid).to.equal(2);
      expect(p.streak).to.equal(0);
      expect(p.late).to.equal(1);
    });

    it("climbs the levels: dirt, gravel, cobblestone, highway", async () => {
      const s = await setup();
      await ready(s, WIF(400_000)); // $400 -> $160 backed, so only the cap binds
      const levels: number[] = [];
      for (let i = 0; i < 6; i++) {
        await s.refresh();
        const c = await s.pave.read.creditOf([addr(s.borrower)]);
        levels.push(c.level);
        await (await s.as(s.borrower)).write.borrow([c.available]);
        await (await s.as(s.borrower)).write.repay([addr(s.borrower)]);
      }
      await s.refresh();
      const c = await s.pave.read.creditOf([addr(s.borrower)]);
      expect(levels).to.deep.equal([0, 1, 1, 2, 2, 2]);
      expect(c.level).to.equal(3);
      expect(c.levelCap).to.equal(USDG(100));
    });

    it("anyone can repay for the borrower, even with the pool's price broken", async () => {
      const s = await setup();
      await ready(s);
      await (await s.as(s.borrower)).write.borrow([USDG(10)]);
      await s.sv.write.set([0n]); // StateView now reverts with BadPrice
      await time.increase(30n * HOUR); // Chainlink stale too
      await (await s.as(s.stranger)).write.repay([addr(s.borrower)]);
      expect((await s.pave.read.pathOf([addr(s.borrower)])).repaid).to.equal(1);
      expect(await s.usdg.read.balanceOf([addr(s.stranger)])).to.equal(USDG(1_000) - USDG(10.3));
    });
  });

  describe("defaults", () => {
    it("waits for the grace period, then cuts 2x the debt: the debt's worth to lenders, the rest burned", async () => {
      const s = await setup();
      await (await s.as(s.alice)).write.vouch([addr(s.borrower), WIF(30_000)]);
      await (await s.as(s.bob)).write.vouch([addr(s.borrower), WIF(20_000)]);
      await (await s.as(s.lender)).write.deposit([USDG(200)]);
      await time.increase(3n * DAY);
  await warm(s);
      await s.refresh();
      await (await s.as(s.borrower)).write.borrow([USDG(10)]);

      await time.increase(15n * DAY - HOUR);
      await s.refresh();
      await expect((await s.as(s.stranger)).write.markDefault([addr(s.borrower)])).to.be.rejectedWith("NotOverdue");
      await time.increase(2n * HOUR);
      await s.refresh();
      await (await s.as(s.stranger)).write.markDefault([addr(s.borrower)]);

      // debt 10.30 = 10,300 $WIF; cut 20,600, pro rata 3:2 -> alice 12,360, bob 8,240
      const v = await s.pave.read.vouchesOf([addr(s.borrower)]);
      const left = Object.fromEntries(v.map((x) => [getAddress(x.voucher), x.amount]));
      expect(left[getAddress(addr(s.alice))]).to.equal(WIF(30_000) - WIF(12_360));
      expect(left[getAddress(addr(s.bob))]).to.equal(WIF(20_000) - WIF(8_240));
      expect(await s.wif.read.balanceOf([BURN])).to.equal(WIF(10_300));
      near(await s.pave.read.pendingWif([addr(s.lender)]), WIF(10_300), 10n ** 6n);

      // the pool lost the principal; the road is closed
      expect(await s.pave.read.outstanding()).to.equal(0n);
      expect(await s.pave.read.idle()).to.equal(USDG(190));
      expect((await s.pave.read.pathOf([addr(s.borrower)])).defaulted).to.equal(true);
      await expect((await s.as(s.borrower)).write.borrow([USDG(1)])).to.be.rejectedWith("RoadClosed");
      await expect((await s.as(s.alice)).write.vouch([addr(s.borrower), WIF(10_000)])).to.be.rejectedWith("RoadClosed");

      // the lender collects the $WIF; vouchers take back what is left
      await (await s.as(s.lender)).write.claimWif();
      near(await s.wif.read.balanceOf([addr(s.lender)]), WIF(1_000_000) + WIF(10_300), 10n ** 6n);
      await (await s.as(s.alice)).write.unvouch([addr(s.borrower)]);
      expect(await s.wif.read.balanceOf([addr(s.alice)])).to.equal(WIF(1_000_000) - WIF(12_360));
      await expect((await s.as(s.stranger)).write.markDefault([addr(s.borrower)])).to.be.rejectedWith("NoLoan");
    });

    it("gives the lenders everything when $WIF fell below the debt", async () => {
      const s = await setup();
      await ready(s);
      await (await s.as(s.borrower)).write.borrow([USDG(10)]);
      await time.increase(15n * DAY + HOUR);
      await s.sv.write.set([sqrtPriceX96(20_000_000n)]); // $WIF -90%: 50,000 $WIF is now $5
      await s.refresh();
      await (await s.as(s.stranger)).write.markDefault([addr(s.borrower)]);
      expect(await s.wif.read.balanceOf([BURN])).to.equal(0n);
      near(await s.pave.read.pendingWif([addr(s.lender)]), WIF(50_000), 10n ** 6n);
      expect((await s.pave.read.vouchesOf([addr(s.borrower)])).length).to.equal(0);
    });

    it("keeps the lenders' claim even after most of the pool withdraws", async () => {
      const s = await setup();
      await ready(s);
      await (await s.as(s.borrower)).write.borrow([USDG(10)]);
      const sh = await s.pave.read.shares([addr(s.lender)]);
      await (await s.as(s.lender)).write.withdraw([(sh * 9n) / 10n]); // pool keeps 10% only
      await time.increase(15n * DAY + HOUR);
      await s.refresh();
      // lender still holds shares, so the $WIF goes to them
      await (await s.as(s.stranger)).write.markDefault([addr(s.borrower)]);
      expect((await s.pave.read.pendingWif([addr(s.lender)])) > 0n).to.equal(true);
    });

    it("does not give a late depositor the $WIF of an earlier default", async () => {
      const s = await setup();
      await ready(s);
      await (await s.as(s.borrower)).write.borrow([USDG(10)]);
      await time.increase(15n * DAY + HOUR);
      await s.refresh();
      await (await s.as(s.stranger)).write.markDefault([addr(s.borrower)]);
      await (await s.as(s.lender2)).write.deposit([USDG(100)]);
      expect(await s.pave.read.pendingWif([addr(s.lender2)])).to.equal(0n);
      await expect((await s.as(s.lender2)).write.claimWif()).to.be.rejectedWith("BadAmount");
    });
  });

  describe("lender pool", () => {
    it("prices shares by the pool's value and pays out only what is not lent", async () => {
      const s = await setup();
      await ready(s);
      await (await s.as(s.borrower)).write.borrow([USDG(10)]);
      await (await s.as(s.lender2)).write.deposit([USDG(100)]);
      const sh1 = await s.pave.read.shares([addr(s.lender)]);
      const sh2 = await s.pave.read.shares([addr(s.lender2)]);
      expect(sh1).to.equal(sh2 * 2n); // same price before any fee
      await (await s.as(s.borrower)).write.repay([addr(s.borrower)]);
      // lender part of the fee: 0.21, shared 2:1
      expect(await s.pave.read.shareValue([sh1])).to.equal(USDG(200.14));
      await (await s.as(s.lender2)).write.withdraw([sh2]);
      expect(await s.usdg.read.balanceOf([addr(s.lender2)])).to.equal(USDG(1_000.07));
    });

    it("refuses a withdrawal larger than the idle cash", async () => {
      const s = await setup();
      await (await s.as(s.alice)).write.vouch([addr(s.borrower), WIF(50_000)]);
      await (await s.as(s.lender)).write.deposit([USDG(10)]);
      await time.increase(3n * DAY);
  await warm(s);
      await s.refresh();
      await (await s.as(s.borrower)).write.borrow([USDG(10)]);
      const sh = await s.pave.read.shares([addr(s.lender)]);
      await expect((await s.as(s.lender)).write.withdraw([sh])).to.be.rejectedWith("PoolDry");
    });

    it("refuses a token that skims transfers", async () => {
      const s = await setup();
      await s.usdg.write.setSkim([100n]);
      await expect((await s.as(s.lender)).write.deposit([USDG(10)])).to.be.rejectedWith("TransferFailed");
    });
  });

  describe("prices", () => {
    it("values $WIF at the lowest price of the last 24 hours, so a pump does not raise credit", async () => {
      const s = await setup();
      await ready(s, WIF(20_000)); // $8 backed at the real price
      await (await s.as(s.stranger)).write.poke();
      await s.sv.write.set([sqrtPriceX96(200_000n)]); // $WIF pumped 10x
      await s.refresh();
      const c = await s.pave.read.creditOf([addr(s.borrower)]);
      expect(c.backed).to.equal(USDG(8));
      await expect((await s.as(s.borrower)).write.borrow([USDG(8.01)])).to.be.rejectedWith("OverLimit");
    });

    it("a dip lowers credit for 24 hours, then it recovers", async () => {
      const s = await setup();
      await ready(s, WIF(20_000));
      await s.sv.write.set([sqrtPriceX96(4_000_000n)]); // $WIF halves
      await (await s.as(s.stranger)).write.poke();
      await s.sv.write.set([SPOT]); // and recovers in the same hour
      expect((await s.pave.read.creditOf([addr(s.borrower)])).backed).to.equal(USDG(4));
      await time.increase(25n * HOUR);
      await s.refresh();
      expect((await s.pave.read.creditOf([addr(s.borrower)])).backed).to.equal(USDG(8));
    });

    it("reads the same price whichever side of the pool $WIF is on", async () => {
      const a = await setup({ wifIsCurrency1: true });
      const b = await setup({ wifIsCurrency1: false });
      const pa = await a.pave.read.prices();
      const pb = await b.pave.read.prices();
      expect(pa[3]).to.equal(USDG(1_000)); // 1M $WIF = $1,000
      near(pb[3], USDG(1_000), 2n);
    });

    it("refuses a bad configuration", async () => {
      const s = await setup();
      const base = { wif: s.wif.address, usdg: s.usdg.address, stateView: s.sv.address, poolId: zeroHash, wifIsCurrency1: true, ethUsd: s.feed.address, ...CONFIG };
      await expect(hre.viem.deployContract("Pave", [{ ...base, ltvBps: 6_000n }])).to.be.rejectedWith("BadConfig");
      await expect(hre.viem.deployContract("Pave", [{ ...base, caps: [USDG(20), USDG(10), USDG(50), USDG(100)] }])).to.be.rejectedWith("BadConfig");
      await s.feed.write.setDecimals([18]);
      await expect(hre.viem.deployContract("Pave", [base])).to.be.rejectedWith("BadConfig");
    });
  });
});
