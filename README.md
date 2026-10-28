# Pave

**Credit backed by people who believe in you.** Built on Robinhood Chain for the World is Flat
$WIF hackathon.

A credit score only exists where you were born. Pave starts one from the people who know you:
friends lock $WIF behind your wallet, and you can borrow a small USDG loan from a shared pool.
Every loan you repay lays more road. Your level rises from dirt to gravel to cobblestone to
highway, and your vouchers earn part of the fee. If you don't repay, their $WIF is cut: part
goes to the lenders and the rest is burned.

## How it works

| Step | Who | What happens |
|---|---|---|
| Vouch | Friends | Lock $WIF behind a wallet. It counts once it has stayed 3 days. |
| Borrow | Borrower | Up to 40% of the vouches' value, never above the road's cap. |
| Repay | Anyone | Pays principal + 3%. The road grows, and vouchers share 30% of the fee. |
| Default | Anyone, after due date + 1 day | Up to 2x the debt in $WIF is cut: one debt's worth to lenders, the rest burned. |
| Lend | Lenders | Deposit USDG for pool shares, and earn the rest of the fees. |

Fake wallets gain nothing: vouching for yourself from other wallets is just posting your own
$WIF as collateral. $WIF is priced by the Pons pool (Uniswap v4) and ETH by Chainlink, always at
the lowest price of the last 24 hours, so a pump can't raise anyone's credit.

## For lending sites

Any app can read a wallet's credit:

```solidity
Pave.Credit memory c = pave.creditOf(wallet);
// c.vouchedWif, c.matureUsdg, c.available, c.level, c.vouchers, c.path.repaid, c.path.defaulted
```

## Develop

```sh
npm install
npm test            # 27 unit tests
npm run test:fork   # 4 tests on a copy of Robinhood Chain mainnet (real $WIF, USDG, pool, Chainlink)
```

Security: see [docs/AUDIT.md](docs/AUDIT.md). The contract has no owner, admin or upgrade.

$WIF is a memecoin. Pave is an experiment: lend and vouch only what you can afford to lose.
Not affiliated with Robinhood.
