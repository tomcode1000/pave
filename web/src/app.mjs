import {
  createPublicClient, createWalletClient, custom, http, defineChain, isAddress, getAddress,
  BaseError, ContractFunctionRevertedError, UserRejectedRequestError,
} from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'
import qrcode from 'qrcode-generator'

/*
  The Pave site. Everything is read from the chain: the contract's views for numbers, and its
  events for the roads, the stones and the Believers board. Nothing in the page holds a key; every
  action is signed in the wallet the visitor connects, after a simulation that turns a revert
  into a plain sentence.
*/

const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const LEVELS = ['Dirt path', 'Gravel', 'Cobblestone', 'Highway']
const NEXT_AT = [1, 3, 6] // loans repaid to reach gravel, cobblestone, highway
const LEVEL_AT = [0, 1, 3, 6]
// Where Pave lives outside this page (an empty one is left out of the footer).
const LINKS = { GitHub: 'https://github.com/tomcode1000/pave', X: 'https://x.com/Toluinweb3' }

const ERRORS = {
  SelfVouch: "You can't vouch for yourself. Ask a friend to vouch for you.",
  BelowMinVouch: 'A new vouch needs at least the minimum $WIF.',
  TooManyVouchers: 'This road already has 20 stones. The borrower can hand one back to free a slot.',
  RoadClosed: 'This road is closed: it ended in a default.',
  LoanOpen: 'Not while a loan is open. The vouches back it until it is repaid.',
  NoLoan: 'There is no open loan here.',
  NoVouch: 'There is no vouch to take back.',
  OverLimit: "That's more than this road can borrow right now.",
  PoolDry: "The pool doesn't have that much free right now.",
  NotOverdue: 'This loan is not past its grace period yet.',
  StalePrice: 'The ETH/USD price feed is stale, so borrowing and defaults are paused. Repaying still works.',
  BadPrice: "The pool's price can't be read right now.",
  NoPriceHistory: 'Pave needs one more price reading from an earlier hour before it lends. It records one with every vouch, or tap "Record price" and try again next hour.',
  BadAmount: "That amount doesn't work here.",
  TransferFailed: 'The token transfer failed. Check your balance.',
  Reentrancy: 'Blocked a re-entrant call.',
}

const S = {
  dep: null, abis: null, pub: null, wallet: null, me: null, chain: null,
  params: {}, block: 0n, events: [], model: null, credit: null, myVouches: [], pool: null, prices: null,
  busy: false,
}

// ------------------------------------------------------------------ formatting

