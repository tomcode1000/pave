// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// Minimal ERC-20 surface used here ($WIF and USDG).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
}

/// Uniswap v4 StateView: the read side of the PoolManager.
interface IStateView {
    function getSlot0(bytes32 poolId)
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee);
}

/// Chainlink price feed (ETH / USD on Robinhood Chain).
interface IAggregator {
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function decimals() external view returns (uint8);
}

/// @title Pave: credit backed by people who believe in you.
/// @notice Friends lock $WIF behind a borrower's wallet ("stones in their road"). The borrower
/// can then draw a small USDG loan from a shared lender pool, up to a share of what the mature
/// vouches are worth, and never more than their road's level allows. Repaying lays road: it
/// raises the borrower's level and pays the vouchers part of the fee. Not repaying lets anyone
/// end the loan after the grace period: the vouchers' $WIF is cut, the lenders get up to the
/// debt's worth of it, and the rest is burned.
///
/// Why a vouch is safe to lend against: the credit line is at most `ltvBps` of the vouches'
/// value, and a default takes up to twice the debt in $WIF. A borrower who vouches for
/// themself from other wallets has simply posted their own $WIF as collateral, so sybils gain
/// nothing and lenders are still covered.
///
/// Prices: $WIF is priced in ETH by the Pons Uniswap v4 pool (StateView spot) and ETH in USD by
/// Chainlink. Every state change records the pool price into one of 24 hourly marks, and value
/// is always taken at the LOWEST $WIF price among the spot and the last 24 hours of marks, so a
/// price pumped inside one transaction cannot raise anyone's credit. Loans are capped small
/// (the level caps), which bounds what any remaining manipulation could be worth.
///
/// No owner, no admin, no upgrade: every parameter is fixed at deployment.
contract Pave {
    // ------------------------------------------------------------------ types

    struct Vouch {
        address voucher;
        uint128 amount; // $WIF, 18 decimals
        uint64 since; // when this vouch last grew: it counts for credit once `vouchMaturity` has passed
    }

    struct Loan {
        uint128 principal; // USDG, 6 decimals. Zero means no open loan.
        uint64 fee;
        uint64 due;
        /// The debt in $WIF at the price the loan was made at. A default never cuts the vouches as
        /// if $WIF were below `ltvBps` of that price, so a price dumped at default time can't cut deeper.
        uint128 debtWif;
    }

    /// The road: a borrower's onchain credit history.
    struct Path {
        uint32 repaid; // loans repaid
        uint32 streak; // repaid on time in a row
        uint32 late; // repaid after the due date
        bool defaulted; // a default ends the road: this wallet can never borrow again
    }

    struct Mark {
        uint32 hour;
        uint224 wifPerEthX96; // the highest WIF-per-ETH seen in that hour = $WIF's lowest price
    }

    struct Credit {
        uint256 vouchedWif; // all $WIF behind the borrower
        uint256 matureWif; // the part old enough to count
        uint256 matureUsdg; // its value at the low price
        uint256 backed; // matureUsdg * ltv
        uint256 levelCap; // the road's limit
        uint256 available; // what can be borrowed now
        uint8 level; // 0 dirt, 1 gravel, 2 cobblestone, 3 highway
        uint256 vouchers;
        Path path;
        Loan loan;
    }

    // ------------------------------------------------------------------ constants

    uint256 internal constant BPS = 10_000;
    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant ACC = 1e36; // $WIF-per-share precision
    /// Shares per USDG unit at the start. The pool is valued as if it held these shares and one
    /// more USDG unit, so a pool emptied by a default still takes deposits (at a fresh price).
    uint256 internal constant VIRTUAL_SHARES = 1e12;
    uint256 public constant MAX_VOUCHERS = 20;
    uint256 public constant SLASH_MULTIPLE = 2; // a default takes up to 2x the debt in $WIF
    uint256 public constant WINDOW_HOURS = 24;
    address public constant BURN = 0x000000000000000000000000000000000000dEaD;

    // ------------------------------------------------------------------ configuration

    IERC20 public immutable wif;
    IERC20 public immutable usdg;
    IStateView public immutable stateView;
    bytes32 public immutable poolId;
    /// True when $WIF is the pool's currency1 (the Pons pool: currency0 is native ETH).
    bool public immutable wifIsCurrency1;
    IAggregator public immutable ethUsd;
    uint256 public immutable feedMaxAge;
    /// Length of one price mark in seconds (3600 on mainnet: 24 marks = the last 24 hours).
    uint256 public immutable markPeriod;
    /// Borrowing needs price marks from at least this many earlier periods in the window, so a
    /// price pumped at the first reading of a few quiet hours can't be the only one counted.
    uint256 public immutable minMarks;

    uint256 public immutable ltvBps;
    uint256 public immutable vouchMaturity;
    uint256 public immutable minVouch;
    uint256 public immutable loanTerm;
    uint256 public immutable grace;
    uint256 public immutable feeBps;
    uint256 public immutable voucherShareBps;
    /// Road levels: the most a borrower can owe after 0, 1, 3 and 6 loans repaid.
    uint256 public immutable cap0;
    uint256 public immutable cap1;
    uint256 public immutable cap2;
    uint256 public immutable cap3;

    // ------------------------------------------------------------------ state

    mapping(address => Vouch[]) internal _vouches;
    /// borrower => voucher => index in _vouches[borrower] + 1 (0 = none)
    mapping(address => mapping(address => uint256)) internal _slot;
    mapping(address => Loan) public loans;
    mapping(address => Path) internal _paths;

    /// Lender pool (USDG). `idle` is held here; `outstanding` is lent out.
    uint256 public idle;
    uint256 public outstanding;
    uint256 public totalShares;
    mapping(address => uint256) public shares;
    /// $WIF taken from defaults, shared by the lenders who held shares at that moment.
    uint256 public accWifPerShare;
    mapping(address => uint256) internal _wifDebt;
    mapping(address => uint256) internal _wifOwed;

    /// Vouchers' share of repaid fees, waiting to be claimed (not part of the pool).
    mapping(address => uint256) public rewards;
    uint256 public totalRewards;

    Mark[24] internal _marks;
    uint256 internal _lock = 1;

    // ------------------------------------------------------------------ events

    event Vouched(address indexed borrower, address indexed voucher, uint256 amount, uint256 total);
    event Unvouched(address indexed borrower, address indexed voucher, uint256 amount);
    event Borrowed(address indexed borrower, uint256 principal, uint256 fee, uint256 due, uint8 level);
    event Repaid(address indexed borrower, address indexed payer, uint256 owed, bool late, uint32 repaid, uint32 streak);
    event VoucherRewarded(address indexed borrower, address indexed voucher, uint256 amount);
    event Defaulted(address indexed borrower, address indexed caller, uint256 debt, uint256 wifToLenders, uint256 wifBurned);
    event Slashed(address indexed borrower, address indexed voucher, uint256 amount);
    event Deposited(address indexed lender, uint256 amount, uint256 shares);
    event Withdrawn(address indexed lender, uint256 amount, uint256 shares);
    event WifClaimed(address indexed lender, uint256 amount);
    event RewardsClaimed(address indexed voucher, uint256 amount);

    // ------------------------------------------------------------------ errors

    error Reentrancy();
    error BadConfig();
    error BadAmount();
    error SelfVouch();
    error RoadClosed();
    error TooManyVouchers();
    error BelowMinVouch();
    error LoanOpen();
    error NoLoan();
    error NoVouch();
    error OverLimit();
    error PoolDry();
    error NotOverdue();
    error StalePrice();
    error BadPrice();
    error TransferFailed();
    error NoPriceHistory();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    struct Config {
        address wif;
        address usdg;
        address stateView;
        bytes32 poolId;
        bool wifIsCurrency1;
        address ethUsd;
        uint256 feedMaxAge;
        uint256 markPeriod;
        uint256 minMarks;
        uint256 ltvBps;
        uint256 vouchMaturity;
        uint256 minVouch;
        uint256 loanTerm;
        uint256 grace;
        uint256 feeBps;
        uint256 voucherShareBps;
        uint256[4] caps;
    }

    constructor(Config memory c) {
        if (
            c.wif == address(0) || c.usdg == address(0) || c.stateView == address(0) || c.ethUsd == address(0)
                || c.ltvBps == 0 || c.ltvBps * SLASH_MULTIPLE > BPS || c.feeBps > 2_000 || c.voucherShareBps > BPS
                || c.loanTerm == 0 || c.minVouch == 0 || c.feedMaxAge == 0 || c.markPeriod == 0 || c.minMarks == 0
                || c.minMarks >= WINDOW_HOURS || c.caps[3] > type(uint64).max || c.caps[0] == 0 || c.caps[0] > c.caps[1]
                || c.caps[1] > c.caps[2] || c.caps[2] > c.caps[3]
        ) revert BadConfig();
        if (IAggregator(c.ethUsd).decimals() != 8) revert BadConfig();
        wif = IERC20(c.wif);
        usdg = IERC20(c.usdg);
        stateView = IStateView(c.stateView);
        poolId = c.poolId;
        wifIsCurrency1 = c.wifIsCurrency1;
        ethUsd = IAggregator(c.ethUsd);
        feedMaxAge = c.feedMaxAge;
        markPeriod = c.markPeriod;
        minMarks = c.minMarks;
        ltvBps = c.ltvBps;
        vouchMaturity = c.vouchMaturity;
        minVouch = c.minVouch;
        loanTerm = c.loanTerm;
        grace = c.grace;
        feeBps = c.feeBps;
        voucherShareBps = c.voucherShareBps;
        cap0 = c.caps[0];
        cap1 = c.caps[1];
        cap2 = c.caps[2];
        cap3 = c.caps[3];
    }

    // ================================================================== vouching

    /// Lock $WIF behind `borrower`. Adding to an existing vouch restarts its maturity.
    /// Vouching for someone with an open loan puts this $WIF at risk for that loan at once.
    function vouch(address borrower, uint256 amount) external nonReentrant {
        if (borrower == msg.sender) revert SelfVouch();
        if (borrower == address(0) || amount == 0 || amount > type(uint128).max) revert BadAmount();
        if (_paths[borrower].defaulted) revert RoadClosed();
        _checkpoint();

        uint256 slot = _slot[borrower][msg.sender];
        uint256 total;
        if (slot == 0) {
            if (_vouches[borrower].length >= MAX_VOUCHERS) revert TooManyVouchers();
            if (amount < minVouch) revert BelowMinVouch();
            _vouches[borrower].push(Vouch(msg.sender, uint128(amount), uint64(block.timestamp)));
            _slot[borrower][msg.sender] = _vouches[borrower].length;
            total = amount;
        } else {
            Vouch storage v = _vouches[borrower][slot - 1];
            total = uint256(v.amount) + amount;
            if (total > type(uint128).max) revert BadAmount();
            v.amount = uint128(total);
            v.since = uint64(block.timestamp);
        }
        _pull(wif, msg.sender, amount);
        emit Vouched(borrower, msg.sender, amount, total);
    }

    /// Take a vouch back. Not while the borrower has an open loan: that $WIF backs it.
    function unvouch(address borrower) external nonReentrant {
        _release(borrower, msg.sender);
    }

    /// The borrower can hand a vouch back (for example to free a slot), on the same terms.
    function returnVouch(address voucher) external nonReentrant {
        _release(msg.sender, voucher);
    }

    function _release(address borrower, address voucher) internal {
        if (loans[borrower].principal != 0) revert LoanOpen();
        uint256 slot = _slot[borrower][voucher];
        if (slot == 0) revert NoVouch();
        uint256 amount = _vouches[borrower][slot - 1].amount;
        _remove(borrower, slot - 1);
        _push(wif, voucher, amount);
        emit Unvouched(borrower, voucher, amount);
    }

    function _remove(address borrower, uint256 i) internal {
        Vouch[] storage list = _vouches[borrower];
        uint256 lastIndex = list.length - 1;
        delete _slot[borrower][list[i].voucher];
        if (i != lastIndex) {
            list[i] = list[lastIndex];
            _slot[borrower][list[i].voucher] = i + 1;
        }
        list.pop();
    }

    // ================================================================== borrowing

    /// Borrow USDG against the mature vouches behind you. One open loan at a time.
    function borrow(uint256 amount) external nonReentrant {
        Path memory p = _paths[msg.sender];
        if (p.defaulted) revert RoadClosed();
        if (loans[msg.sender].principal != 0) revert LoanOpen();
        if (amount == 0) revert BadAmount();
        uint256 low = _checkpoint();
        // The price must have been seen in earlier hours too: with an empty memory, a price
        // pumped inside this very transaction would be the only one counted.
        if (!_hasHistory(block.timestamp / markPeriod)) revert NoPriceHistory();
        uint256 eth = _ethUsd();
        (, uint256 matureWif) = _sums(msg.sender);
        uint256 backed = (_wifToUsdg(matureWif, low, eth) * ltvBps) / BPS;
        uint256 cap = _cap(p.repaid);
        if (amount > backed || amount > cap) revert OverLimit();
        if (amount > idle) revert PoolDry();

        uint256 fee = _ceilDiv(amount * feeBps, BPS);
        uint256 debtWif = _usdgToWif(amount + fee, low, eth);
        if (debtWif > type(uint128).max) revert BadPrice();
        uint64 due = uint64(block.timestamp + loanTerm);
        loans[msg.sender] = Loan(uint128(amount), uint64(fee), due, uint128(debtWif));
        idle -= amount;
        outstanding += amount;
        _push(usdg, msg.sender, amount);
        emit Borrowed(msg.sender, amount, fee, due, _level(p.repaid));
    }

    /// Repay a loan in full (anyone may pay it for the borrower). Late repayment still counts
    /// on the road, but breaks the streak.
    function repay(address borrower) external nonReentrant {
        // No price read here on purpose: a broken pool or feed must never stop a repayment.
        Loan memory l = loans[borrower];
        if (l.principal == 0) revert NoLoan();
        uint256 owed = uint256(l.principal) + l.fee;
        delete loans[borrower];

        Path storage p = _paths[borrower];
        bool late = block.timestamp > l.due;
        p.repaid += 1;
        if (late) {
            p.streak = 0;
            p.late += 1;
        } else {
            p.streak += 1;
        }

        // Part of the fee goes to the vouchers, pro rata to their $WIF; the rest, with the
        // principal, back to the pool.
        uint256 toVouchers = (uint256(l.fee) * voucherShareBps) / BPS;
        uint256 paid = _payVouchers(borrower, toVouchers, uint256(l.due) - loanTerm);
        outstanding -= l.principal;
        idle += owed - paid;

        _pull(usdg, msg.sender, owed);
        emit Repaid(borrower, msg.sender, owed, late, p.repaid, p.streak);
    }

    /// Only vouches already in place when the loan began share the fee: a vouch added (or
    /// topped up) during the loan took less risk, and one added just before repayment none.
    function _payVouchers(address borrower, uint256 amount, uint256 start) internal returns (uint256 paid) {
        if (amount == 0) return 0;
        Vouch[] storage list = _vouches[borrower];
        uint256 total;
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i].since <= start) total += list[i].amount;
        }
        if (total == 0) return 0;
        for (uint256 i = 0; i < list.length; i++) {
            if (list[i].since > start) continue;
            uint256 share = (amount * list[i].amount) / total;
            if (share == 0) continue;
            rewards[list[i].voucher] += share;
            paid += share;
            emit VoucherRewarded(borrower, list[i].voucher, share);
        }
        totalRewards += paid;
    }

    /// End an unpaid loan once the grace period is over. Anyone may call it.
    /// The vouchers' $WIF is cut pro rata, up to twice the debt's worth: the lenders get up to
    /// the debt's worth, the rest is burned. The borrower's road is closed for good.
    /// The debt is valued at the low price. The cut, though, never treats $WIF as cheaper than
    /// `ltvBps` of the price the loan was made at (where the vouches were worth just the debt), so a
    /// price dumped for one transaction can't take every voucher's stone. A real crash deeper than
    /// that still sends the lenders everything cut, up to the debt.
    function markDefault(address borrower) external nonReentrant {
        uint256 low = _checkpoint();
        Loan memory l = loans[borrower];
        if (l.principal == 0) revert NoLoan();
        if (block.timestamp <= uint256(l.due) + grace) revert NotOverdue();
        delete loans[borrower];

        Path storage p = _paths[borrower];
        p.defaulted = true;
        p.streak = 0;
        outstanding -= l.principal;

        uint256 debt = uint256(l.principal) + l.fee;
        uint256 debtWif = _usdgToWif(debt, low, _ethUsd());
        uint256 floor = (uint256(l.debtWif) * BPS) / ltvBps;
        (uint256 total,) = _sums(borrower);
        uint256 target = (debtWif < floor ? debtWif : floor) * SLASH_MULTIPLE;
        uint256 slash = target < total ? target : total;

        uint256 taken;
        if (slash != 0) {
            Vouch[] storage list = _vouches[borrower];
            for (uint256 i = list.length; i > 0; i--) {
                Vouch storage v = list[i - 1];
                uint256 cut = (slash * v.amount) / total;
                if (cut == 0) continue;
                v.amount -= uint128(cut);
                taken += cut;
                emit Slashed(borrower, v.voucher, cut);
                if (v.amount == 0) _remove(borrower, i - 1);
            }
        }

        uint256 toLenders = taken < debtWif ? taken : debtWif;
        if (totalShares == 0) toLenders = 0;
        uint256 burned = taken - toLenders;
        if (toLenders != 0) {
            accWifPerShare += (toLenders * ACC) / totalShares;
        }
        if (burned != 0) _push(wif, BURN, burned);
        emit Defaulted(borrower, msg.sender, debt, toLenders, burned);
    }

    // ================================================================== lenders

    /// Add USDG to the pool for pool shares. The share price counts open loans at face value.
    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert BadAmount();
        _settle(msg.sender);
        uint256 minted = (amount * (totalShares + VIRTUAL_SHARES)) / (idle + outstanding + 1);
        if (minted == 0) revert BadAmount();
        shares[msg.sender] += minted;
        totalShares += minted;
        idle += amount;
        _wifDebt[msg.sender] = (shares[msg.sender] * accWifPerShare) / ACC;
        _pull(usdg, msg.sender, amount);
        emit Deposited(msg.sender, amount, minted);
    }

    /// Burn pool shares for their USDG value, out of what is not lent out right now.
    function withdraw(uint256 shareAmount) external nonReentrant {
        if (shareAmount == 0 || shareAmount > shares[msg.sender]) revert BadAmount();
        _settle(msg.sender);
        uint256 value = _value(shareAmount);
        if (value > idle) revert PoolDry();
        shares[msg.sender] -= shareAmount;
        totalShares -= shareAmount;
        idle -= value;
        _wifDebt[msg.sender] = (shares[msg.sender] * accWifPerShare) / ACC;
        _push(usdg, msg.sender, value);
        emit Withdrawn(msg.sender, value, shareAmount);
    }

    /// Collect the $WIF your pool shares earned from defaults.
    function claimWif() external nonReentrant {
        _settle(msg.sender);
        uint256 amount = _wifOwed[msg.sender];
        if (amount == 0) revert BadAmount();
        _wifOwed[msg.sender] = 0;
        _push(wif, msg.sender, amount);
        emit WifClaimed(msg.sender, amount);
    }

    /// Collect your share of repaid fees as a voucher.
    function claimRewards() external nonReentrant {
        uint256 amount = rewards[msg.sender];
        if (amount == 0) revert BadAmount();
        rewards[msg.sender] = 0;
        totalRewards -= amount;
        _push(usdg, msg.sender, amount);
        emit RewardsClaimed(msg.sender, amount);
    }

    function _value(uint256 shareAmount) internal view returns (uint256) {
        return (shareAmount * (idle + outstanding + 1)) / (totalShares + VIRTUAL_SHARES);
    }

    function _settle(address lender) internal {
        uint256 accrued = (shares[lender] * accWifPerShare) / ACC;
        uint256 debt = _wifDebt[lender];
        if (accrued > debt) _wifOwed[lender] += accrued - debt;
        _wifDebt[lender] = accrued;
    }

    // ================================================================== prices

    /// Record the pool's price into this hour's mark. Anyone may call it; every state change does.
    function poke() external {
        _checkpoint();
    }

    /// Records the spot price, then returns the lowest $WIF price (highest WIF-per-ETH) among
    /// the spot and the marks of the last 24 hours.
    function _checkpoint() internal returns (uint256 low) {
        uint256 spot = _spotWifPerEthX96();
        uint256 hour = block.timestamp / markPeriod;
        Mark storage m = _marks[hour % WINDOW_HOURS];
        if (m.hour != hour) {
            m.hour = uint32(hour);
            m.wifPerEthX96 = uint224(spot);
        } else if (spot > m.wifPerEthX96) {
            m.wifPerEthX96 = uint224(spot);
        }
        return _low(spot, hour);
    }

    function _hasHistory(uint256 hour) internal view returns (bool) {
        uint256 seen;
        for (uint256 i = 0; i < WINDOW_HOURS; i++) {
            Mark memory m = _marks[i];
            if (m.hour != 0 && m.hour < hour && m.hour + WINDOW_HOURS > hour) seen++;
        }
        return seen >= minMarks;
    }

    function _low(uint256 spot, uint256 hour) internal view returns (uint256 low) {
        low = spot;
        for (uint256 i = 0; i < WINDOW_HOURS; i++) {
            Mark memory m = _marks[i];
            if (m.hour != 0 && m.hour + WINDOW_HOURS > hour && m.wifPerEthX96 > low) low = m.wifPerEthX96;
        }
    }

    /// $WIF per ETH (both 18 decimals), as a Q96 fixed-point number, from the pool's spot price.
    function _spotWifPerEthX96() internal view returns (uint256) {
        (uint160 sqrtPriceX96,,,) = stateView.getSlot0(poolId);
        if (sqrtPriceX96 == 0) revert BadPrice();
        // currency1 per currency0, Q96
        uint256 price1Per0X96 = _mulDiv(sqrtPriceX96, sqrtPriceX96, Q96);
        if (price1Per0X96 == 0) revert BadPrice();
        uint256 result = wifIsCurrency1 ? price1Per0X96 : _mulDiv(Q96, Q96, price1Per0X96);
        if (result == 0 || result > type(uint224).max) revert BadPrice();
        return result;
    }

    /// ETH / USD, 8 decimals, from Chainlink. Refuses a stale or non-positive answer.
    function _ethUsd() internal view returns (uint256) {
        (, int256 answer,, uint256 updatedAt,) = ethUsd.latestRoundData();
        if (answer <= 0) revert BadPrice();
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > feedMaxAge) revert StalePrice();
        return uint256(answer);
    }

    /// $WIF (18 dp) -> USDG (6 dp): wif / wifPerEth = ETH; ETH * ethUsd(8 dp) / 1e20 = USDG.
    function _wifToUsdg(uint256 wifAmount, uint256 wifPerEthX96, uint256 ethUsd8) internal pure returns (uint256) {
        if (wifAmount == 0) return 0;
        uint256 ethWei = _mulDiv(wifAmount, Q96, wifPerEthX96);
        return _mulDiv(ethWei, ethUsd8, 1e20);
    }

    /// USDG (6 dp) -> $WIF (18 dp), rounded up.
    function _usdgToWif(uint256 usdgAmount, uint256 wifPerEthX96, uint256 ethUsd8) internal pure returns (uint256) {
        uint256 ethWei = _ceilDiv(usdgAmount * 1e20, ethUsd8);
        uint256 w = _mulDiv(ethWei, wifPerEthX96, Q96);
        return mulmod(ethWei, wifPerEthX96, Q96) == 0 ? w : w + 1;
    }

    // ================================================================== reads

    /// What a lending site reads when you connect your wallet.
    function creditOf(address borrower) external view returns (Credit memory c) {
        (c.vouchedWif, c.matureWif) = _sums(borrower);
        c.path = _paths[borrower];
        c.loan = loans[borrower];
        c.level = _level(c.path.repaid);
        c.levelCap = _cap(c.path.repaid);
        c.vouchers = _vouches[borrower].length;
        uint256 low = _low(_spotWifPerEthX96(), block.timestamp / markPeriod);
        c.matureUsdg = _wifToUsdg(c.matureWif, low, _ethUsd());
        c.backed = (c.matureUsdg * ltvBps) / BPS;
        if (!c.path.defaulted && c.loan.principal == 0) {
            uint256 a = c.backed < c.levelCap ? c.backed : c.levelCap;
            c.available = a < idle ? a : idle;
        }
    }

    function vouchesOf(address borrower) external view returns (Vouch[] memory) {
        return _vouches[borrower];
    }

    function pathOf(address borrower) external view returns (Path memory) {
        return _paths[borrower];
    }

    /// $WIF earned from defaults and not yet claimed.
    function pendingWif(address lender) external view returns (uint256) {
        uint256 accrued = (shares[lender] * accWifPerShare) / ACC;
        uint256 debt = _wifDebt[lender];
        return _wifOwed[lender] + (accrued > debt ? accrued - debt : 0);
    }

    /// The USDG value of `shareAmount` pool shares.
    function shareValue(uint256 shareAmount) external view returns (uint256) {
        return _value(shareAmount);
    }

    /// Prices as the contract sees them: spot and low WIF-per-ETH (Q96), ETH/USD (8 dp), and
    /// what 1,000,000 $WIF is worth in USDG at each.
    function prices()
        external
        view
        returns (uint256 spotX96, uint256 lowX96, uint256 ethUsd8, uint256 millionAtSpot, uint256 millionAtLow)
    {
        spotX96 = _spotWifPerEthX96();
        lowX96 = _low(spotX96, block.timestamp / markPeriod);
        ethUsd8 = _ethUsd();
        millionAtSpot = _wifToUsdg(1_000_000e18, spotX96, ethUsd8);
        millionAtLow = _wifToUsdg(1_000_000e18, lowX96, ethUsd8);
    }

    function levelOf(uint256 repaid) external pure returns (uint8) {
        return _level(repaid);
    }

    // ================================================================== internals

    function _sums(address borrower) internal view returns (uint256 total, uint256 mature) {
        Vouch[] storage list = _vouches[borrower];
        for (uint256 i = 0; i < list.length; i++) {
            total += list[i].amount;
            if (block.timestamp >= uint256(list[i].since) + vouchMaturity) mature += list[i].amount;
        }
    }

    function _level(uint256 repaid) internal pure returns (uint8) {
        if (repaid >= 6) return 3;
        if (repaid >= 3) return 2;
        if (repaid >= 1) return 1;
        return 0;
    }

    function _cap(uint256 repaid) internal view returns (uint256) {
        uint8 l = _level(repaid);
        return l == 3 ? cap3 : l == 2 ? cap2 : l == 1 ? cap1 : cap0;
    }

    function _pull(IERC20 token, address from, uint256 amount) internal {
        uint256 before = token.balanceOf(address(this));
        _call(address(token), abi.encodeCall(IERC20.transferFrom, (from, address(this), amount)));
        // Refuse fee-on-transfer behaviour: the books assume the full amount arrived.
        if (token.balanceOf(address(this)) - before != amount) revert TransferFailed();
    }

    function _push(IERC20 token, address to, uint256 amount) internal {
        _call(address(token), abi.encodeCall(IERC20.transfer, (to, amount)));
    }

    function _call(address token, bytes memory data) internal {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool))) || token.code.length == 0) revert TransferFailed();
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : (a - 1) / b + 1;
    }

    /// Full-precision a * b / denominator (Remco Bloemen's mulDiv, as in Uniswap's FullMath).
    function _mulDiv(uint256 a, uint256 b, uint256 denominator) internal pure returns (uint256 result) {
        unchecked {
            uint256 prod0;
            uint256 prod1;
            assembly {
                let mm := mulmod(a, b, not(0))
                prod0 := mul(a, b)
                prod1 := sub(sub(mm, prod0), lt(mm, prod0))
            }
            if (prod1 == 0) {
                require(denominator > 0);
                assembly {
                    result := div(prod0, denominator)
                }
                return result;
            }
            require(denominator > prod1);
            uint256 remainder;
            assembly {
                remainder := mulmod(a, b, denominator)
                prod1 := sub(prod1, gt(remainder, prod0))
                prod0 := sub(prod0, remainder)
            }
            uint256 twos = denominator & (~denominator + 1);
            assembly {
                denominator := div(denominator, twos)
                prod0 := div(prod0, twos)
                twos := add(div(sub(0, twos), twos), 1)
            }
            prod0 |= prod1 * twos;
            uint256 inv = (3 * denominator) ^ 2;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            inv *= 2 - denominator * inv;
            result = prod0 * inv;
            return result;
        }
    }
}
