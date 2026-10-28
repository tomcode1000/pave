// Robinhood Chain mainnet (4663): everything Pave reads, checked on chain 26-28 Oct 2026.
export const MAINNET = {
  // $WIF (18 dp), launched on Pons v2
  wif: "0x5173b8eA6923c2d40267890D45C46a3480954773",
  // Paxos USDG (6 dp)
  usdg: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168",
  // Uniswap v4 StateView, and the Pons $WIF/ETH pool (currency0 native ETH, currency1 $WIF)
  stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
  poolId: "0x71ef4106340f0a3b9c19ec994eef4fc44a1d2513f38faac39d7636b156548c79",
  wifIsCurrency1: true,
  // Chainlink ETH / USD (8 dp, 24 h heartbeat, 0.5% deviation)
  ethUsd: "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9",
  // used only by the fork test, to fund test wallets
  wifHolder: "0x8366a39cc670b4001a1121b8f6a443a643e40951", // Uniswap v4 PoolManager
  usdgHolder: "0x1E8Fc442AD3606719F7016DED6C17B56C3cA7386",
} as const;

const DAY = 86_400n;
const HOUR = 3_600n;

/// The live parameters. Small on purpose: this is a hackathon pool, not a bank.
export const PARAMS = {
  feedMaxAge: 26n * HOUR, // heartbeat 24 h + margin
  markPeriod: HOUR, // 24 hourly price marks
  ltvBps: 4_000n, // borrow up to 40% of the mature vouches' value
  vouchMaturity: 3n * DAY,
  minVouch: 10_000n * 10n ** 18n, // ~ $13 of $WIF
  loanTerm: 14n * DAY,
  grace: 1n * DAY,
  feeBps: 300n, // 3% flat per loan
  voucherShareBps: 3_000n, // 30% of the fee goes to the vouchers
  // dirt $10, gravel $25, cobblestone $50, highway $100
  caps: [10_000_000n, 25_000_000n, 50_000_000n, 100_000_000n] as [bigint, bigint, bigint, bigint],
};

/// Testnet: the same rules on a fast clock, so a whole loan and a default fit in under an hour.
export const TEST_PARAMS = {
  ...PARAMS,
  markPeriod: 60n, // price marks a minute long (24 minutes of memory)
  vouchMaturity: 2n * 60n,
  loanTerm: 10n * 60n,
  grace: 2n * 60n,
};