const usd = (x) => (x == null ? '—' : '$' + (Number(x) / 1e6).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }))
const wifFmt = (x) => {
  if (x == null) return '—'
  const n = Number(x) / 1e18
  if (n >= 1e6) return (n / 1e6).toLocaleString('en-US', { maximumFractionDigits: 2 }) + 'M'
  if (n >= 1e4) return Math.round(n / 1e3).toLocaleString('en-US') + 'k'
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 })
}
const short = (a) => (a ? a.slice(0, 6) + '…' + a.slice(-4) : '—')
const wifWhole = (x) => (x == null ? '—' : Math.floor(Number(x) / 1e18).toLocaleString('en-US'))
/// $WIF in USDG units, at the pool's price (prices()[3] is what 1M $WIF is worth).
const wifUsd = (x) => (S.prices ? (x * S.prices[3]) / 10n ** 24n : null)
const same = (a, b) => a && b && a.toLowerCase() === b.toLowerCase()
const hue = (a) => parseInt(a.slice(2, 8), 16) % 360
const dot = (a) => `background: linear-gradient(135deg, hsl(${hue(a)} 55% 58%), hsl(${(hue(a) + 50) % 360} 50% 38%))`
const level = (repaid) => (repaid >= 6 ? 3 : repaid >= 3 ? 2 : repaid >= 1 ? 1 : 0)
// The chain's clock, not this computer's: the latest block's time, plus what has passed since it was read.
const now = () => (S.tnow != null ? S.tnow + BigInt(Math.floor((Date.now() - S.tread) / 1000)) : BigInt(Math.floor(Date.now() / 1000)))
function dur(sec) {
  const s = Number(sec < 0n ? -sec : sec)
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  const t = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${Math.max(m, 1)}m`
  return sec < 0n ? `${t} ago` : `in ${t}`
}
const toUnits = (s, dp) => {
  const t = String(s ?? '').trim().replace(/,/g, '')
  if (!/^\d*\.?\d*$/.test(t) || t === '' || t === '.') return null
  const [i, f = ''] = t.split('.')
  if (f.length > dp) return null
  return BigInt(i || '0') * 10n ** BigInt(dp) + BigInt((f + '0'.repeat(dp)).slice(0, dp))
}

function toast(msg, kind = '') {
  const t = $('[data-toast]')
  t.textContent = msg
  t.className = 'toast' + (kind ? ` toast--${kind}` : '')
  t.hidden = false
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { t.hidden = true }, kind === 'err' ? 9000 : 5000)
}

function explain(err) {
  if (err instanceof BaseError) {
    if (err.walk((e) => e instanceof UserRejectedRequestError)) return 'Cancelled in your wallet.'
    const rev = err.walk((e) => e instanceof ContractFunctionRevertedError)
    const name = rev?.data?.errorName
    if (name && ERRORS[name]) return ERRORS[name]
    if (name) return `The contract refused: ${name}.`
    return err.shortMessage || err.message
  }
  if (err?.code === 4001) return 'Cancelled in your wallet.'
  return String(err?.message ?? err)
}

// ------------------------------------------------------------------ chain

const read = (functionName, args = [], address = S.dep.Pave, abi = S.abis.Pave) =>
  S.pub.readContract({ address, abi, functionName, args })
const tryRead = async (...a) => { try { return await read(...a) } catch { return null } }

async function send(label, functionName, args = [], address = S.dep.Pave, abi = S.abis.Pave) {
  if (!S.wallet) throw new Error('Connect a wallet first.')
  await ensureChain()
  const { request } = await S.pub.simulateContract({ address, abi, functionName, args, account: S.wallet.account })
  TX.wait(label)
  const hash = await S.wallet.writeContract(request)
  TX.sent(hash)
  const rc = await S.pub.waitForTransactionReceipt({ hash })
  if (rc.status !== 'success') throw new Error(`${label} failed on chain.`)
  return hash
}

/// Approve exactly what is needed, only when the allowance is short.
async function allow(token, amount, what) {
  const have = await read('allowance', [S.me, S.dep.Pave], token, S.abis.Token)
  if (have >= amount) return
  await send(`Approve ${what}`, 'approve', [S.dep.Pave, amount], token, S.abis.Token)
}

/// Runs an action. A check that fails before anything is signed is a short message; once a
/// transaction starts, the status card (TX) follows it through to successful or failed.
/// opts: { amount: shown on the card, then: the page "Continue" goes to }
async function act(label, fn, opts = {}) {
  if (S.busy) return
  S.busy = true
  TX.start(label, opts)
  $$('[data-act]').forEach((b) => { b.disabled = true })
  try {
    await fn()
    if (TX.used) TX.ok()
    else toast(`${label}: done.`, 'ok')
  } catch (e) {
    if (TX.used) TX.fail(explain(e), () => act(label, fn, opts))
    else toast(explain(e), 'err')
  } finally {
    S.busy = false
    // Re-enable everything (the pages are redrawn next, with their own disabled states).
    $$('[data-act]').forEach((b) => { b.disabled = false })
    await refresh()
    await findOverdue().then(render).catch(() => {})
  }
}

// ------------------------------------------------------------------ the transaction status card
// The design's three cards (pending, successful, failed) as one pop-up that changes state.
const ICO = {
  ok: '<svg viewBox="0 0 24 24"><path d="m6 12.5 4 4 8-8.5" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  bad: '<svg viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>',
  wait: '<svg viewBox="0 0 24 24"><path d="M7 3h10M7 21h10M8 3c0 5 8 5 8 9s-8 4-8 9M16 3c0 5-8 5-8 9s8 4 8 9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>' +
    '<svg class="spin" viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="none" stroke="currentColor" stroke-width="2.5" stroke-dasharray="70 232" stroke-linecap="round"/></svg>',
}
const ARROW = '<svg class="arr" viewBox="0 0 16 16"><use href="#i-arrow"/></svg>'
const TX = {
  label: '', opts: {}, used: false, hash: null, current: '',
  el: (k) => $(`[data-txm${k ? '-' + k : ''}]`),
  start(label, opts) { Object.assign(this, { label, opts, used: false, hash: null, current: label }) },
  show(state, title, sub, extra, acts) {
    const m = this.el()
    m.hidden = false
    m.dataset.state = state
    this.el('card').className = 'txm__card' + (state === 'wait' ? '' : ' ' + state)
    this.el('ico').innerHTML = ICO[state]
    this.el('title').textContent = title
    this.el('sub').textContent = sub
    const rows = [['Transaction Type', this.current], ...(this.opts.amount ? [['Amount', this.opts.amount]] : []), ['Network', S.dep.network], ...extra]
    this.el('rows').innerHTML = rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')
    this.el('acts').innerHTML = acts
  },
  hashRow() {
    if (!this.hash) return []
    const s = this.hash.slice(0, 6) + '…' + this.hash.slice(-4)
    return [['Tx Hash', S.dep.explorer ? `<a href="${S.dep.explorer}/tx/${this.hash}" target="_blank" rel="noopener">${s} ↗</a>` : s]]
  },
  wait(label) {
    Object.assign(this, { used: true, current: label, hash: null })
    this.show('wait', 'Transaction Pending', `Confirm "${label}" in your wallet.`, [], '')
  },
  sent(hash) {
    this.hash = hash
    const view = S.dep.explorer ? `<a class="btn-line gold-line" href="${S.dep.explorer}/tx/${hash}" target="_blank" rel="noopener">View Transaction${ARROW}</a>` : ''
    this.show('wait', 'Transaction Pending', 'Your transaction has been submitted. Waiting for blockchain confirmation…', this.hashRow(), view)
  },
  ok() {
    this.current = this.label
    this.show('ok', 'Transaction Successful', 'Your transaction was completed successfully.', this.hashRow(),
      `<button class="btn-gold" data-txm-go="continue">Continue${ARROW}</button>`)
  },
  fail(reason, retry) {
    this.retry = retry
    this.show('bad', 'Transaction Failed', 'Something went wrong. Please try again.', [['Reason', reason.replace(/</g, '&lt;')], ...this.hashRow()],
      '<button class="btn-line gold-line" data-txm-go="retry">↻ Retry Transaction</button><button class="link" data-txm-go="home">Return to Dashboard →</button>')
  },
  close(go) {
    this.el().hidden = true
    if (go) location.hash = '#/' + go
  },
}

// ------------------------------------------------------------------ local demo wallets
// On the local chain only: four throwaway people (A-D) whose keys live in this browser, funded
// with local test ETH, so anyone can play the borrower and the friends without a wallet app.
const DEMO = ['A', 'B', 'C', 'D']
const isLocal = () => S.dep?.chainId === 31337
const store = { get: (k) => { try { return localStorage.getItem(k) } catch { return null } }, set: (k, v) => { try { localStorage.setItem(k, v) } catch {} } }

async function useDemo(i = 0) {
  if (!isLocal()) return
  let key = store.get('pave-demo-' + i)
  if (!key) { key = generatePrivateKey(); store.set('pave-demo-' + i, key) }
  const account = privateKeyToAccount(key)
  S.demo = true
  S.demoIndex = i
  S.me = account.address
  S.wallet = createWalletClient({ chain: S.chain, transport: http(S.dep.rpc), account })
  if ((await S.pub.getBalance({ address: S.me })) < 10n ** 18n) await fundLocal(S.me)
  store.set('pave-demo-on', String(i))
  toast(`You are demo person ${DEMO[i]} (${short(S.me)}).`, 'ok')
  await refresh()
}

/// Local chain only: give an address 100 test ETH for gas (a Hardhat node method).
const fundLocal = (addr) => S.pub.request({ method: 'hardhat_setBalance', params: [addr, '0x56BC75E2D63100000'] })

async function ensureChain() {
  if (S.demo) return
  const eth = S.eth
  const id = await eth.request({ method: 'eth_chainId' })
  if (parseInt(id, 16) === S.dep.chainId) return
  const hex = '0x' + S.dep.chainId.toString(16)
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: hex }] })
  } catch (e) {
    const code = e?.code ?? e?.data?.originalError?.code
    if (code !== 4902 && code !== -32603) throw e
    await eth.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId: hex, chainName: S.dep.network, rpcUrls: [S.dep.rpc],
        nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
        ...(S.dep.explorer ? { blockExplorerUrls: [S.dep.explorer] } : {}),
      }],
    })
  }
}

// Wallets the browser offers (EIP-6963: each extension announces itself, so several can coexist).
const WALLETS = new Map()
const INSTALL = {
  'io.metamask': 'https://metamask.io/download/',
  'app.phantom': 'https://phantom.com/download',
  'com.okex.wallet': 'https://www.okx.com/web3',
  'com.coinbase.wallet': 'https://www.coinbase.com/wallet/downloads',
}
addEventListener('eip6963:announceProvider', (e) => { WALLETS.set(e.detail.info.rdns, e.detail); markWallets() })
dispatchEvent(new Event('eip6963:requestProvider'))
function markWallets() {
  $$('[data-wallet-pick]').forEach((t) => {
    const r = t.dataset.walletPick
    t.classList.toggle('found', r === 'more' ? [...WALLETS.keys()].some((k) => !INSTALL[k]) : WALLETS.has(r))
  })
}

/// Connects a wallet: the one picked, else the browser's default, else (local chain) a demo person.
async function connect(eth = window.ethereum, rdns = '') {
  if (!eth) {
    if (isLocal()) { await useDemo(0); return afterConnect() }
    toast('No wallet found. Install MetaMask or another wallet, then reload.', 'err')
    return
  }
  try {
    const [a] = await eth.request({ method: 'eth_requestAccounts' })
    S.me = getAddress(a)
    S.demo = false
    S.eth = eth
    store.set('pave-wallet', rdns)
    store.set('pave-demo-on', '')
    S.wallet = createWalletClient({ chain: S.chain, transport: custom(eth), account: S.me })
    // Switching network is asked for now, but connecting doesn't depend on it: reading needs no
    // wallet, and every transaction asks again before it is signed.
    ensureChain().catch((e) => toast(`Connected. To sign, switch your wallet to ${S.dep.network}: ${explain(e)}`, 'err'))
    eth.removeAllListeners?.('accountsChanged')
    eth.on?.('accountsChanged', (list) => {
      S.me = list?.[0] ? getAddress(list[0]) : null
      S.wallet = S.me ? createWalletClient({ chain: S.chain, transport: custom(eth), account: S.me }) : null
      refresh().then(route)
    })
    eth.on?.('chainChanged', () => refresh())
    await refresh()
    afterConnect()
  } catch (e) {
    toast(explain(e), 'err')
  }
}

/// A wallet tile: connect that wallet if the browser has it, else open its install page.
function pickWallet(rdns) {
  if (rdns === 'more') {
    const other = [...WALLETS].find(([k]) => !INSTALL[k])
    if (other) return connect(other[1].provider, other[0])
    if (window.ethereum) return connect(window.ethereum)
    return toast('No other wallet found in this browser.', 'err')
  }
  const w = WALLETS.get(rdns)
  if (w) return connect(w.provider, rdns)
  open(INSTALL[rdns], '_blank', 'noopener')
}

/// After connecting on the connect page, carry on to where the visitor was going.
function afterConnect() {
  if (VIEW.page === 'connect') location.hash = '#/' + (VIEW.after || 'road')
  else route()
}

async function disconnect() {
  try { await S.eth?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }) } catch { /* not every wallet can */ }
  Object.assign(S, { me: null, wallet: null, eth: null, demo: false, mine: null })
  store.set('pave-demo-on', '')
  store.set('pave-wallet', '')
  toast('Wallet disconnected.', 'ok')
  location.hash = '#/'
}

/// All Pave events since deployment, fetched once and then only the new blocks.
async function loadEvents() {
  const head = await S.pub.getBlock()
  const latest = head.number
  S.tnow = head.timestamp
  S.tread = Date.now()
  let from = S.block ? S.block + 1n : BigInt(S.dep.deployBlock)
  if (from > latest) return
  const fresh = []
  let step = latest - from + 1n
  while (from <= latest) {
    const to = from + step - 1n > latest ? latest : from + step - 1n
    try {
      fresh.push(...await S.pub.getContractEvents({ address: S.dep.Pave, abi: S.abis.Pave, fromBlock: from, toBlock: to }))
      from = to + 1n
    } catch (e) {
      if (step <= 1000n) throw e
      step = step / 4n // the RPC limits the range: ask for smaller pieces
    }
  }
  S.events.push(...fresh)
  S.block = latest
}

/// Roads, stones and believers, rebuilt from the events.
function buildModel() {
  const roads = new Map()
  const believers = new Map()
  let burned = 0n
  const road = (b) => {
    const k = b.toLowerCase()
    if (!roads.has(k)) roads.set(k, { addr: getAddress(b), vouches: new Map(), repaid: 0, streak: 0, defaulted: false, open: false, first: null, reached: 0 })
    return roads.get(k)
  }
  const fan = (v) => {
    const k = v.toLowerCase()
    if (!believers.has(k)) believers.set(k, { addr: getAddress(v), backed: new Set(), repaidBacked: 0, earned: 0n, slashed: 0, firsts: new Set() })
    return believers.get(k)
  }
  for (const e of S.events) {
    const a = e.args
    switch (e.eventName) {
      case 'Vouched': {
        const r = road(a.borrower)
        r.vouches.set(a.voucher.toLowerCase(), { addr: getAddress(a.voucher), amount: a.total })
        if (!r.first) { r.first = a.voucher.toLowerCase(); fan(a.voucher).firsts.add(a.borrower.toLowerCase()) }
        fan(a.voucher).backed.add(a.borrower.toLowerCase())
        break
      }
      case 'Unvouched': road(a.borrower).vouches.delete(a.voucher.toLowerCase()); break
      case 'Slashed': {
        const r = road(a.borrower), k = a.voucher.toLowerCase(), v = r.vouches.get(k)
        if (v) { v.amount -= a.amount; if (v.amount <= 0n) r.vouches.delete(k) }
        fan(a.voucher).slashed += 1
        break
      }
      case 'Borrowed': road(a.borrower).open = true; break
      case 'Repaid': {
        const r = road(a.borrower)
        r.open = false; r.repaid = Number(a.repaid); r.streak = Number(a.streak); r.reached = level(r.repaid)
        break
      }
      case 'VoucherRewarded': { const f = fan(a.voucher); f.repaidBacked += 1; f.earned += a.amount; break }
      case 'Defaulted': { const r = road(a.borrower); r.open = false; r.defaulted = true; burned += a.wifBurned; break }
    }
  }
  let vouched = 0n
  for (const r of roads.values()) for (const v of r.vouches.values()) vouched += v.amount
  const shown = [...roads.values()].filter((r) => r.vouches.size || r.repaid || r.defaulted || r.open)
  return { roads, shown, believers, burned, vouched }
}

async function refresh() {
  try {
    await loadEvents()
    S.model = buildModel()
    const [idle, outstanding, totalShares, prices] = await Promise.all([
      read('idle'), read('outstanding'), read('totalShares'), tryRead('prices'),
    ])
    S.pool = { idle, outstanding, totalShares }
    S.prices = prices
    if (S.me) {
      const [credit, vouches, shares, pendingWif, rewards, wifBal, usdgBal, eth] = await Promise.all([
        tryRead('creditOf', [S.me]), read('vouchesOf', [S.me]), read('shares', [S.me]), read('pendingWif', [S.me]),
        read('rewards', [S.me]), read('balanceOf', [S.me], S.dep.wif, S.abis.Token),
        read('balanceOf', [S.me], S.dep.usdg, S.abis.Token), S.pub.getBalance({ address: S.me }),
      ])
      const path = credit ? credit.path : await read('pathOf', [S.me])
      const loan = await read('loans', [S.me])
      const shareValue = shares ? await read('shareValue', [shares]) : 0n
      // The roads this wallet backs, and what each open loan there would pay this wallet when repaid.
      const backed = []
      for (const road of S.model.roads.values()) {
        const v = road.vouches.get(S.me.toLowerCase())
        if (!v) continue
        let total = 0n
        for (const o of road.vouches.values()) total += o.amount
        const l = road.open ? await read('loans', [road.addr]) : null
        const fee = l ? (l[1] * BigInt(S.params.voucherShareBps ?? 0n)) / 10_000n : 0n
        backed.push({ road, amount: v.amount, potential: total ? (fee * v.amount) / total : 0n })
      }
      S.mine = { credit, path, loan, vouches, shares, shareValue, pendingWif, rewards, wifBal, usdgBal, eth, backed }
    } else {
      S.mine = null
    }
    render()
  } catch (e) {
    console.error(e)
    toast('Could not read the chain: ' + explain(e), 'err')
  }
}

// ------------------------------------------------------------------ the map card, rewards preview

const calm = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/// Sets a number's text, counting up (or down) from the one shown, in the same format ("$1,250.00").
function countTo(el, text) {
  const num = (t) => {
    const m = /^(\D*?)([\d,]+(?:\.\d+)?)(.*)$/.exec(t)
    return m && { pre: m[1], n: parseFloat(m[2].replace(/,/g, '')), dp: (m[2].split('.')[1] ?? '').length, post: m[3] }
  }
  const to = num(text)
  const from = num(el.textContent) ?? (to && { ...to, n: 0 })
  cancelAnimationFrame(el.raf)
  if (!to || calm() || from.pre !== to.pre || from.n === to.n) { el.textContent = text; return }
  const t0 = performance.now()
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 900), e = 1 - (1 - k) ** 3
    el.textContent = to.pre + (from.n + (to.n - from.n) * e).toLocaleString('en-US', { minimumFractionDigits: to.dp, maximumFractionDigits: to.dp }) + to.post
    if (k < 1) el.raf = requestAnimationFrame(step)
    else el.textContent = text
  }
  el.raf = requestAnimationFrame(step)
}

/// Text and controls in each section rise into place the first time they scroll into view.
function reveal() {
  if (calm() || !('IntersectionObserver' in window)) return
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target) }
  }, { threshold: .2 })
  for (const part of $$('.frame, #lend, #believers')) {
    const els = $$(':scope > .tx, :scope .lines > .tx, :scope > .a:not(.pic):not(.fx), :scope > .pic > .k, :scope > .hscroll .k, :scope > .head > *, :scope > .stats', part)
    els.forEach((el, i) => { el.classList.add('rv'); el.style.setProperty('--rd', Math.min(i * 60, 600) + 'ms'); io.observe(el) })
  }
}

function renderProfile() {
  const p = (k) => $(`[data-p="${k}"]`)
  const m = S.mine
  const status = (cls, label) => { const el = p('status'); el.className = `a status status--${cls}`; el.lastElementChild.textContent = label }
  if (!m) {
    p('addr').textContent = 'Not connected'
    p('ext').hidden = true
    p('level').textContent = 'Level 0'
    p('backing').textContent = '—'
    status('off', 'None')
    p('bar').style.width = '0%'
    p('pct').textContent = '0%'
    return
  }
  const repaid = Number(m.path.repaid), lv = level(repaid)
  p('addr').textContent = S.me.slice(0, 4) + '...' + S.me.slice(-4)
  const ext = p('ext')
  ext.hidden = !S.dep.explorer
  if (S.dep.explorer) ext.href = `${S.dep.explorer}/address/${S.me}`
  p('level').textContent = m.path.defaulted ? 'Cracked' : `Level ${lv}`
  countTo(p('backing'), wifWhole(m.credit ? m.credit.vouchedWif : m.vouches.reduce((s, v) => s + v.amount, 0n)))
  if (m.path.defaulted) status('bad', 'Defaulted')
  else if (m.loan[0] > 0n) now() > m.loan[2] ? status('warn', 'Overdue') : status('ok', 'Active')
  else status('off', 'None')
  const pct = m.path.defaulted ? 0 : lv === 3 ? 100 : Math.round(((repaid - LEVEL_AT[lv]) / (NEXT_AT[lv] - LEVEL_AT[lv])) * 100)
  p('bar').style.width = pct + '%'
  p('pct').textContent = pct + '%'
}

function renderRewards() {
  const r = (k, v) => countTo($(`[data-r="${k}"]`), v)
  const b = S.mine?.backed
  if (!b) { for (const k of ['vouched', 'potential', 'count', 'claim']) r(k, '—'); return }
  const usdShort = (x) => (x == null ? '—' : x >= 100_000_000n ? '$' + Math.round(Number(x) / 1e6).toLocaleString('en-US') : usd(x))
  r('vouched', usdShort(wifUsd(b.reduce((s, x) => s + x.amount, 0n))))
  r('potential', usdShort(b.reduce((s, x) => s + x.potential, 0n)))
  r('count', String(b.length))
  r('claim', usdShort(S.mine.rewards))
}

// ------------------------------------------------------------------ panels

function shareLink(addr) {
  const u = new URL(location.href)
  u.search = ''
  u.searchParams.set('for', addr)
  const net = new URLSearchParams(location.search).get('net')
  if (net) u.searchParams.set('net', net)
  return u.toString()
}

function render() {
  $$('[data-connect]').forEach((el) => { el.textContent = S.me ? short(S.me) : isLocal() && !window.ethereum ? 'Use demo wallet' : 'Connect Wallet' })
  renderProfile()
  renderRewards()
  renderLanding()
  renderTools()
  renderApp()
}

/// The landing page's live numbers: the lending pool, the top believers, the community.
function renderLanding() {
  const L = (k, v) => set(`[data-L="${k}"]`, v)
  const p = S.pool, total = p.idle + p.outstanding
  // Lenders' interest: their share of the fee on every repaid loan.
  const lenderBps = 10_000n - BigInt(S.params.voucherShareBps ?? 3000n)
  const feeOf = new Map()
  let interest = 0n, toLenders = 0n, repaidN = 0, defaultedN = 0
  for (const e of S.events) {
    if (e.eventName === 'Borrowed') feeOf.set(e.args.borrower.toLowerCase(), e.args.fee)
    if (e.eventName === 'Repaid') { repaidN++; interest += ((feeOf.get(e.args.borrower.toLowerCase()) ?? 0n) * lenderBps) / 10_000n }
    if (e.eventName === 'Defaulted') { toLenders += e.args.wifToLenders; defaultedN++ }
  }
  L('total', usd0(total)); L('idle', usd0(p.idle)); L('out', usd0(p.outstanding))
  L('share', S.mine && p.totalShares ? (Number((S.mine.shares * 10_000n) / p.totalShares) / 100).toFixed(1) + '%' : '—')
  L('int', usd(interest))
  L('wif', wifValue(toLenders))
  const list = rankedBelievers('backed')
  for (let i = 0; i < 3; i++) {
    const b = list[i], img = $(`[data-pod-ava="${i}"]`)
    if (b) img.src = avaOf(b.addr); else img.removeAttribute('src')
    set(`[data-pod-name="${i}"]`, b ? b.addr.slice(0, 5) + '…' + b.addr.slice(-4) : '')
    set(`[data-pod-stat="${i}"]`, b ? `${wifValue(b.wif)} • ${b.backed.size} ppl` : '')
  }
  const tops = [17.5, 55, 90, 122.5, 155.5]
  $('[data-lrows]').innerHTML = list.length ? list.slice(0, 5).map((b, i) => `<div class="lr" style="top: calc(${tops[i] - 17} * var(--s))"><img src="${avaOf(b.addr)}" alt="">
      <span class="n">${short(b.addr)}</span><span class="t">${wifValue(b.wif)}</span><span class="p">${b.backed.size}</span><span class="r">${usd(b.earned)}</span></div>`).join('')
    : '<div class="lr lr--none" style="top: calc(5 * var(--s))"><span class="n">No believers yet. Vouch for someone to be the first.</span></div>'
  const C = (k, v) => set(`[data-C="${k}"]`, v)
  C('believers', String(list.length))
  C('backed', wifValue(S.model.vouched))
  C('people', String([...S.model.roads.values()].filter((r) => r.vouches.size).length))
  C('repaid', repaidN + defaultedN ? Math.round((repaidN / (repaidN + defaultedN)) * 100) + '%' : '—')
}

// Short answers behind "Learn more", "Transaction Info" and the footer's small print.
const INFO = () => ({
  lending: ['How lending works', `<p>You put USDG into one shared pool and get a share of it. Borrowers pay a ${feePct()} fee on every loan: lenders get ${100 - Number(S.params.voucherShareBps ?? 3000n) / 100}% of it and the people who vouched get the rest.</p>
    <p>You can withdraw any time, up to what isn't lent out at that moment. If a loan isn't repaid, its vouchers' $WIF is cut and the pool's share comes to lenders as $WIF you collect on the Lend page.</p>`],
  risk: ['Lending involves risk', `<p>Returns aren't guaranteed. Loans are backed by $WIF, a memecoin: if a borrower doesn't repay and $WIF has fallen, the $WIF you get can be worth less than the loan.</p>
    <p>The contract was reviewed by its author, not by an outside auditor yet. Lend and vouch only what you can afford to lose.</p>`],
  how: ['How Pave works', `<p><b>Vouch.</b> Friends lock $WIF behind your wallet. After ${S.params.vouchMaturity != null ? dur(BigInt(S.params.vouchMaturity)).replace('in ', '') : '3 days'} it counts toward your limit: you can borrow ${Number(S.params.ltvBps ?? 4000n) / 100}% of its value, capped by your road's level.</p>
    <p><b>Borrow.</b> Take a small USDG loan from the pool and repay it, plus a ${feePct()} fee, within ${termText()}.</p>
    <p><b>Grow.</b> Each repaid loan paves your road: ${capOf(0)} on a dirt path, ${capOf(1)} on gravel, ${capOf(2)} on cobblestone, ${capOf(3)} on the highway. Your vouchers earn part of every fee.</p>
    <p><b>If a loan isn't repaid,</b> up to twice the debt in $WIF is cut from the stones behind that road: one share goes to the lenders, the rest is burned, and the road cracks.</p>`],
  faq: ['FAQ', `<h3>Do my friends send me money?</h3><p>No. Their $WIF stays locked in the Pave contract, in their name. You borrow USDG from the lenders' pool.</p>
    <h3>Can a voucher take their $WIF back?</h3><p>Yes, any time you have no loan open. While a loan is open the stones behind it are frozen.</p>
    <h3>What does a lender earn?</h3><p>Most of every fee, shared by pool share, and the $WIF cut from a road that doesn't repay.</p>
    <h3>Who runs Pave?</h3><p>No one. The contract has no owner, no admin and no upgrade. The code is on <a href="https://github.com/tomcode1000/pave" target="_blank" rel="noopener">GitHub</a>.</p>`],
  protocol: ['Protocol disclaimer', '<p>Pave is a smart contract on Robinhood Chain with no owner, no admin and no upgrade: nobody can change its rules or move your funds. This site only reads the chain and asks your wallet to sign. It is experimental software, provided as is.</p>'],
  robinhood: ['Robinhood affiliation', '<p>Pave is built on Robinhood Chain, a public network anyone can build on. Pave is not made, endorsed or supported by Robinhood.</p>'],
  terms: ['Terms of service', '<p>Pave is open-source software you use at your own risk. There is no company holding your money and no one who can reverse a transaction. Don\'t use it where it is not allowed for you, and check every transaction in your wallet before signing.</p>'],
  privacy: ['Privacy', '<p>No accounts, no cookies, no analytics. The site reads public chain data. Your browser keeps a few preferences (which notifications you have read, your picture choice) and, on the local demo only, the demo wallets. Your wallet address and its transactions are public on the chain, like any wallet\'s.</p>'],
})

