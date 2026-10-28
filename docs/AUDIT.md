# Pave security review

**What this is:** an internal review of `contracts/Pave.sol`, done while building it (28 Oct 2026).
It is not an independent third-party audit. The contract has no owner and cannot be upgraded or
paused, so anything wrong with a deployment stays wrong; the only fix is a new deployment.

## Scope and method

- `contracts/Pave.sol` (about 14.3 KB deployed; Solidity 0.8.24, optimizer 200 runs, no external libraries).
- A line-by-line read as an attacker: every external function, every token movement, every price read.
- 27 unit tests (`test/Pave.test.ts`) using mocks for the tokens, the pool price and the feed.
- 4 tests on a copy of Robinhood Chain mainnet (`test/Pave.fork.test.ts`) using the real $WIF,
  USDG, Pons pool (through Uniswap v4's StateView) and Chainlink ETH/USD. These confirmed that
  neither token takes a fee on transfer, and that the price matches the market (1 $WIF ≈ $0.00116
  on 28 Oct).

## How the money is protected

| Risk | Protection |
|---|---|
| A borrower doesn't repay | Credit is at most 40% of the vouches' value, and a default takes up to 2x the debt in $WIF. When the loan is made, the vouches cover the debt about 2.4 times. |
| Fake wallets / self-vouching | A borrower who vouches for themself from other wallets has only posted their own $WIF as collateral. Lenders stay covered whatever the identities are. |
| The $WIF price pumped to borrow more | Value is taken at the **lowest** price among the spot and 24 hourly marks. Borrowing also needs a mark from an earlier hour, so a pump inside one transaction can't count. |
| A stale or broken ETH/USD price | Chainlink answers older than 26 h, or not positive, are refused. The feed must use 8 decimals. |
| A broken price stops repayment | `repay` reads no price at all, so a borrower can always repay. Taking a vouch back and claiming rewards don't read prices either. |
| Re-entrancy | Every external function that changes state holds a lock. Tokens move after the books are updated. |
| Tokens that take a fee on transfer | Each deposit is checked by balance difference; a short amount is refused. |
| One person blocking another | Rewards and $WIF are collected by each person (pulled), never pushed. Loops are capped at 20 vouchers. A borrower can hand back vouches to free slots. |

## Findings fixed during the review

1. **Medium: a price pumped on a quiet pool.** If nothing touched Pave for 24 h, the price memory was
   empty, so a pump and a borrow in one transaction would value $WIF at the pumped price.
   *Fix:* `borrow` requires a price mark from an earlier hour within 24 h (`NoPriceHistory`).
   *Test:* "refuses to borrow with no price seen in an earlier hour of the last 24".
2. **Low: vouching just in time for rewards.** A vouch added one block before a repayment took a
   share of the fee without any risk. *Fix:* only vouches in place when the loan began share the
   fee. *Test:* "shares the fee only with vouches in place when the loan began".
3. **Low: a feed with other decimals.** The maths assumes an 8-decimal ETH/USD feed.
   *Fix:* deployment refuses any other.
4. **Low: a price read inside `repay`.** A broken pool or feed would have blocked repayment and forced
   a default. *Fix:* `repay` no longer reads prices. *Test:* "anyone can repay for the borrower,
   even with the pool's price broken".
5. **Info: error order in `borrow`.** A closed road reported a price error first; the borrower's own
   checks now come first.

## Known risks, accepted for this version

- **$WIF crashing during a loan.** If $WIF falls more than about 60% between borrowing and
  default, the slashed $WIF may be worth less than the debt and lenders lose the difference.
  Short terms (14 days) and small caps ($10–$100) limit this.
- **Lenders leaving before a default.** Share value counts open loans at face value, so a lender who
  sees a loan going bad can withdraw (from idle cash) before `markDefault` is called, leaving the
  loss to the others. The amounts are small. Anyone can call `markDefault` the moment grace ends.
- **Deposits timed around a repayment.** A deposit just before a repayment gets part of that loan's
  fee. The fee is 3% of at most $100, so it isn't worth the gas.
- **A price dump to grief.** Dumping $WIF in the pool lowers every credit line for 24 h and makes a
  default take more $WIF (still at most 2x the debt, and never more than the vouches). Dumping costs
  the pool's 1% fee each way on the size needed, which is far more than it can win.
- **Lender payouts are in $WIF.** Lenders receive slashed $WIF, not USDG, and they carry its price risk.
- **USDG can be frozen by Paxos.** If the contract's address were frozen, USDG could not move.
- **Chainlink on an L2.** Robinhood Chain has no sequencer-uptime feed listed. Pave relies on
  freshness (26 h) alone.
- **The price memory needs activity.** Every vouch, borrow and default records the price, and anyone
  can call `poke()`. The site pokes on page load. Without an earlier mark, borrowing pauses (safe)
  and nothing else is affected.
- **Vouching during an open loan.** That $WIF is at risk for the loan at once, but it earns no share
  of that loan's fee. Topping up a vouch also restarts its maturity.
- **No admin.** Parameters are fixed at deployment, and nobody can pause, upgrade or rescue funds.

## Parameters at launch (`scripts/config.ts`)

40% of mature vouch value · vouches mature after 3 days · minimum vouch 10,000 $WIF · 14-day
loans · 1-day grace · 3% fee, 30% of it to the vouchers · road caps $10 / $25 / $50 / $100
(0 / 1 / 3 / 6 loans repaid) · Chainlink answers up to 26 h old.