// ------------------------------------------------------------------ the app footer: test tools on test networks only
function renderTools() {
  const t = $('[data-tools]')
  if (!t) return
  t.hidden = !S.dep.testTokens
  set('[data-status]', `${S.dep.network} · block ${S.block.toLocaleString('en-US')}`)
}

/// The vouch page, filled in for someone.
function openVouch(addr) {
  if (addr && isAddress(addr)) S.vouchFor = getAddress(addr)
  location.hash = '#/vouch'
}

// ------------------------------------------------------------------ the app: pages by the hash
// #/<page> shows the app (sidebar, top bar, one page); anything else is the landing page.
const VIEW = { page: null, after: null }
const PAGES = ['connect', 'road', 'borrow', 'repay', 'lend', 'vouch', 'believers', 'activity', 'profile', 'notifications', 'levels', 'map']
const NEEDS_WALLET = new Set(['road', 'borrow', 'repay', 'lend', 'vouch', 'activity', 'profile', 'notifications'])
const NAV_OF = { borrow: 'road', repay: 'road', levels: 'road', activity: null, profile: null, notifications: null }

function route() {
  const h = location.hash
  const want = h.startsWith('#/') ? h.slice(2).split(/[?&]/)[0] : ''
  const inApp = PAGES.includes(want)
  $('[data-view="landing"]').hidden = inApp
  $('[data-view="app"]').hidden = !inApp
  mapHome(inApp && want === 'map')
  if (!inApp) {
    VIEW.page = null
    if (h.startsWith('#/') || !h) scrollTo(0, 0)
    return
  }
  let page = want
  if (NEEDS_WALLET.has(page) && !S.me) { VIEW.after = page; page = 'connect' }
  if (page === 'connect' && S.me) page = VIEW.after || 'road'
  const changed = VIEW.page !== page
  VIEW.page = page
  $$('[data-pg]').forEach((p) => { p.hidden = p.dataset.pg !== page })
  $('[data-stage]').classList.toggle('bare', page === 'levels')
  const nav = page in NAV_OF ? NAV_OF[page] : page
  $$('[data-go]').forEach((a) => a.setAttribute('aria-current', a.dataset.go === nav ? 'page' : 'false'))
  if (changed) { scrollTo(0, 0); hideMenu() }
  renderApp()
}

/// The flat map lives on the landing page; the app's Flat Map page borrows it while shown.
function mapHome(inApp) {
  const map = $('#map')
  if (!map) return
  if (!mapHome.spot) { mapHome.spot = document.createComment('map'); map.before(mapHome.spot) }
  const slot = $('[data-mapslot]')
  if (inApp && slot && map.parentElement !== slot) slot.append(map)
  if (!inApp && map.parentElement === slot) mapHome.spot.after(map)
}

const hideMenu = () => { const m = $('[data-menu]'); if (m) { m.hidden = true; $('[data-act="wallet-menu"]').setAttribute('aria-expanded', 'false') } }

// Avatars: the design's portraits, one per wallet, always the same one for the same wallet.
const AVATARS = 5
const avaOf = (a) => `assets/ava-${store.get('pave-ava-' + a.toLowerCase()) ?? parseInt(a.slice(2, 10), 16) % AVATARS}.png`

/// What a wallet's road looks like now, from the contract's path and loan.
function roadState(m) {
  const repaid = Number(m.path.repaid), lv = level(repaid)
  const pct = m.path.defaulted ? 0 : lv === 3 ? 100 : Math.round(((repaid - LEVEL_AT[lv]) / (NEXT_AT[lv] - LEVEL_AT[lv])) * 100)
  const open = m.loan[0] > 0n
  return { repaid, lv, pct, open, owed: m.loan[0] + m.loan[1], due: m.loan[2], late: open && now() > m.loan[2], closed: m.path.defaulted }
}
const feePct = () => Number(S.params.feeBps ?? 300n) / 100 + '%'
const termText = () => dur(BigInt(S.params.loanTerm ?? 0n)).replace('in ', '')
const dateOf = (t) => new Date(Number(t) * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
const usd0 = (x) => '$' + Math.round(Number(x) / 1e6).toLocaleString('en-US')
const set = (sel, v) => { const el = $(sel); if (el) el.textContent = v }

function renderApp() {
  if (!VIEW.page || !S.pool) return
  const me = S.me
  $$('[data-me-ava]').forEach((ava) => { if (me) ava.src = avaOf(me); else ava.removeAttribute('src') })
  set('[data-me-short]', me ? me.slice(0, 5) + '...' + me.slice(-4) : isLocal() && !window.ethereum ? 'Use demo wallet' : 'Connect Wallet')
  const page = VIEW.page
  if (page === 'connect') markWallets()
  if (page === 'believers') renderBelievers()
  if (!S.mine) return
  badge()
  if (page === 'road') renderRoad()
  if (page === 'borrow') renderBorrow()
  if (page === 'repay') renderRepay()
  if (page === 'vouch') renderVouch()
  if (page === 'lend') renderLend()
  if (page === 'activity') renderActivity()
  if (page === 'profile') renderProfilePage()
  if (page === 'notifications') renderNotes()
  if (page === 'levels') {
    const r = roadState(S.mine)
    $$('.lvlcard').forEach((c) => {
      c.classList.toggle('here', r.closed ? c.dataset.lv === 'x' : c.dataset.lv === String(r.lv))
      if (c.dataset.lv === '3') { if (r.lv === 3 && !r.closed) c.dataset.act = 'share-highway'; else delete c.dataset.act }
    })
  }
}

function renderRoad() {
  const m = S.mine, c = m.credit, r = roadState(m)
  const hw = 'pave-hw-' + S.me.toLowerCase()
  if (r.lv === 3 && !r.closed && !store.get(hw) && !S.sheet) { store.set(hw, '1'); openCard('highway') }
  const bc = (k, v) => set(`[data-bc="${k}"]`, v)
  const input = $('[data-in="road-amt"]'), ro = $('[data-bc="owed"]'), max = $('[data-act="road-max"]')
  const go = $('[data-act="road-go"]')
  const showInput = !r.open && !r.closed
  input.hidden = !showInput; max.hidden = !showInput; ro.hidden = showInput
  go.classList.toggle('is-off', r.closed || (!r.open && !(c?.available > 0n)))
  if (r.closed) {
    bc('title', 'Road closed'); bc('sub', "A loan wasn't repaid."); ro.textContent = '—'
    bc('term', '—'); bc('fee', 'No new loans'); bc('go', 'Borrow Now')
  } else if (r.open) {
    bc('title', 'Active loan'); bc('sub', `Repay by ${dateOf(r.due)}.`); ro.textContent = (Number(r.owed) / 1e6).toFixed(2)
    bc('term', r.late ? 'Overdue' : dur(r.due - now()).replace('in ', '') + ' left'); bc('fee', `${feePct()} fee included`); bc('go', 'Repay Now')
  } else {
    bc('title', 'Borrow USDG')
    bc('sub', c?.available > 0n ? 'Get the funds you need.' : !c ? 'Price feed paused.' : c.vouchers ? 'Your stones are maturing.' : 'Ask friends to vouch first.')
    input.placeholder = c ? (Number(c.available) / 1e6).toFixed(0) : '0'
    bc('term', termText()); bc('fee', `${feePct()} fee`); bc('go', 'Borrow Now')
  }
  // supporters: up to three faces, then +N; none yet: an invite
  const vs = m.vouches
  const faces = vs.slice(0, 3).map((v) => `<img src="${avaOf(v.voucher)}" alt="" title="${short(v.voucher)}">`).join('')
  $('[data-sup]').innerHTML = vs.length ? faces + (vs.length > 3 ? `<span class="more">+${vs.length - 3}</span>` : '<span class="add" title="Ask for more vouches">+</span>')
    : '<span class="add" title="Ask friends to vouch">+</span><span class="desc" style="font-size: calc(13 * var(--s))">Invite your first supporter</span>'
  $('[data-sup]').dataset.act = vs.length ? 'supporters' : 'share-vouch'
  const backing = m.vouches.reduce((s, v) => s + v.amount, 0n)
  countTo($('[data-r2="backing"]'), S.prices ? usd0(wifUsd(backing)) : wifWhole(backing) + ' $WIF')
  set('[data-r2="next"]', r.closed ? 'Road closed' : r.lv === 3 ? 'Highway reached' : `Progress to ${LEVELS[r.lv + 1]}`)
  $('[data-r2="bar"]').style.width = r.pct + '%'
  set('[data-r2="pct"]', r.pct + '%')
}

function renderBorrow() {
  const m = S.mine, c = m.credit, r = roadState(m)
  const avail = c?.available ?? 0n
  set('[data-bw="limit"]', r.open ? 'You have a loan open: repay it first.' : r.closed ? 'This road is closed.' : `Available Limit: ${usd(avail)}`)
  const chips = $('[data-chips]')
  const amt = toUnits($('[data-in="borrow"]').value, 6) ?? 0n
  chips.innerHTML = [0, 1, 2, 3].map((i) => {
    const cap = S.params['cap' + i] ?? 0n
    const can = !r.open && !r.closed && i <= (c?.level ?? 0) && cap <= avail
    return `<button class="chip${amt === cap && amt > 0n ? ' on' : ''}" data-act="borrow-chip" data-v="${cap}"${can ? '' : ' disabled'}><b>${usd0(cap)}</b><small>(Lv ${i})</small></button>`
  }).join('')
  const fee = (amt * BigInt(S.params.feeBps ?? 300n)) / 10_000n
  set('[data-bw="amt"]', usd(amt))
  set('[data-bw="feelabel"]', `Fee (${feePct()})`)
  set('[data-bw="fee"]', usd(fee))
  set('[data-bw="total"]', usd(amt + fee))
  set('[data-bw="due"]', `in ${termText()}`)
}

function renderRepay() {
  const m = S.mine, r = roadState(m)
  const rp = (k, v) => set(`[data-rp="${k}"]`, v)
  const principal = m.loan[0], fee = m.loan[1]
  $('[data-rp="principal"]').innerHTML = r.open ? `${usd0(principal)}<span class="unit">USDG</span>` : '$0<span class="unit">USDG</span>'
  const tag = $('[data-rp="tag"]').parentElement
  tag.classList.toggle('late', r.late)
  rp('tag', r.open ? (r.late ? 'Overdue' : 'Active Loan') : 'No Active Loan')
  rp('due', r.open ? dateOf(r.due) : '—')
  const graceEnd = r.due + BigInt(S.params.grace ?? 0n)
  rp('left', !r.open ? '—' : r.late ? `grace ends ${dur(graceEnd - now()).replace('in ', 'in ')}` : dur(r.due - now()).replace('in ', ''))
  const term = BigInt(S.params.loanTerm ?? 1n)
  const pct = r.open ? Math.max(0, Math.min(100, Math.round((Number(now() - (r.due - term)) / Number(term)) * 100))) : 0
  $('[data-rp="bar"]').style.width = pct + '%'
  rp('pct', pct + '%')
  rp('owed', usd(r.open ? r.owed : 0n))
  rp('incl', r.open ? `Includes ${usd(fee)} fee (${feePct()})` : 'Nothing to repay right now.')
  rp('b1', usd(principal)); rp('b2', usd(fee)); rp('b3', usd(r.open ? r.owed : 0n)); rp('b2l', `Fee (${feePct()})`)
  rp('lv', r.closed ? 'Cracked' : `Level ${r.lv}`)
  $('[data-rp="lvbar"]').style.width = r.pct + '%'
  rp('lvpct', r.pct + '%')
  rp('lvnext', r.closed ? 'Road closed' : r.lv === 3 ? 'Top level reached' : `Progress to Level ${r.lv + 1}`)
  $('[data-act="repay"]').classList.toggle('is-off', !r.open)
}

// ------------------------------------------------------------------ this wallet's history, from the events
const ICONS = {
  borrow: '<svg viewBox="0 0 24 24"><path d="M7 17 17 7M9 7h8v8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  repay: '<svg viewBox="0 0 24 24"><path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.7h3.7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  vouch: '<svg viewBox="0 0 24 24"><use href="#i-shield-ok"/></svg>',
  lend: '<svg viewBox="0 0 24 24"><path d="M4 9h13l-3.5-3.5M20 15H7l3.5 3.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  people: '<svg viewBox="0 0 40 32"><use href="#i-people"/></svg>',
  gift: '<svg viewBox="0 0 24 24"><use href="#i-gift"/></svg>',
  check: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m8 12.3 2.8 2.8L16.3 9.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  cal: '<svg viewBox="0 0 24 24"><use href="#i-cal"/></svg>',
  coins: '<svg viewBox="0 0 24 24"><use href="#i-coins"/></svg>',
  warn: '<svg viewBox="0 0 24 24"><use href="#i-warn"/></svg>',
  star: '<svg viewBox="0 0 24 24"><use href="#i-star"/></svg>',
  ext: '<svg viewBox="0 0 16 16"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 9.5v3.2a.8.8 0 0 1-.8.8H3.3a.8.8 0 0 1-.8-.8V4.8a.8.8 0 0 1 .8-.8h3.2" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>',
}

/// Everything this wallet did (or that happened to its road), newest first.
function myActivity() {
  const me = S.me?.toLowerCase()
  if (!me) return []
  const is = (x) => x && x.toLowerCase() === me
  const out = []
  const add = (e, kind, label, amount, note = '') => out.push({ id: `${e.transactionHash}:${e.logIndex}`, e, kind, label, amount, note, hash: e.transactionHash, block: e.blockNumber })
  for (const e of S.events) {
    const a = e.args
    switch (e.eventName) {
      case 'Borrowed': if (is(a.borrower)) add(e, 'borrow', 'Borrowing', usd(a.principal) + ' USDG', `due ${dateOf(a.due)}`); break
      case 'Repaid': if (is(a.borrower) || is(a.payer)) add(e, 'repay', 'Repayment', usd(a.owed) + ' USDG', a.late ? 'repaid late' : 'on time'); break
      case 'Vouched':
        if (is(a.voucher)) add(e, 'vouch', 'Vouch', wifWhole(a.amount) + ' $WIF', `for ${short(a.borrower)}`)
        else if (is(a.borrower)) add(e, 'vouch', 'Vouched for you', wifWhole(a.amount) + ' $WIF', `by ${short(a.voucher)}`)
        break
      case 'Unvouched': if (is(a.voucher)) add(e, 'vouch', 'Take back', wifWhole(a.amount) + ' $WIF', `from ${short(a.borrower)}`); break
      case 'Slashed': if (is(a.voucher)) add(e, 'vouch', 'Stone cut', wifWhole(a.amount) + ' $WIF', `${short(a.borrower)} defaulted`); break
      case 'RewardsClaimed': if (is(a.voucher)) add(e, 'vouch', 'Rewards', usd(a.amount) + ' USDG', 'collected'); break
      case 'Deposited': if (is(a.lender)) add(e, 'lend', 'Lending', usd(a.amount) + ' USDG', 'deposited'); break
      case 'Withdrawn': if (is(a.lender)) add(e, 'lend', 'Withdraw', usd(a.amount) + ' USDG', 'withdrawn'); break
      case 'WifClaimed': if (is(a.lender)) add(e, 'lend', 'Collect $WIF', wifWhole(a.amount) + ' $WIF', 'from defaults'); break
      case 'Defaulted':
        if (is(a.borrower)) add(e, 'repay', 'Default', usd(a.debt) + ' USDG', 'loan ended unpaid')
        else if (is(a.caller)) add(e, 'lend', 'End loan', usd(a.debt) + ' USDG', `for ${short(a.borrower)}`)
        break
    }
  }
  return out.reverse()
}

// Block times, fetched once each.
const BTIME = new Map()
async function fillTimes(blocks) {
  const need = [...new Set(blocks.map(String))].filter((b) => !BTIME.has(b))
  for (let i = 0; i < need.length; i += 8) {
    await Promise.all(need.slice(i, i + 8).map(async (b) => {
      try { BTIME.set(b, (await S.pub.getBlock({ blockNumber: BigInt(b) })).timestamp) } catch { BTIME.set(b, null) }
    }))
  }
  return need.length > 0
}
const timeOf = (block) => BTIME.get(String(block))
const stamp = (t) => (t == null ? '…' : new Date(Number(t) * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' • ' + new Date(Number(t) * 1000).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }))
const ago = (t) => {
  if (t == null) return ''
  const s = Number(now() - BigInt(t))
  return s < 60 ? 'now' : s < 3600 ? Math.floor(s / 60) + 'm ago' : s < 86400 ? Math.floor(s / 3600) + 'h ago' : Math.floor(s / 86400) + 'd ago'
}
const txLink = (h) => (S.dep.explorer ? `${S.dep.explorer}/tx/${h}` : '')
const COPY_ICO = '<svg viewBox="0 0 24 24"><rect x="8" y="8" width="12" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M16 8V5.5A1.5 1.5 0 0 0 14.5 4h-9A1.5 1.5 0 0 0 4 5.5v9A1.5 1.5 0 0 0 5.5 16H8" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>'

// ------------------------------------------------------------------ activity page
const ACT = { filter: 'all', page: 0, sel: null }

async function renderActivity() {
  const all = myActivity()
  if (await fillTimes(all.map((x) => x.block))) return renderActivity()
  const days = Number($('[data-in="arange"]').value)
  const since = days ? now() - BigInt(days * 86400) : 0n
  const list = all.filter((x) => (ACT.filter === 'all' || x.kind === ACT.filter) && BigInt(timeOf(x.block) ?? now()) >= since)
  $$('.filter[data-act="afilter"]').forEach((b) => b.classList.toggle('on', b.dataset.v === ACT.filter))
  const pages = Math.max(1, Math.ceil(list.length / 6))
  ACT.page = Math.max(0, Math.min(ACT.page, pages - 1))
  const rows = list.slice(ACT.page * 6, ACT.page * 6 + 6)
  if (!rows.some((x) => x.id === ACT.sel)) ACT.sel = rows[0]?.id ?? null
  const box = $('[data-arows]')
  box.classList.toggle('arows--empty', !rows.length)
  const kindName = ACT.filter === 'all' ? '' : $(`.filter[data-v="${ACT.filter}"]`).textContent.trim().toLowerCase() + ' '
  box.innerHTML = rows.length ? rows.map((x) => `<div class="arow${x.id === ACT.sel ? ' on' : ''}" data-act="arow" data-v="${x.id}" role="button" tabindex="0">
      <span class="ty">${ICONS[x.kind]}${x.label}</span><span>${stamp(timeOf(x.block))}</span><span class="am">${x.amount}</span>
      <span><span class="stp"><i></i>Completed</span></span><span class="hs">${x.hash.slice(0, 6)}…${x.hash.slice(-4)}</span>
      ${txLink(x.hash) ? `<a href="${txLink(x.hash)}" target="_blank" rel="noopener" aria-label="Open in the explorer">${ICONS.ext}</a>` : '<span></span>'}</div>`).join('')
    : `<p>No ${kindName}activity ${days ? `in the last ${days} days` : 'yet'}.</p>`
  set('[data-ac="showing"]', list.length ? `Showing ${ACT.page * 6 + 1}–${ACT.page * 6 + rows.length} of ${list.length} transactions` : '')
  const first = Math.max(0, Math.min(ACT.page - 1, pages - 4))
  const nums = Array.from({ length: Math.min(pages, 4) }, (_, i) => first + i)
  $('[data-pager]').innerHTML = list.length > 6 ? `<button data-act="apage" data-v="${ACT.page - 1}"${ACT.page ? '' : ' disabled'} aria-label="Previous">‹</button>` +
    nums.map((p) => `<button class="${p === ACT.page ? 'on' : ''}" data-act="apage" data-v="${p}">${p + 1}</button>`).join('') +
    `<button data-act="apage" data-v="${ACT.page + 1}"${ACT.page < pages - 1 ? '' : ' disabled'} aria-label="Next">›</button>` : ''
  const x = rows.find((r) => r.id === ACT.sel)
  $('[data-adetail]').innerHTML = x ? `<div class="adet"><h3>${ICONS.repay}Transaction Details</h3>
      <div class="hd2"><span class="sq">${ICONS[x.kind]}</span><span><b>${x.label}</b><small>${stamp(timeOf(x.block))}</small></span></div>
      <div class="amt"><span><small>Amount</small><b>${x.amount}</b></span><span style="text-align: right"><small>Status</small><span class="stp"><i></i>Completed</span></span></div>
      <dl><div><dt>Transaction Hash</dt><dd>${x.hash.slice(0, 6)}…${x.hash.slice(-4)} <button class="copybtn" style="width: calc(14 * var(--s)); height: calc(14 * var(--s)); vertical-align: middle" data-act="copy" data-text="${x.hash}" aria-label="Copy hash">${COPY_ICO}</button></dd></div>
      <div><dt>Network</dt><dd><i class="dotg" style="display: inline-block; width: calc(9 * var(--s)); height: calc(9 * var(--s)); margin-right: calc(6 * var(--s))"></i>${S.dep.network}</dd></div>
      <div><dt>Timestamp</dt><dd>${stamp(timeOf(x.block))}</dd></div>
      <div><dt>Details</dt><dd>${x.note}</dd></div>
      ${txLink(x.hash) ? `<div><dt>Block Explorer</dt><dd><a href="${txLink(x.hash)}" target="_blank" rel="noopener">View on Explorer →</a></dd></div>` : ''}</dl>
      <button class="btn-line gold-line" data-act="copy" data-text="${txLink(x.hash) || x.hash}">↥ Share Receipt</button></div>`
    : '<div class="adet adet--empty"><p>Pick a transaction to see its details.</p></div>'
}

// ------------------------------------------------------------------ notifications: from the events, and from what needs doing now
const NOTE = { filter: 'all', sel: null }
const readKey = () => 'pave-read-' + S.me?.toLowerCase()
const readSet = () => new Set((store.get(readKey()) ?? '').split(',').filter(Boolean))
const offCats = () => new Set((store.get('pave-notify-off') ?? '').split(',').filter(Boolean))

function myNotes() {
  const me = S.me?.toLowerCase(), m = S.mine
  if (!me || !m) return []
  const is = (x) => x && x.toLowerCase() === me
  const out = []
  const add = (n) => out.push(n)
  let repaid = 0
  for (const e of S.events) {
    const a = e.args, base = { id: `${e.transactionHash}:${e.logIndex}`, block: e.blockNumber, hash: e.transactionHash }
    switch (e.eventName) {
      case 'Vouched': if (is(a.borrower)) add({ ...base, cat: 'vouches', icon: 'people', title: 'Someone Vouched for Your Road', sub: `${short(a.voucher)} vouched ${wifWhole(a.amount)} $WIF for you.`, amount: wifWhole(a.amount) + ' $WIF', go: 'road', btn: 'View Your Road' }); break
      case 'Borrowed': if (is(a.borrower)) add({ ...base, cat: 'loans', icon: 'check', ok: true, title: 'Loan Sent Successfully', sub: `${usd(a.principal)} USDG is in your wallet. Repay ${usd(a.principal + a.fee)} by ${dateOf(a.due)}.`, amount: usd(a.principal) + ' USDG', go: 'repay', btn: 'View Loan' }); break
      case 'Repaid':
        if (is(a.borrower)) {
          add({ ...base, cat: 'loans', icon: 'check', ok: true, title: a.late ? 'Loan Repaid Late' : 'Loan Repaid', sub: `You repaid ${usd(a.owed)}. ${a.late ? 'Late, so your streak reset.' : 'Your road grew.'}`, amount: usd(a.owed) + ' USDG', go: 'road', btn: 'View Your Road' })
          const before = level(repaid)
          repaid = Number(a.repaid)
          if (level(repaid) > before) add({ ...base, id: base.id + ':lv', cat: 'loans', icon: 'star', title: `Your Road Reached ${LEVELS[level(repaid)]}`, sub: `You can now borrow up to ${capOf(level(repaid))}.`, amount: capOf(level(repaid)), go: 'levels', btn: 'See the Levels' })
        }
        break
      case 'VoucherRewarded': if (is(a.voucher)) add({ ...base, cat: 'rewards', icon: 'gift', title: 'You Earned Rewards!', sub: `+${usd(a.amount)} USDG from ${short(a.borrower)}'s repayment.`, amount: usd(a.amount) + ' USDG', go: 'vouch', btn: 'View Rewards' }); break
      case 'Slashed': if (is(a.voucher)) add({ ...base, cat: 'vouches', icon: 'warn', title: 'A Road You Backed Cracked', sub: `${wifWhole(a.amount)} $WIF was cut from your stone on ${short(a.borrower)}.`, amount: wifWhole(a.amount) + ' $WIF', go: 'vouch', btn: 'View Your Vouches' }); break
      case 'Deposited': if (is(a.lender)) add({ ...base, cat: 'lending', icon: 'coins', title: 'Deposit Confirmed', sub: `${usd(a.amount)} USDG is now in the lending pool.`, amount: usd(a.amount) + ' USDG', go: 'lend', btn: 'View Lending' }); break
      case 'Withdrawn': if (is(a.lender)) add({ ...base, cat: 'lending', icon: 'coins', title: 'Withdrawal Confirmed', sub: `${usd(a.amount)} USDG came back to your wallet.`, amount: usd(a.amount) + ' USDG', go: 'lend', btn: 'View Lending' }); break
    }
  }
  // what needs doing now (nothing on chain yet)
  const t = now(), r = roadState(m)
  if (r.open) {
    const left = r.due - t, term = BigInt(S.params.loanTerm ?? 1n)
    if (r.late) add({ id: `due-late:${r.due}`, time: t, cat: 'loans', icon: 'warn', title: 'Your Loan Is Overdue', sub: `Repay ${usd(r.owed)} before the grace period ends, or your vouchers lose $WIF.`, amount: usd(r.owed) + ' USDG', go: 'repay', btn: 'Repay Now' })
    else if (left * 5n < term) add({ id: `due-soon:${r.due}`, time: t, cat: 'loans', icon: 'cal', title: 'Repayment Due Soon', sub: `Your loan of ${usd(r.owed)} is due ${dur(left)}.`, amount: usd(r.owed) + ' USDG', go: 'repay', btn: 'Repay Now' })
  }
  if (m.rewards > 0n) add({ id: `claim:${m.rewards}`, time: t, cat: 'rewards', icon: 'gift', title: 'Rewards Ready to Collect', sub: `${usd(m.rewards)} USDG from fees is waiting for you.`, amount: usd(m.rewards) + ' USDG', act: 'claim-rewards', btn: 'Claim Rewards' })
  if (m.pendingWif > 0n) add({ id: `wif:${m.pendingWif}`, time: t, cat: 'lending', icon: 'coins', title: '$WIF From a Default', sub: `${wifWhole(m.pendingWif)} $WIF from a road that didn't repay is yours to collect.`, amount: wifWhole(m.pendingWif) + ' $WIF', act: 'claim-wif', btn: 'Collect $WIF' })
  for (const o of S.overdue ?? []) add({ id: `end:${o.addr}`, time: t, cat: 'lending', icon: 'warn', title: 'A Loan Passed Its Grace Period', sub: `${short(o.addr)} owes ${usd(o.owed)}. Anyone can end it: lenders get $WIF from its stones.`, amount: usd(o.owed) + ' USDG', act: 'default', b: o.addr, btn: 'End Loan' })
  const off = offCats()
  return out.filter((n) => !off.has(n.cat)).reverse()
}

function unreadCount() { const read = readSet(); return myNotes().filter((n) => !read.has(n.id)).length }

async function renderNotes() {
  const all = myNotes()
  if (await fillTimes(all.filter((n) => n.block != null).map((n) => n.block))) return renderNotes()
  const read = readSet()
  const unread = all.filter((n) => !read.has(n.id)).length
  set('[data-nt="all"]', unread ? String(unread) : '')
  const bell = $('[data-nt="count"]')
  bell.hidden = !unread
  bell.textContent = String(unread)
  $$('[data-act="nfilter"]').forEach((b) => b.classList.toggle('on', b.dataset.v === NOTE.filter))
  const list = all.filter((n) => NOTE.filter === 'all' || n.cat === NOTE.filter)
  if (!list.some((n) => n.id === NOTE.sel)) NOTE.sel = list[0]?.id ?? null
  const box = $('[data-nlist]')
  box.classList.toggle('nlist--empty', !list.length)
  const when = (n) => ago(n.block != null ? timeOf(n.block) : n.time)
  box.innerHTML = list.length ? list.slice(0, 6).map((n) => `<button class="nrow${read.has(n.id) ? '' : ' unread'}${n.id === NOTE.sel ? ' on' : ''}" data-act="nrow" data-v="${n.id}">
      <i class="dot"></i><i class="ic${n.ok ? ' ok' : ''}">${ICONS[n.icon]}</i><span><b>${n.title}</b><small>${n.sub}</small></span><time>${when(n)}</time>
      <svg viewBox="0 0 16 16"><use href="#i-chev"/></svg></button>`).join('') : "<p>You're all caught up.</p>"
  const n = list.find((x) => x.id === NOTE.sel)
  $('[data-ndetail]').innerHTML = n ? `<div class="ndet"><span class="big">${ICONS[n.icon]}</span><h3>${n.title}</h3><p>${n.sub}</p>
      <dl><div><dt>Amount</dt><dd>${n.amount}</dd></div>${n.hash ? `<div><dt>Transaction Hash</dt><dd>${n.hash.slice(0, 6)}…${n.hash.slice(-4)}</dd></div>` : ''}
      <div><dt>Time</dt><dd>${n.block != null ? stamp(timeOf(n.block)) : 'Now'}</dd></div></dl>
      ${n.act ? `<button class="btn-gold" data-act="${n.act}"${n.b ? ` data-b="${n.b}"` : ''}>${n.btn}${ARROW}</button>` : `<a class="btn-gold" href="#/${n.go}">${n.btn}${ARROW}</a>`}</div>`
    : `<div class="ndet"><span class="big">${ICONS.check}</span><h3>All caught up</h3><p>New vouches, loans and rewards show up here.</p></div>`
  if (n && !read.has(n.id)) { read.add(n.id); store.set(readKey(), [...read].join(',')); badge() }
}

function badge() {
  const n = S.me && S.mine ? unreadCount() : 0
  $('[data-badge]').hidden = !n
  set('[data-badge-n]', n ? String(n) : '')
}

// ------------------------------------------------------------------ believers page
const BEL = { sort: 'backed' }

/// Believers with the $WIF they have behind people now, ranked.
function rankedBelievers(by = BEL.sort) {
  const m = S.model
  const wif = new Map()
  for (const r of m.roads.values()) for (const [k, v] of r.vouches) wif.set(k, (wif.get(k) ?? 0n) + v.amount)
  const cmpWif = (a, b) => (b.wif > a.wif ? 1 : b.wif < a.wif ? -1 : 0)
  return [...m.believers.values()].filter((b) => b.backed.size)
    .map((b) => ({ ...b, wif: wif.get(b.addr.toLowerCase()) ?? 0n }))
    .sort((a, b) => (by === 'repaid' ? b.repaidBacked - a.repaidBacked || cmpWif(a, b) : cmpWif(a, b) || b.repaidBacked - a.repaidBacked))
}
const wifValue = (w) => (S.prices ? usd0(wifUsd(w)) : wifWhole(w) + ' $WIF')
const wifCompact = (w) => { const n = Number(w) / 1e18; return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : n.toFixed(0) }

function renderBelievers() {
  const list = rankedBelievers()
  const top = rankedBelievers('backed').slice(0, 3)
  $('[data-top3]').innerHTML = [0, 1, 2].map((i) => {
    const b = top[i]
    return b ? `<button class="pcard" data-act="believer" data-v="${b.addr}"><img class="medal" src="assets/medal-${i + 1}.png" alt="${i + 1}"><img class="ava" src="${avaOf(b.addr)}" alt="">
      <span class="nm"><b>${b.addr.slice(0, 5)}…${b.addr.slice(-4)}</b><small>${b.backed.size} backed · ${b.repaidBacked} repaid</small></span><span class="val"><b>${wifValue(b.wif)}</b><small>Total $WIF Vouched</small></span></button>`
      : `<div class="pcard pcard--empty">${i ? 'Open spot' : 'No believers yet'}</div>`
  }).join('')
  $$('[data-act="sort"]').forEach((b) => b.classList.toggle('on', b.dataset.v === BEL.sort))
  const rows = list.slice(0, 5)
  $('[data-lboard]').innerHTML = `<div class="lrow"><span style="padding-left: calc(10 * var(--s))">#</span><span>User</span><span style="text-align: center">${BEL.sort === 'repaid' ? 'Loans Repaid' : 'Total $WIF Backed'}</span><span>People Supported</span><span></span></div>` +
    (rows.length ? rows.map((b, i) => `<div class="lrow${same(b.addr, S.me) ? ' me' : ''}"><span class="rk">${i + 1}</span>
      <span class="us"><img src="${avaOf(b.addr)}" alt=""><span><b>${short(b.addr)}</b><small>${b.repaidBacked} repaid · ${b.slashed} cut</small></span></span>
      <span class="tot">${BEL.sort === 'repaid' ? b.repaidBacked : wifValue(b.wif)}</span><span class="ppl">${ICONS.people}${b.backed.size}</span>
      <button class="vp" data-act="believer" data-v="${b.addr}">View Profile →</button></div>`).join('')
      : '<div class="lrow lrow--none">No one has vouched yet. Be the first believer.</div>')
  set('[data-bl="impact"]', wifCompact(S.model.vouched) + (S.model.vouched ? '+' : ''))
}

function openBeliever(addr) {
  const b = rankedBelievers().find((x) => same(x.addr, addr))
  if (!b) return
  const road = S.model.roads.get(addr.toLowerCase())
  openSheet(short(addr), `<div class="srow"><img class="ava" src="${avaOf(addr)}" alt=""><span><b class="addr-mono">${addr}</b><small>${road ? (road.defaulted ? 'Cracked road' : LEVELS[level(road.repaid)] + ' road') : 'No road of their own yet'}</small></span></div>
    <dl class="kv" style="margin-top: 14px"><div><dt>$WIF behind people</dt><dd>${wifWhole(b.wif)}</dd></div><div><dt>People backed</dt><dd>${b.backed.size}</dd></div>
    <div><dt>Loans repaid</dt><dd>${b.repaidBacked}</dd></div><div><dt>Stones cut</dt><dd>${b.slashed}</dd></div><div><dt>Earned</dt><dd>${usd(b.earned)}</dd></div></dl>
    ${same(addr, S.me) ? '' : `<button class="btn" data-act="vouch-for" data-v="${addr}" style="margin-top: 6px">Vouch for this person</button>`}`)
}

function openHall() {
  const list = rankedBelievers()
  openSheet('Hall of Fame', list.length ? list.map((b, i) => `<div class="srow"><b style="width: 24px; color: var(--gold)">${i + 1}</b><img class="ava" src="${avaOf(b.addr)}" alt="">
    <span><b class="addr-mono">${short(b.addr)}</b><small>${b.backed.size} backed · ${b.repaidBacked} repaid · ${b.slashed} cut · earned ${usd(b.earned)}</small></span>
    <b>${wifValue(b.wif)}</b><button class="btn btn--ghost btn--small" data-act="believer" data-v="${b.addr}">Profile</button></div>`).join('')
    : '<p class="note">No believers yet.</p>')
}

// ------------------------------------------------------------------ lend page
function renderLend() {
  const m = S.mine, p = S.pool, me = S.me.toLowerCase()
  let net = 0n
  for (const e of S.events) {
    if (e.eventName === 'Deposited' && e.args.lender.toLowerCase() === me) net += e.args.amount
    if (e.eventName === 'Withdrawn' && e.args.lender.toLowerCase() === me) net -= e.args.amount
  }
  set('[data-ln="bal"]', usd(m.usdgBal))
  set('[data-ln="dep"]', usd(m.shareValue))
  set('[data-ln="share"]', p.totalShares ? (Number((m.shares * 10_000n) / p.totalShares) / 100).toFixed(2) + '%' : '0%')
  const earned = m.shareValue - net
  const it = $('[data-ln="int"]')
  it.textContent = (earned < 0n ? '−' : '') + usd(earned < 0n ? -earned : earned) + (earned > 0n ? ' ↑' : '')
  it.style.color = earned < 0n ? 'var(--red)' : '#4ade80'
  set('[data-ln="total"]', usd0(p.idle + p.outstanding))
  set('[data-ln="idle"]', usd0(p.idle))
  set('[data-ln="out"]', usd0(p.outstanding))
  const avail = m.shareValue < p.idle ? m.shareValue : p.idle
  set('[data-ln="avail"]', usd(avail))
  $('[data-ln="wsub"]').innerHTML = m.pendingWif > 0n
    ? `Plus ${wifWhole(m.pendingWif)} $WIF from defaults. <button class="linkbtn" style="display: inline; font-size: inherit" data-act="claim-wif">Collect →</button>`
    : 'Take out what isn’t lent out, anytime.'
  $('[data-act="withdraw"]').classList.toggle('is-off', avail === 0n)
}

// ------------------------------------------------------------------ vouch page
function myVouchList() {
  const me = S.me.toLowerCase()
  const earned = new Map()
  for (const e of S.events) {
    if (e.eventName !== 'VoucherRewarded' || e.args.voucher.toLowerCase() !== me) continue
    const k = e.args.borrower.toLowerCase()
    earned.set(k, (earned.get(k) ?? 0n) + e.args.amount)
  }
  return S.mine.backed.map((x) => ({ ...x, earned: earned.get(x.road.addr.toLowerCase()) ?? 0n })).reverse()
}
const vouchStatus = (road) => (road.defaulted ? ['bad', 'Cracked'] : road.open ? ['warn', 'Loan open'] : ['', 'Active'])

function renderVouch() {
  const m = S.mine
  const input = $('[data-in="vouch-for"]')
  if (S.vouchFor && !input.value && document.activeElement !== input) input.value = S.vouchFor
  const t = input.value.trim()
  const r = isAddress(t) ? S.model.roads.get(t.toLowerCase()) : null
  let about = ''
  if (t && !isAddress(t)) about = "That isn't a wallet address yet."
  else if (same(t, S.me)) about = "That's you. Ask a friend to vouch for you instead."
  else if (isAddress(t)) {
    let total = 0n
    if (r) for (const v of r.vouches.values()) total += v.amount
    about = r ? `${r.defaulted ? 'Cracked road' : LEVELS[level(r.repaid)]} · ${r.vouches.size} stones (${wifWhole(total)} $WIF)${r.open ? ' · loan open: a new vouch is at risk at once' : ''}` : 'A new road: your vouch would be its first stone.'
  }
  set('[data-vc="about"]', about)
  set('[data-vc="bal"]', `Balance: ${wifWhole(m.wifBal)} $WIF`)
  const amt = (val('vouch-amt') ?? '').replace(/,/g, '')
  $$('[data-act="vouch-chip"]').forEach((b) => b.classList.toggle('on', b.dataset.v ? amt === b.dataset.v : !!amt && !['10000', '50000', '100000'].includes(amt)))
  const list = myVouchList()
  const pick = list.find((x) => same(x.road.addr, S.vouchFor)) ?? list[0]
  const row = $('[data-vrow]')
  if (pick) {
    const [cls, label] = vouchStatus(pick.road)
    row.className = 'a vrow'
    row.dataset.act = 'my-vouches'
    row.innerHTML = `<img src="${avaOf(pick.road.addr)}" alt=""><span class="who2"><b>${short(pick.road.addr)}</b><small>${pick.road.defaulted ? 'Cracked road' : LEVELS[level(pick.road.repaid)]}</small></span>
      <span class="amt"><b>${wifCompact(pick.amount)} $WIF</b><small>Locked</small></span><span class="rw"><b>+${usd(pick.earned)}</b><small>Rewards</small></span>
      <span class="okpill ${cls}"><i></i>${label}</span>`
  } else {
    row.className = 'a vrow vrow--empty'
    delete row.dataset.act
    row.textContent = 'You are not vouching for anyone yet. Enter a friend’s address to lay your first stone.'
  }
  set('[data-vc="earned"]', '+' + usd(list.reduce((s, x) => s + x.earned, 0n)))
  set('[data-vc="claim"]', '+' + usd(m.rewards))
  $('[data-act="claim-rewards"]').classList.toggle('is-off', m.rewards === 0n)
}

function openMyVouches() {
  const list = myVouchList()
  openSheet('Your Active Vouches', list.length ? list.map((x) => {
    const [cls, label] = vouchStatus(x.road)
    return `<div class="srow"><img class="ava" src="${avaOf(x.road.addr)}" alt=""><span><b class="addr-mono">${short(x.road.addr)}</b><small>${x.road.defaulted ? 'Cracked road' : LEVELS[level(x.road.repaid)]} · earned ${usd(x.earned)} · <span class="${cls === 'bad' ? 'note--warn' : ''}">${label}</span></small></span>
      <b>${wifWhole(x.amount)} $WIF</b><button class="btn btn--ghost btn--small" data-act="unvouch" data-b="${x.road.addr}"${x.road.open ? ' disabled title="Frozen while their loan is open"' : ''}>Take back</button></div>`
  }).join('') + '<p class="note">You can take a stone back whenever that road has no open loan.</p>' : '<p class="note">You are not vouching for anyone yet.</p>')
}

// ------------------------------------------------------------------ profile page
function renderProfilePage() {
  const m = S.mine, r = roadState(m)
  set('[data-pf="name"]', store.get('pave-name-' + S.me.toLowerCase()) || 'Your wallet')
  set('[data-pf="addr"]', S.me.slice(0, 6) + '...' + S.me.slice(-4))
  const mine = myActivity()
  const last = mine[0] ? timeOf(mine[0].block) : null
  if (mine[0] && last === undefined) fillTimes([mine[0].block]).then(() => VIEW.page === 'profile' && renderProfilePage())
  set('[data-pf="last"]', !mine.length ? 'No activity yet' : last == null ? '…' : now() - BigInt(last) < 86400n ? 'Active today' : 'Active ' + ago(last))
  set('[data-pf="lv"]', r.closed ? 'Cracked' : LEVELS[r.lv])
  let borrowed = 0n
  for (const e of S.events) if (e.eventName === 'Borrowed' && same(e.args.borrower, S.me)) borrowed += e.args.principal
  set('[data-pf="borrowed"]', usd0(borrowed))
  set('[data-pf="backed"]', wifValue(m.vouches.reduce((s, v) => s + v.amount, 0n)))
  set('[data-pf="rep"]', `${r.repaid} repaid`)
  $('[data-pf="bar"]').style.width = r.pct + '%'
  set('[data-pf="next"]', r.closed ? 'Road closed' : r.lv === 3 ? 'Top level' : `Next Level: ${LEVELS[r.lv + 1]}`)
}

async function openApprovals() {
  const [u, w] = await Promise.all([read('allowance', [S.me, S.dep.Pave], S.dep.usdg, S.abis.Token), read('allowance', [S.me, S.dep.Pave], S.dep.wif, S.abis.Token)])
  const row = (name, token, amt, fmt) => `<div class="srow"><span><b>${name}</b><small>Pave may move ${amt ? fmt(amt) : 'nothing'} from your wallet</small></span>
    ${amt ? `<button class="btn btn--ghost btn--small" data-act="revoke" data-v="${token}">Revoke</button>` : '<b class="note">None</b>'}</div>`
  openSheet('Security: token approvals', `<p class="note">Pave asks for exactly what each action needs, so these are usually empty. Revoking costs a little gas.</p>
    ${row('USDG', S.dep.usdg, u, (x) => usd(x))}${row('$WIF', S.dep.wif, w, (x) => wifWhole(x) + ' $WIF')}`)
}

function openNotifyPrefs() {
  const off = offCats()
  const cats = [['loans', 'Loans', 'Sent, repaid, due soon, overdue, level ups'], ['vouches', 'Vouches', 'Someone vouched for you, a road you back cracked'],
    ['lending', 'Lending', 'Deposits, withdrawals, $WIF from defaults, loans anyone can end'], ['rewards', 'Rewards', 'Fees earned and ready to collect']]
  openSheet('Notification Preferences', '<p class="note">Saved in this browser.</p>' + cats.map(([k, t, d]) => `<label class="srow" style="cursor: pointer"><span><b>${t}</b><small>${d}</small></span>
    <input type="checkbox" data-pref="${k}"${off.has(k) ? '' : ' checked'} style="width: 20px; height: 20px; accent-color: #f6b63a"></label>`).join(''))
}

function openNetwork() {
  openSheet('Network Preferences', `<div class="srow"><i class="dotg" style="width: 12px; height: 12px"></i><span><b>${S.dep.network}</b><small>Chain id ${S.dep.chainId}${S.dep.explorer ? ` · <a href="${S.dep.explorer}" target="_blank" rel="noopener">explorer</a>` : ''}</small></span></div>
    <p class="note">Pave lives on ${S.dep.network} only. If your wallet is on another network, switch it here; it can add the network for you.</p>
    <button class="btn" data-act="switch-net" style="margin-top: 12px">Switch Network</button>`)
}

// ------------------------------------------------------------------ sheets: details that open on a click
// One pop-up for the lists the pages only summarise (supporters, all vouches, a believer, ...).
function openSheet(title, body) {
  let el = $('[data-sheet]')
  if (!el) {
    el = document.createElement('div')
    el.className = 'txm sheet-wrap'
    el.dataset.sheet = ''
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-modal', 'true')
    el.innerHTML = '<div class="sheet"><button class="sheet__x" data-act="sheet-close" aria-label="Close">×</button><h2></h2><div class="sheet__body"></div></div>'
    el.addEventListener('click', (e) => { if (e.target === el) closeSheet() })
    document.body.append(el)
  }
  $('h2', el).textContent = title
  $('.sheet__body', el).innerHTML = body
  el.hidden = false
  S.sheet = { title, body }
}
const closeSheet = () => { const el = $('[data-sheet]'); if (el) { el.hidden = true; $('.sheet', el).classList.remove('sheet--card') } S.sheet = null }

// ------------------------------------------------------------------ share cards (Figma frames 8 and 9)
// The card as the design draws it, with this wallet's road, link and QR on it; "Download image"
// draws the same card on a canvas, so it can be attached to a post.
function qrOf(text) {
  const q = qrcode(0, 'M')
  q.addData(text)
  q.make()
  const n = q.getModuleCount()
  let d = ''
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`
  return { svg: `<svg viewBox="-1 -1 ${n + 2} ${n + 2}" shape-rendering="crispEdges"><path d="${d}" fill="#0b0b0d"/></svg>`, q, n }
}

const CARD = {
  vouch: () => {
    const r = roadState(S.mine), link = shareLink(S.me)
    return {
      img: 'assets/share-vouch.jpg', link,
      tweet: 'Back my road on Pave: vouch $WIF for me and earn part of every fee when I repay. @WIFonRH',
      texts: [
        { x: 180, t: 446, f: 26, w: 700, c: '#f5f5f6', s: r.closed ? 'Cracked' : LEVELS[r.lv] },
        { x: 473, t: 418, f: 15, w: 500, c: '#c9c9cf', s: 'Minimum Vouch' },
        { x: 473, t: 446, f: 26, w: 700, c: '#f5f5f6', s: wifWhole(S.params.minVouch ?? 0n) + ' $WIF' },
        { x: 122, t: 566, f: 17, w: 500, c: '#e4e4e7', s: link.replace(/^https?:\/\//, '').replace(/(0x[0-9a-fA-F]{4})[0-9a-fA-F]{32}([0-9a-fA-F]{4})/, '$1…$2') },
      ],
      qr: { x: 1027, y: 307, s: 180, text: link },
      hits: [{ x: 525, y: 550, w: 100, h: 50, act: 'copy', text: link, label: 'Copy link' }, { x: 683, y: 545, w: 252, h: 65, act: 'share-card', label: 'Share' }],
    }
  },
  highway: () => ({
    img: 'assets/share-highway.jpg', link: location.origin + location.pathname,
    tweet: `I just reached Highway on Pave: ${Number(S.mine.path.repaid)} loans repaid, borrowing up to ${capOf(3)}. Credit from people who believe in you. @WIFonRH`,
    texts: [], qr: null,
    hits: [{ x: 872, y: 578, w: 356, h: 74, act: 'share-card', label: 'Share My Achievement' }],
  }),
}

function openCard(kind) {
  if (!S.mine) return
  const c = CARD[kind]()
  S.card = { kind, c }
  const texts = c.texts.map((t) => `<p class="tx" style="--x: ${t.x}; --t: ${t.t}; --f: ${t.f}; color: ${t.c}; font-weight: ${t.w}">${t.s}</p>`).join('')
  const qr = c.qr ? `<div class="a qrbox" style="--x: ${c.qr.x}; --y: ${c.qr.y}; --w: ${c.qr.s}; --h: ${c.qr.s}">${qrOf(c.qr.text).svg}</div>` : ''
  const hits = c.hits.map((h) => `<button class="a hit hit--pill" style="--x: ${h.x}; --y: ${h.y}; --w: ${h.w}; --h: ${h.h}" data-act="${h.act}"${h.text ? ` data-text="${h.text}"` : ''}>${h.label}</button>`).join('')
  openSheet(kind === 'vouch' ? 'Share your road' : 'You reached Highway', `<div class="stage sharecard" style="--bg: url(${c.img})">${texts}${qr}${hits}</div>
    <div class="row" style="margin-top: 14px"><button class="btn" data-act="share-card">Post on X</button><button class="btn btn--ghost" data-act="card-png">Download image</button>
    <button class="btn btn--ghost" data-act="copy" data-text="${c.link}">Copy link</button></div>`)
  $('[data-sheet] .sheet').classList.add('sheet--card')
}

/// The card on a canvas at twice the size, for attaching to a post.
async function cardPng() {
  const { kind, c } = S.card
  const img = new Image()
  img.src = c.img
  await img.decode()
  await document.fonts.load('700 20px "Plus Jakarta Sans"')
  const k = 2, cv = document.createElement('canvas')
  cv.width = 1280 * k
  cv.height = 720 * k
  const g = cv.getContext('2d')
  g.drawImage(img, 0, 0, cv.width, cv.height)
  g.scale(k, k)
  for (const t of c.texts) { g.font = `${t.w} ${t.f}px "Plus Jakarta Sans"`; g.fillStyle = t.c; g.fillText(t.s, t.x, t.t + 0.76 * t.f) }
  if (c.qr) {
    const { q, n } = qrOf(c.qr.text), m = (c.qr.s - 16) / (n + 2)
    g.fillStyle = '#fff'
    g.beginPath(); g.roundRect(c.qr.x, c.qr.y, c.qr.s, c.qr.s, 14); g.fill()
    g.fillStyle = '#0b0b0d'
    for (let r = 0; r < n; r++) for (let col = 0; col < n; col++) if (q.isDark(r, col)) g.fillRect(c.qr.x + 8 + (col + 1) * m, c.qr.y + 8 + (r + 1) * m, m + .3, m + .3)
  }
  const a = document.createElement('a')
  a.download = `pave-${kind}.png`
  a.href = cv.toDataURL('image/png')
  a.click()
}

const shareCard = () => {
  const { c } = S.card
  open(`https://x.com/intent/post?text=${encodeURIComponent(c.tweet)}&url=${encodeURIComponent(c.link)}`, '_blank', 'noopener')
}

function openSupporters() {
  const m = S.mine
  if (!m) return
  const open = m.loan[0] > 0n
  const rows = m.vouches.map((v) => {
    const at = BigInt(v.since) + BigInt(S.params.vouchMaturity ?? 0n)
    const ripe = now() >= at
    return `<div class="srow"><img class="ava" src="${avaOf(v.voucher)}" alt=""><span><b class="addr-mono">${short(v.voucher)}</b><small>${ripe ? 'Counts toward your limit' : 'Counts ' + dur(at - now())}</small></span>
      <b>${wifWhole(v.amount)} $WIF</b>${open ? '' : `<button class="btn btn--ghost btn--small" data-act="return" data-v="${v.voucher}" title="Hand this vouch back">Return</button>`}</div>`
  }).join('')
  const link = shareLink(S.me)
  const tweet = `I'm paving my own road on Pave. Vouch for me with $WIF and earn when I repay. @WIFonRH`
  openSheet('Your Supporters', `${rows || '<p class="note">No one has vouched for you yet. Send your link to people who believe in you.</p>'}
    <h3>Ask for vouches</h3><p class="note">Their $WIF stays theirs unless you don't repay, and they earn ${pctOf(S.params.voucherShareBps, '30%')} of every fee you pay.</p>
    <div class="share"><code>${link}</code><button class="btn btn--ghost btn--small" data-act="copy" data-text="${link}">Copy</button>
    <a class="btn btn--small" target="_blank" rel="noopener" href="https://x.com/intent/post?text=${encodeURIComponent(tweet)}&url=${encodeURIComponent(link)}">Post on X</a></div>`)
}

// ------------------------------------------------------------------ the map tour
// Labels for the flat map, shown one at a time: by "Explore the Map" (a tour, from the first),
// or by clicking that part of the map. x, y, w, h are design pixels of the map picture
// (x 0-905, y 246-580); the words use the contract's own numbers once they're read.

const capOf = (i) => (S.params['cap' + i] != null ? '$' + Number(S.params['cap' + i]) / 1e6 : ['$10', '$25', '$50', '$100'][i])
const pctOf = (bps, fallback) => (bps != null ? Number(bps) / 100 + '%' : fallback)
const SPOTS = [
  { x: 452, y: 318, w: 120, h: 90, title: () => 'The Pave pool',
    text: () => `Lenders' USDG waits here. Loans go out along the roads, and every repayment comes back with a ${pctOf(S.params.feeBps, '3%')} fee.` },
  { x: 375, y: 410, w: 56, h: 60, title: () => 'A person',
    text: () => 'Every pin is a wallet. Connect yours and share your link: friends who believe in you vouch for it.' },
  { x: 485, y: 497, w: 40, h: 36, title: () => '$WIF stones',
    text: () => `The $WIF friends lock behind you. After ${S.params.vouchMaturity != null ? dur(BigInt(S.params.vouchMaturity)).replace('in ', '') : '3 days'} it lets you borrow 40% of its value, and they earn ${pctOf(S.params.voucherShareBps, '30%')} of every fee you pay.` },
  { x: 262, y: 452, w: 90, h: 40, title: () => `Dirt path · up to ${capOf(0)}`,
    text: () => 'Where every road starts. Repay one loan on time to lay gravel.' },
  { x: 572, y: 333, w: 80, h: 30, title: () => `Gravel · up to ${capOf(1)}`,
    text: () => 'One loan repaid. Two more reach cobblestone.' },
  { x: 232, y: 362, w: 90, h: 34, title: () => `Cobblestone · up to ${capOf(2)}`,
    text: () => 'Three loans repaid. Three more reach the highway.' },
  { x: 565, y: 428, w: 90, h: 44, title: () => `Highway · up to ${capOf(3)}`,
    text: () => 'Six loans repaid: the best credit on the map.' },
  { x: 738, y: 425, w: 100, h: 70, title: () => 'Cracked road',
    text: () => "A loan wasn't repaid. Up to twice the debt in $WIF is cut from its stones: the lenders get one share, the rest is burned. This road can't borrow again." },
]
const tour = { i: -1 }

function setupTour() {
  const box = $('[data-map]')
  if (!box) return
  const at = (v, total, from = 0) => ((v - from) / total) * 100 + '%'
  SPOTS.forEach((p, i) => {
    const b = document.createElement('button')
    b.className = 'spot'
    b.dataset.spot = i
    b.setAttribute('aria-label', p.title())
    Object.assign(b.style, { left: at(p.x, 905), top: at(p.y, 334, 246), width: at(p.w, 905), height: at(p.h, 334) })
    box.append(b)
  })
  const tip = document.createElement('div')
  tip.className = 'tip'
  tip.hidden = true
  tip.setAttribute('role', 'dialog')
  tip.setAttribute('aria-live', 'polite')
  tip.innerHTML = `<i class="tip__arrow"></i><button class="tip__x" data-tip="close" aria-label="Close">×</button>
    <span class="tip__n"></span><b></b><p></p>
    <div class="tip__nav"><button data-tip="prev">‹ Back</button><button class="next" data-tip="next">Next ›</button></div>`
  box.append(tip)

  box.addEventListener('click', (e) => {
    const s = e.target.closest('[data-spot]')
    if (s) return showSpot(Number(s.dataset.spot))
    const t = e.target.closest('[data-tip]')?.dataset.tip
    if (t === 'close') hideSpot()
    if (t === 'next') showSpot(tour.i + 1 < SPOTS.length ? tour.i + 1 : -1)
    if (t === 'prev') showSpot(Math.max(0, tour.i - 1))
  })
  document.addEventListener('click', (e) => { if (tour.i >= 0 && !e.target.closest('[data-map], [data-act="tour"]')) hideSpot() })
  document.addEventListener('keydown', (e) => {
    if (tour.i < 0) return
    if (e.key === 'Escape') hideSpot()
    if (e.key === 'ArrowRight') showSpot(Math.min(SPOTS.length - 1, tour.i + 1))
    if (e.key === 'ArrowLeft') showSpot(Math.max(0, tour.i - 1))
  })
  addEventListener('resize', () => { if (tour.i >= 0) showSpot(tour.i) })
}

function showSpot(i) {
  if (i < 0) return hideSpot()
  const box = $('[data-map]'), tip = $('.tip', box), p = SPOTS[i]
  tour.i = i
  $$('.spot', box).forEach((b) => b.classList.toggle('on', Number(b.dataset.spot) === i))
  $('.tip__n', tip).textContent = `${i + 1} / ${SPOTS.length}`
  $('b', tip).textContent = p.title()
  $('p', tip).textContent = p.text()
  $('[data-tip="prev"]', tip).disabled = i === 0
  $('[data-tip="next"]', tip).textContent = i === SPOTS.length - 1 ? 'Done' : 'Next ›'
  tip.hidden = false
  // Above the spot when it fits, else below; kept inside the map's width.
  const W = box.clientWidth, H = box.clientHeight, k = W / 905
  const cx = p.x * k, cy = (p.y - 246) * k, r = (p.h / 2) * k
  const w = Math.min(280, W - 16)
  tip.style.width = w + 'px'
  const left = Math.min(Math.max(cx - w / 2, 8), W - w - 8)
  const above = cy - r - tip.offsetHeight - 14 >= -40
  tip.classList.toggle('below', !above)
  tip.style.left = left + 'px'
  tip.style.top = (above ? cy - r - tip.offsetHeight - 14 : Math.min(cy + r + 14, H)) + 'px'
  tip.style.setProperty('--ax', cx - left + 'px')
}

function hideSpot() {
  tour.i = -1
  const box = $('[data-map]')
  if (!box) return
  $('.tip', box).hidden = true
  $$('.spot', box).forEach((b) => b.classList.remove('on'))
}

/// The nav link of the section in view is marked.
function spy() {
  const links = $$('[data-nav]')
  const owner = { map: 'map', road: 'road', 'your-road': 'road', vouch: 'vouch', 'vouch-form': 'vouch', lend: 'lend', believers: 'believers' }
  const seen = new Map()
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) seen.set(e.target.id, e.isIntersecting ? e.intersectionRatio : 0)
    let best = null, ratio = 0
    for (const [id, r] of seen) if (r > ratio) { best = id; ratio = r }
    links.forEach((a) => a.setAttribute('aria-current', String(!!best && owner[best] === a.dataset.nav)))
  }, { threshold: [0, .15, .3, .5, .7] })
  for (const id of Object.keys(owner)) { const el = document.getElementById(id); if (el) io.observe(el) }
}

/// Open loans past their grace period, read straight from the contract.
async function findOverdue() {
  const open = [...S.model.roads.values()].filter((r) => r.open)
  const list = []
  for (const r of open) {
    const l = await read('loans', [r.addr])
    if (l[0] === 0n) continue
    const graceEnd = l[2] + BigInt(S.params.grace ?? 0n)
    if (now() > graceEnd) list.push({ addr: r.addr, owed: l[0] + l[1], graceEnd })
  }
  S.overdue = list
}

// ------------------------------------------------------------------ actions

const val = (key) => $(`[data-in="${key}"]`)?.value

const ACTIONS = {
  // the landing page's wallet button: into the app (the connect page if no wallet yet)
  'open-app': () => { location.hash = S.me ? '#/road' : '#/connect' },
  connect: () => {
    if (S.me) return afterConnect()
    const first = window.ethereum ?? WALLETS.values().next().value?.provider
    return connect(first)
  },
  'wallet-menu': (b) => {
    if (!S.me) { location.hash = '#/connect'; return }
    const m = $('[data-menu]')
    m.hidden = !m.hidden
    b.setAttribute('aria-expanded', String(!m.hidden))
  },
  disconnect: () => { hideMenu(); disconnect() },
  'sheet-close': () => closeSheet(),
  'share-vouch': () => openCard('vouch'),
  'share-highway': () => openCard('highway'),
  'share-card': () => shareCard(),
  'card-png': () => cardPng().catch((e) => toast(explain(e), 'err')),
  info: (b) => { const [t, body] = INFO()[b.dataset.v]; openSheet(t, body) },
  'switch-net': async () => {
    if (!S.me) { toast('Connect a wallet first.', 'err'); return }
    try { await ensureChain(); toast(`On ${S.dep.network}.`, 'ok') } catch (e) { toast(explain(e), 'err') }
  },
  'road-max': () => { const i = $('[data-in="road-amt"]'); if (i && S.mine?.credit) i.value = (Number(S.mine.credit.available) / 1e6).toFixed(2) },
  'road-go': () => {
    const r = roadState(S.mine)
    if (r.open) { location.hash = '#/repay'; return }
    if (r.closed) return
    $('[data-in="borrow"]').value = val('road-amt') || ''
    location.hash = '#/borrow'
  },
  'borrow-chip': (b) => { $('[data-in="borrow"]').value = (Number(b.dataset.v) / 1e6).toFixed(2); renderBorrow() },
  supporters: () => openSupporters(),
  // vouch page
  'paste-for': async () => {
    try { const t = (await navigator.clipboard.readText()).trim(); $('[data-in="vouch-for"]').value = t; renderVouch() } catch { toast('Paste the address into the box.', 'err') }
  },
  'vouch-chip': (b) => { const i = $('[data-in="vouch-amt"]'); i.value = b.dataset.v; if (!b.dataset.v) i.focus(); renderVouch() },
  'my-vouches': () => openMyVouches(),
  'vouch-for': (b) => { closeSheet(); S.vouchFor = getAddress(b.dataset.v); $('[data-in="vouch-for"]').value = S.vouchFor; location.hash = '#/vouch'; renderApp() },
  // lend page
  'lend-pct': (b) => { if (S.mine) $('[data-in="lend-amt"]').value = (Number((S.mine.usdgBal * BigInt(b.dataset.v)) / 100n) / 1e6).toFixed(2) },
  // believers page
  sort: (b) => { BEL.sort = b.dataset.v; renderBelievers() },
  believer: (b) => openBeliever(b.dataset.v),
  hall: () => openHall(),
  // activity page
  afilter: (b) => { ACT.filter = b.dataset.v; ACT.page = 0; if (VIEW.page !== 'activity') location.hash = '#/activity'; else renderActivity() },
  apage: (b) => { ACT.page = Number(b.dataset.v); renderActivity() },
  arow: (b) => { ACT.sel = b.dataset.v; renderActivity() },
  // notifications page
  nfilter: (b) => { NOTE.filter = b.dataset.v; NOTE.sel = null; renderNotes() },
  nrow: (b) => { NOTE.sel = b.dataset.v; renderNotes() },
  'read-all': () => { store.set(readKey(), myNotes().map((n) => n.id).join(',')); renderNotes(); badge() },
  // profile page
  'copy-me': () => { navigator.clipboard?.writeText(S.me); toast('Address copied.', 'ok') },
  'pick-ava': () => {
    const k = 'pave-ava-' + S.me.toLowerCase()
    store.set(k, String(((Number(store.get(k) ?? parseInt(S.me.slice(2, 10), 16) % AVATARS)) + 1) % AVATARS))
    renderApp()
    $$('[data-me-ava]').forEach((i) => { i.src = avaOf(S.me) })
  },
  'set-notify': () => openNotifyPrefs(),
  'set-approvals': () => openApprovals().catch((e) => toast(explain(e), 'err')),
  'set-network': () => openNetwork(),
  revoke: (b) => act('Revoke approval', () => send('Revoke approval', 'approve', [S.dep.Pave, 0n], b.dataset.v, S.abis.Token), { then: 'profile' }).then(() => closeSheet()),
  'demo-next': () => useDemo(S.demo ? (S.demoIndex + 1) % DEMO.length : 0),
  tour: () => {
    $('#map').scrollIntoView({ behavior: calm() ? 'auto' : 'smooth', block: 'center' })
    setTimeout(() => showSpot(0), calm() ? 0 : 700)
  },
  'start-vouch': () => {
    const who = val('pick-for')?.trim()
    if (who && !isAddress(who)) { toast("That isn't a wallet address. It starts with 0x and has 42 characters.", 'err'); return }
    openVouch(who)
  },
  'eth-local': () => act('Local ETH', () => fundLocal(S.me)),
  copy: (b) => { navigator.clipboard?.writeText(b.dataset.text); toast('Link copied.', 'ok') },
  'borrow-max': () => { const i = $('[data-in="borrow"]'); if (i && S.mine?.credit) i.value = (Number(S.mine.credit.available) / 1e6).toFixed(2); renderBorrow() },
  borrow: () => {
    const amt = toUnits(val('borrow'), 6)
    return act('Borrow', async () => {
      if (!amt) throw new Error('Enter an amount in USDG.')
      if (S.mine.credit && amt > S.mine.credit.available) throw new Error(`Your road can borrow up to ${usd(S.mine.credit.available)} right now.`)
      await send('Borrow', 'borrow', [amt])
      $('[data-in="borrow"]').value = ''
    }, { amount: amt ? usd(amt) + ' USDG' : '', then: 'road' })
  },
  repay: () => {
    const l = S.mine.loan
    return act('Repay', async () => {
      if (l[0] === 0n) throw new Error('There is no open loan to repay.')
      const short = l[0] + l[1] - S.mine.usdgBal
      if (short > 0n) throw new Error(`You need ${usd(short)} more USDG to repay ${usd(l[0] + l[1])} (the loan plus its fee).`)
      await allow(S.dep.usdg, l[0] + l[1], 'USDG')
      await send('Repay', 'repay', [S.me])
    }, { amount: usd(l[0] + l[1]) + ' USDG', then: 'road' })
  },
  return: (b) => act('Return vouch', () => send('Return vouch', 'returnVouch', [b.dataset.v]), { amount: short(b.dataset.v), then: 'road' }).then(() => closeSheet()),
  vouch: () => {
    const amt = toUnits(val('vouch-amt')?.replace(/,/g, ''), 18)
    return act('Vouch', async () => {
      const who = val('vouch-for')?.trim()
      if (!who || !isAddress(who)) throw new Error('Enter the wallet address of the person you are vouching for.')
      if (same(who, S.me)) throw new Error(ERRORS.SelfVouch)
      if (!amt) throw new Error('Enter how much $WIF to lock.')
      if (amt > S.mine.wifBal) throw new Error(`You hold ${wifWhole(S.mine.wifBal)} $WIF.`)
      S.vouchFor = getAddress(who)
      await allow(S.dep.wif, amt, '$WIF')
      await send('Vouch', 'vouch', [getAddress(who), amt])
      $('[data-in="vouch-amt"]').value = ''
    }, { amount: amt ? wifWhole(amt) + ' $WIF' : '', then: 'vouch' })
  },
  unvouch: (b) => act('Take back', () => send('Take back', 'unvouch', [b.dataset.b]), { amount: short(b.dataset.b), then: 'vouch' }).then(() => closeSheet()),
  'claim-rewards': () => act('Claim rewards', () => send('Claim rewards', 'claimRewards'), { amount: S.mine ? usd(S.mine.rewards) + ' USDG' : '', then: 'vouch' }),
  default: (b) => act('End loan', () => send('End loan', 'markDefault', [b.dataset.b]), { amount: short(b.dataset.b), then: 'notifications' }),
  deposit: () => {
    const amt = toUnits(val('lend-amt')?.replace(/,/g, ''), 6)
    return act('Deposit', async () => {
      if (!amt) throw new Error('Enter an amount in USDG.')
      if (amt > S.mine.usdgBal) throw new Error(`You hold ${usd(S.mine.usdgBal)} USDG.`)
      await allow(S.dep.usdg, amt, 'USDG')
      await send('Deposit', 'deposit', [amt])
      $('[data-in="lend-amt"]').value = ''
    }, { amount: amt ? usd(amt) + ' USDG' : '', then: 'lend' })
  },
  // Withdraw everything that can come out now (what isn't lent out).
  withdraw: () => {
    const m = S.mine, p = S.pool
    const assets = p.idle + p.outstanding
    let shares = assets ? (p.idle * p.totalShares) / assets : 0n
    if (shares > m.shares) shares = m.shares
    return act('Withdraw', async () => {
      if (shares === 0n) throw new Error('Nothing to withdraw right now.')
      await send('Withdraw', 'withdraw', [shares])
    }, { amount: usd(m.shareValue < p.idle ? m.shareValue : p.idle) + ' USDG', then: 'lend' })
  },
  'claim-wif': () => act('Collect $WIF', () => send('Collect $WIF', 'claimWif'), { amount: S.mine ? wifWhole(S.mine.pendingWif) + ' $WIF' : '', then: 'lend' }),
  poke: () => act('Record price', () => send('Record price', 'poke')),
  'mint-wif': () => act('Test $WIF', () => send('Test $WIF', 'mint', [S.me, 1_000_000n * 10n ** 18n], S.dep.wif, S.abis.Token)),
  'mint-usdg': () => act('Test USDG', () => send('Test USDG', 'mint', [S.me, 500_000_000n], S.dep.usdg, S.abis.Token)),
  'price-up': () => act('Price ×2', () => movePrice(2, 1)),
  'price-down': () => act('Price ÷2', () => movePrice(1, 2)),
}

/// Testnet: move the pool's price. $WIF ×2 means half as many $WIF per ETH, so sqrt ÷ √2.
async function movePrice(num, den) {
  const s = await read('sqrtPriceX96', [], S.dep.stateView, S.abis.StateView)
  // sqrt(den/num) as a ratio, to 6 places
  const k = BigInt(Math.round(Math.sqrt(den / num) * 1e6))
  await send('Move price', 'set', [(s * k) / 1_000_000n], S.dep.stateView, S.abis.StateView)
}

// ------------------------------------------------------------------ boot

async function boot() {
  const nets = await (await fetch('deployments/index.json')).json()
  const asked = new URLSearchParams(location.search).get('net')
  const pick = asked && nets.includes(asked) ? asked
    : nets.includes('robinhood') ? 'robinhood' : nets.includes('robinhood-testnet') ? 'robinhood-testnet' : nets[0]
  if (!pick) {
    // No contract to talk to: the page stays readable, and every wallet button says why it can't go further.
    const say = () => toast('Pave isn’t live on this site yet: its contract hasn’t been deployed to Robinhood Chain. Try again soon.', 'err')
    document.addEventListener('click', (e) => { if (e.target.closest('[data-act], a[href^="#/"]')) { e.preventDefault(); say() } }, true)
    say()
    return
  }
  S.dep = await (await fetch(`deployments/${pick}.json`)).json()
  S.abis = await (await fetch('abi.json')).json()
  S.chain = defineChain({
    id: S.dep.chainId, name: S.dep.network, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [S.dep.rpc] } },
  })
  S.pub = createPublicClient({ chain: S.chain, transport: http(S.dep.rpc) })
  $$('[data-net]').forEach((net) => {
    net.textContent = S.dep.network
    if (S.dep.testTokens) net.parentElement.classList.add('net--test')
  })
  $$('[data-net-name]').forEach((el) => { el.textContent = S.dep.network })

  const names = ['minVouch', 'vouchMaturity', 'loanTerm', 'grace', 'feeBps', 'voucherShareBps', 'markPeriod', 'cap0', 'cap1', 'cap2', 'cap3', 'ltvBps']
  const vals = await Promise.all(names.map((n) => read(n)))
  names.forEach((n, i) => { S.params[n] = vals[i] })
  for (let i = 0; i < 4; i++) { const el = $(`[data-cap="${i}"]`); if (el) el.textContent = String(Number(S.params['cap' + i]) / 1e6) }
  const links = Object.entries(LINKS).filter(([, u]) => u).map(([k, u]) => `<a href="${u}" target="_blank" rel="noopener">${k}</a>`)
  if (S.dep.explorer) links.unshift(`Contract <a href="${S.dep.explorer}/address/${S.dep.Pave}" target="_blank" rel="noopener">${short(S.dep.Pave)}</a> on ${S.dep.network}`)
  $('[data-links]').innerHTML = links.join(' · ')

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]')
    if (b && ACTIONS[b.dataset.act]) { e.preventDefault(); ACTIONS[b.dataset.act](b) }
    const pick = e.target.closest('[data-wallet-pick]')
    if (pick) pickWallet(pick.dataset.walletPick)
    const go = e.target.closest('[data-txm-go]')?.dataset.txmGo
    if (go === 'continue') TX.close(TX.opts.then)
    if (go === 'home') TX.close('road')
    if (go === 'retry') { TX.close(); TX.retry?.() }
    if (!e.target.closest('[data-wallet]')) hideMenu()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset?.in === 'pick-for') ACTIONS['start-vouch']()
    if (e.key === 'Escape') { hideMenu(); closeSheet(); if ($('[data-txm]').dataset.state !== 'wait') TX.close() }
  })
  document.addEventListener('input', (e) => {
    const k = e.target.dataset?.in
    if (k === 'vouch-for') {
      const v = e.target.value.trim()
      if (isAddress(v)) { S.vouchFor = getAddress(v); render() }
    }
    if (k === 'borrow') renderBorrow()
    if (k === 'vouch-amt' || (k === 'vouch-for' && VIEW.page === 'vouch')) renderVouch()
    if (k === 'arange') { ACT.page = 0; renderActivity() }
    if (e.target.dataset?.pref) {
      const off = offCats()
      if (e.target.checked) off.delete(e.target.dataset.pref); else off.add(e.target.dataset.pref)
      store.set('pave-notify-off', [...off].join(','))
      badge()
    }
  })
  addEventListener('hashchange', route)

  const forAddr = new URLSearchParams(location.search).get('for')
  if (forAddr && isAddress(forAddr)) { S.vouchFor = getAddress(forAddr); if (!location.hash) location.hash = '#/vouch' }
  spy()
  reveal()
  setupTour()
  route()

  // Reconnect silently: the demo person from last time (local chain), or a wallet that already trusts this site.
  const lastDemo = store.get('pave-demo-on')
  if (isLocal() && lastDemo && !window.ethereum) await useDemo(Number(lastDemo)).catch(() => {})
  else try {
    const rdns = store.get('pave-wallet')
    const eth = (rdns && WALLETS.get(rdns)?.provider) || window.ethereum
    const accts = await eth?.request({ method: 'eth_accounts' })
    if (accts?.length) await connect(eth, rdns ?? '')
  } catch { /* no wallet */ }

  await refresh()
  route()
  await findOverdue().then(render).catch(() => {})
  setInterval(async () => { await refresh(); await findOverdue().then(render).catch(() => {}) }, 15_000)
}

boot().catch((e) => { console.error(e); toast('Could not start: ' + explain(e), 'err') })
