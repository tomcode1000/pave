import {
  createPublicClient, createWalletClient, custom, http, defineChain, isAddress, getAddress,
  BaseError, ContractFunctionRevertedError, UserRejectedRequestError,
} from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'

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
  const hash = await S.wallet.writeContract(request)
  toast(`${label}: waiting for the chain…`)
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

async function act(label, fn) {
  if (S.busy) return
  S.busy = true
  $$('[data-act]').forEach((b) => { b.disabled = true })
  try {
    await fn()
    toast(`${label}: done.`, 'ok')
  } catch (e) {
    toast(explain(e), 'err')
  } finally {
    S.busy = false
    // Re-enable everything (the panels are redrawn next, with their own disabled states; the
    // bar's buttons are not redrawn, so they must be switched back on here).
    $$('[data-act]').forEach((b) => { b.disabled = false })
    await refresh()
    await findOverdue().then(render).catch(() => {})
  }
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
  const eth = window.ethereum
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

async function connect() {
  const eth = window.ethereum
  if (!eth) {
    if (isLocal()) return useDemo(0)
    toast('No wallet found. Install MetaMask or Rabby, then reload.', 'err')
    return
  }
  try {
    const [a] = await eth.request({ method: 'eth_requestAccounts' })
    S.me = getAddress(a)
    S.demo = false
    S.wallet = createWalletClient({ chain: S.chain, transport: custom(eth), account: S.me })
    await ensureChain()
    eth.removeAllListeners?.('accountsChanged')
    eth.on?.('accountsChanged', (list) => {
      S.me = list?.[0] ? getAddress(list[0]) : null
      S.wallet = S.me ? createWalletClient({ chain: S.chain, transport: custom(eth), account: S.me }) : null
      refresh()
    })
    eth.on?.('chainChanged', () => refresh())
    await refresh()
  } catch (e) {
    toast(explain(e), 'err')
  }
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

function roadPanel() {
  if (!S.me) {
    return `<div class="card"><h3>Your road starts with a link</h3>
      <p class="sub">Connect a wallet to see your road, ask friends to vouch for you, and borrow once their $WIF has matured.</p>
      <button class="btn" data-act="connect">Connect wallet</button></div>`
  }
  const m = S.mine, c = m.credit, path = m.path, loan = m.loan
  const repaid = Number(path.repaid), lv = level(repaid)
  const open = loan[0] > 0n
  let tiles = ''
  for (let i = 1; i <= repaid; i++) tiles += `<span class="tile tile--${path.defaulted ? 'x' : level(i)}" title="Loan ${i} repaid"></span>`
  tiles += open ? '<span class="tile tile--open" title="Loan open"></span>' : ''
  tiles += path.defaulted ? '' : '<span class="tile tile--next" title="Next stretch"></span>'
  const nextAt = NEXT_AT.find((n) => n > repaid)
  const toNext = nextAt ? `${nextAt - repaid} more repaid to reach ${LEVELS[level(nextAt)]}` : 'Top level'
  const link = shareLink(S.me)
  const tweet = `I'm paving my own road on Robinhood Chain. Vouch for me with $WIF and earn when I repay. @WIFonRH`
  const owed = loan[0] + loan[1]
  const due = loan[2]
  const graceEnd = due + BigInt(S.params.grace ?? 0n)

  let action = ''
  if (path.defaulted) {
    action = `<p class="note note--warn">This road cracked: a loan was not repaid and the vouches were cut. This wallet can't borrow again.</p>`
  } else if (open) {
    const late = now() > due
    const need = owed - m.usdgBal
    action = `<div class="row"><button class="btn" data-act="repay">Repay ${usd(owed)}</button>
      ${need > 0n ? `<span class="note note--warn">You hold ${usd(m.usdgBal)}: ${usd(need)} more USDG needed.</span>` : ''}
      <span class="note">${late ? `Overdue since ${dur(due - now()).replace(' ago', '')}. Repay before anyone ends it ${dur(graceEnd - now())}.` : `Due ${dur(due - now())}. On time keeps your streak.`}</span></div>`
  } else if (!c) {
    action = `<p class="note note--warn">${ERRORS.StalePrice}</p>`
  } else {
    action = `<label class="lbl" for="borrow-amt">Borrow USDG</label>
      <div class="field"><input id="borrow-amt" inputmode="decimal" placeholder="${(Number(c.available) / 1e6).toFixed(2)}" data-in="borrow">
      <button class="btn btn--ghost btn--small" data-act="borrow-max">Max</button>
      <button class="btn" data-act="borrow"${c.available > 0n ? '' : ' disabled'}>Borrow</button></div>
      <p class="note">You repay the amount plus ${Number(S.params.feeBps ?? 300n) / 100}% within ${dur(BigInt(S.params.loanTerm ?? 0n)).replace('in ', '')}. ${c.available > 0n ? '' : c.vouchers ? 'Your stones are still maturing, or the pool is empty.' : 'You need someone to vouch for you first.'}</p>`
  }

  const stones = m.vouches.length
    ? m.vouches.map((v) => {
        const ripe = now() >= BigInt(v.since) + BigInt(S.params.vouchMaturity ?? 0n)
        return `<span class="stone"><i style="${dot(v.voucher)}"></i>${short(v.voucher)} <b>${wifFmt(v.amount)}</b> <small>${ripe ? 'counts' : 'matures ' + dur(BigInt(v.since) + BigInt(S.params.vouchMaturity ?? 0n) - now())}</small>
          ${open ? '' : `<button class="btn btn--ghost btn--small" data-act="return" data-v="${v.voucher}" title="Hand this vouch back">Return</button>`}</span>`
      }).join('')
    : '<p class="note">No stones yet. Share your link below.</p>'

  return `<div class="card">
      <div class="row" style="justify-content: space-between; align-items: baseline">
        <div><p class="lbl">Your road</p><p class="levelname">${path.defaulted ? 'Cracked' : LEVELS[lv]}</p></div>
        <span class="note">${path.defaulted ? '' : toNext}</span>
      </div>
      <div class="strip-road" aria-label="${repaid} loans repaid">${tiles}</div>
      <dl class="kv">
        <div><dt>Can borrow now</dt><dd>${c ? usd(c.available) : '—'}</dd></div>
        <div><dt>Road limit</dt><dd>${c ? usd(c.levelCap) : '—'}</dd></div>
        <div><dt>Stones count for</dt><dd>${c ? usd(c.matureUsdg) : '—'}</dd></div>
        <div><dt>Stones</dt><dd>${m.vouches.length} · ${wifFmt(c ? c.vouchedWif : m.vouches.reduce((s, v) => s + v.amount, 0n))}</dd></div>
        <div><dt>Repaid</dt><dd>${repaid}${Number(path.late) ? ` (${Number(path.late)} late)` : ''}</dd></div>
        <div><dt>Streak</dt><dd>${Number(path.streak)}</dd></div>
      </dl>
      ${action}
    </div>
    <div class="grid2">
      <div class="card"><h3>Stones in your road</h3><p class="sub">The people whose $WIF is behind you. They earn part of the fee each time you repay.</p><div class="stones">${stones}</div></div>
      ${path.defaulted ? `<div class="card"><h3>This road is closed</h3><p class="sub">Your vouchers can take back what is left of their stones from the Vouch tab.</p></div>` : `<div class="card"><h3>Ask for vouches</h3><p class="sub">Send this to people who believe in you. Their $WIF stays theirs unless you don't repay.</p>
        <div class="share"><code>${link}</code><button class="btn btn--ghost btn--small" data-act="copy" data-text="${link}">Copy</button>
        <a class="btn btn--small" target="_blank" rel="noopener" href="https://x.com/intent/post?text=${encodeURIComponent(tweet)}&url=${encodeURIComponent(link)}">Post on X</a></div></div>`}
    </div>`
}

function vouchPanel() {
  const target = S.vouchFor
  const r = target ? S.model.roads.get(target.toLowerCase()) : null
  const minV = S.params.minVouch ?? 0n
  let about = ''
  if (target) {
    let total = 0n
    if (r) for (const v of r.vouches.values()) total += v.amount
    about = `<p class="note">${short(target)}: ${r?.defaulted ? 'cracked road (defaulted)' : LEVELS[level(r?.repaid ?? 0)]}, ${r?.repaid ?? 0} repaid, ${r?.vouches.size ?? 0} stones (${wifFmt(total)} $WIF)${r?.open ? ', loan open: a new vouch is at risk at once' : ''}.</p>`
  }
  const mine = []
  if (S.me) {
    for (const road of S.model.roads.values()) {
      const v = road.vouches.get(S.me.toLowerCase())
      if (v) mine.push({ road, amount: v.amount })
    }
  }
  const myStones = mine.length
    ? `<div class="board-wrap"><table class="board"><thead><tr><th>Road</th><th>Level</th><th class="num">Your $WIF</th><th></th></tr></thead><tbody>${mine.map(({ road, amount }) => `
        <tr><td class="addr">${short(road.addr)}</td><td>${road.defaulted ? 'Cracked' : LEVELS[level(road.repaid)]}${road.open ? ' · loan open' : ''}</td><td class="num">${wifFmt(amount)}</td>
        <td class="num"><button class="btn btn--ghost btn--small" data-act="unvouch" data-b="${road.addr}"${road.open ? ' disabled title="Frozen while a loan is open"' : ''}>Take back</button></td></tr>`).join('')}</tbody></table></div>`
    : '<p class="note">You have no stones in anyone\'s road yet.</p>'

  // Loans past their grace period: anyone can end them.
  const overdue = (S.overdue ?? []).map((o) => `<tr><td class="addr">${short(o.addr)}</td><td>${usd(o.owed)}</td><td>${dur(o.graceEnd - now())}</td>
      <td class="num"><button class="btn btn--danger btn--small" data-act="default" data-b="${o.addr}">End loan</button></td></tr>`).join('')

  return `<div class="grid2">
      <div class="card"><h3>Lay a stone</h3><p class="sub">Lock $WIF behind someone. It counts for their credit after ${dur(BigInt(S.params.vouchMaturity ?? 0n)).replace('in ', '')}. You earn ${Number(S.params.voucherShareBps ?? 3000n) / 100}% of each fee they repay. If they don't repay, up to twice their debt in $WIF is cut from the stones.</p>
        <label class="lbl" for="vouch-for">Whose road</label>
        <div class="field"><input id="vouch-for" placeholder="0x…" value="${target ?? ''}" data-in="vouch-for"></div>
        ${about}
        <label class="lbl" for="vouch-amt" style="margin-top: 12px">$WIF</label>
        <div class="field"><input id="vouch-amt" inputmode="decimal" placeholder="at least ${wifFmt(minV)}" data-in="vouch-amt">
        <button class="btn" data-act="vouch">Vouch</button></div>
        ${S.mine ? `<p class="note">You hold ${wifFmt(S.mine.wifBal)} $WIF.</p>` : ''}
      </div>
      <div class="card"><h3>Your stones</h3><p class="sub">You can take a stone back whenever that road has no open loan.</p>${myStones}
        ${S.mine && S.mine.rewards > 0n ? `<div class="row" style="margin-top: 12px"><button class="btn" data-act="claim-rewards">Collect ${usd(S.mine.rewards)}</button><span class="note">your share of repaid fees</span></div>` : ''}
      </div>
    </div>
    ${overdue ? `<div class="card"><h3>Loans past their grace period</h3><p class="sub">Anyone can end these. The stones are cut: the lenders get one debt's worth of $WIF and the rest is burned.</p>
      <div class="board-wrap"><table class="board"><thead><tr><th>Road</th><th>Owed</th><th>Grace ended</th><th></th></tr></thead><tbody>${overdue}</tbody></table></div></div>` : ''}`
}

function lendPanel() {
  const p = S.pool
  const m = S.mine
  return `<div class="grid2">
      <div class="card"><h3>The pool</h3><p class="sub">Lenders share the fees (${100 - Number(S.params.voucherShareBps ?? 3000n) / 100}% of each). When a loan isn't repaid, they get the $WIF cut from that road's stones.</p>
        <dl class="kv"><div><dt>Free to lend</dt><dd>${usd(p.idle)}</dd></div><div><dt>Lent out</dt><dd>${usd(p.outstanding)}</dd></div></dl>
        <p class="note">You can withdraw from what isn't lent out right now.</p></div>
      <div class="card"><h3>Your lending</h3>
        ${m ? `<dl class="kv"><div><dt>Your share</dt><dd>${usd(m.shareValue)}</dd></div><div><dt>$WIF from defaults</dt><dd>${wifFmt(m.pendingWif)}</dd></div><div><dt>Your USDG</dt><dd>${usd(m.usdgBal)}</dd></div></dl>
        <label class="lbl" for="lend-amt">USDG</label>
        <div class="field"><input id="lend-amt" inputmode="decimal" placeholder="10.00" data-in="lend-amt">
        <button class="btn" data-act="deposit">Lend</button><button class="btn btn--ghost" data-act="withdraw"${m.shares > 0n ? '' : ' disabled'}>Withdraw</button></div>
        ${m.pendingWif > 0n ? `<div class="row" style="margin-top: 12px"><button class="btn btn--ghost" data-act="claim-wif">Collect ${wifFmt(m.pendingWif)} $WIF</button></div>` : ''}`
        : '<p class="sub">Connect a wallet to lend.</p><button class="btn" data-act="connect">Connect wallet</button>'}
      </div>
    </div>`
}

function believersPanel() {
  const roads = S.model.roads
  const rows = [...S.model.believers.values()]
    .filter((b) => b.backed.size)
    .map((b) => {
      const badges = []
      for (const k of b.firsts) if ((roads.get(k)?.reached ?? 0) >= 3) { badges.push('First Stone'); break }
      if (b.repaidBacked >= 3 && b.slashed === 0) badges.push('Never wrong')
      if (b.backed.size >= 5) badges.push('Road builder')
      return { ...b, badges, score: b.repaidBacked * 10 + b.backed.size - b.slashed * 15 }
    })
    .sort((a, b) => b.score - a.score || b.backed.size - a.backed.size)
  const body = rows.length
    ? rows.map((b, i) => `<tr${same(b.addr, S.me) ? ' class="me"' : ''}><td>${i + 1}</td><td><span class="addr-mono">${short(b.addr)}</span>${b.badges.map((x) => `<span class="badge">${x}</span>`).join('')}</td>
        <td class="num">${b.backed.size}</td><td class="num">${b.repaidBacked}</td><td class="num">${b.slashed}</td><td class="num">${usd(b.earned)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="note">No believers yet.</td></tr>'
  return `<div class="card"><h3>Believers</h3><p class="sub">The people best at spotting who will repay. Ranked by loans repaid by people they backed, not by how much they hold.
      <br><b>First Stone</b>: the first to vouch for someone who reached Highway. <b>Never wrong</b>: 3+ repaid, none defaulted.</p>
      <div class="board-wrap"><table class="board"><thead><tr><th>#</th><th>Believer</th><th class="num">People backed</th><th class="num">Loans repaid</th><th class="num">Defaults</th><th class="num">Earned</th></tr></thead><tbody>${body}</tbody></table></div></div>`
}

function testPanel() {
  if (!S.dep.testTokens) return ''
  const m = S.mine
  return `<div class="card"><h3>Test tools (${S.dep.network} only)</h3><p class="sub">Free test tokens, and a pool price you can move to see how credit reacts. None of this exists on mainnet.</p>
    <div class="row">
      <button class="btn btn--ghost btn--small" data-act="mint-wif">Get 1M test $WIF</button>
      <button class="btn btn--ghost btn--small" data-act="mint-usdg">Get 500 test USDG</button>
      <button class="btn btn--ghost btn--small" data-act="price-up">$WIF ×2</button>
      <button class="btn btn--ghost btn--small" data-act="price-down">$WIF ÷2</button>
      <button class="btn btn--ghost btn--small" data-act="poke">Record price</button>
      ${isLocal() ? '<button class="btn btn--ghost btn--small" data-act="eth-local">Get 100 local ETH</button>' : ''}
      ${isLocal() ? `<button class="btn btn--small" data-act="demo-next">${S.demo ? `Person ${DEMO[S.demoIndex]} → ${DEMO[(S.demoIndex + 1) % 4]}` : 'Demo person A'}</button>` : ''}
    </div>
    ${isLocal() ? `<p class="note">Demo people: you are ${S.demo ? `person <b>${DEMO[S.demoIndex]}</b>` : 'using your own wallet'}. Switch with the gold button to play the borrower and the friends.</p>` : ''}
    <p class="note">${m ? `You hold ${wifFmt(m.wifBal)} test $WIF, ${usd(m.usdgBal)} test USDG and ${(Number(m.eth) / 1e18).toFixed(4)} testnet ETH for gas.` : 'Connect a wallet to use these.'} Price marks here last ${S.params.markPeriod ?? '?'}s, loans ${dur(BigInt(S.params.loanTerm ?? 0n)).replace('in ', '')}.</p></div>`
}

function render() {
  const m = S.model
  const k = (key, v) => { const el = $(`[data-k="${key}"]`); if (el) el.textContent = v }
  k('pool', usd(S.pool.idle + S.pool.outstanding))
  k('out', usd(S.pool.outstanding))
  k('roads', String(m.shown.length))
  k('vouched', wifFmt(m.vouched))
  k('burned', wifFmt(m.burned))
  k('price', S.prices ? usd(S.prices[3]) : 'paused')
  $('[data-connect]').textContent = S.me ? short(S.me) : isLocal() && !window.ethereum ? 'Use demo wallet' : 'Connect Wallet'
  renderProfile()
  renderRewards()
  // Keep what someone is typing when the panels refresh.
  const typed = Object.fromEntries($$('[data-in]').map((i) => [i.dataset.in, i.value]))
  const focus = document.activeElement?.dataset?.in
  $('[data-panel="road"]').innerHTML = roadPanel()
  $('[data-panel="vouch"]').innerHTML = vouchPanel()
  $('[data-panel="lend"]').innerHTML = lendPanel()
  $('[data-panel="believers"]').innerHTML = believersPanel()
  const t = $('[data-test]')
  t.innerHTML = testPanel()
  t.hidden = !S.dep.testTokens
  for (const [key, v] of Object.entries(typed)) { const i = $(`[data-in="${key}"]`); if (i && v) i.value = v }
  if (focus) $(`[data-in="${focus}"]`)?.focus()
}

/// The vouch form, filled in for someone.
function openVouch(addr, smooth = true) {
  if (addr && isAddress(addr)) S.vouchFor = getAddress(addr)
  render()
  $('#vouch-form').scrollIntoView({ behavior: smooth ? 'smooth' : 'auto', block: 'start' })
  $('[data-in="vouch-amt"]')?.focus({ preventScroll: true })
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
  connect: () => (S.me ? null : connect()),
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
  'borrow-max': () => { const i = $('[data-in="borrow"]'); if (i && S.mine?.credit) i.value = (Number(S.mine.credit.available) / 1e6).toFixed(2) },
  borrow: () => act('Borrow', async () => {
    const amt = toUnits(val('borrow') || (Number(S.mine.credit.available) / 1e6).toFixed(6), 6)
    if (!amt) throw new Error('Enter an amount in USDG.')
    await send('Borrow', 'borrow', [amt])
  }),
  repay: () => act('Repay', async () => {
    const l = S.mine.loan
    const short = l[0] + l[1] - S.mine.usdgBal
    if (short > 0n) throw new Error(`You need ${usd(short)} more USDG to repay ${usd(l[0] + l[1])} (the loan plus its fee).`)
    await allow(S.dep.usdg, l[0] + l[1], 'USDG')
    await send('Repay', 'repay', [S.me])
  }),
  return: (b) => act('Return vouch', () => send('Return vouch', 'returnVouch', [b.dataset.v])),
  vouch: () => act('Vouch', async () => {
    const who = val('vouch-for')?.trim()
    if (!who || !isAddress(who)) throw new Error('Enter the wallet address of the person you are vouching for.')
    const amt = toUnits(val('vouch-amt'), 18)
    if (!amt) throw new Error('Enter how much $WIF to lock.')
    S.vouchFor = getAddress(who)
    await allow(S.dep.wif, amt, '$WIF')
    await send('Vouch', 'vouch', [getAddress(who), amt])
  }),
  unvouch: (b) => act('Take back', () => send('Take back', 'unvouch', [b.dataset.b])),
  'claim-rewards': () => act('Collect', () => send('Collect', 'claimRewards')),
  default: (b) => act('End loan', () => send('End loan', 'markDefault', [b.dataset.b])),
  deposit: () => act('Lend', async () => {
    const amt = toUnits(val('lend-amt'), 6)
    if (!amt) throw new Error('Enter an amount in USDG.')
    await allow(S.dep.usdg, amt, 'USDG')
    await send('Lend', 'deposit', [amt])
  }),
  withdraw: () => act('Withdraw', async () => {
    const m = S.mine, p = S.pool
    const assets = p.idle + p.outstanding
    const typed = toUnits(val('lend-amt'), 6)
    // Shares for the typed amount, or as much as can come out now.
    let shares = typed ? (typed * p.totalShares) / assets : (p.idle * p.totalShares) / assets
    if (shares > m.shares) shares = m.shares
    if (shares === 0n) throw new Error('Nothing to withdraw right now.')
    await send('Withdraw', 'withdraw', [shares])
  }),
  'claim-wif': () => act('Collect $WIF', () => send('Collect $WIF', 'claimWif')),
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
  if (!pick) { document.querySelector('main').innerHTML = '<p class="note" style="padding: 40px 0">Pave is not deployed yet.</p>'; return }
  S.dep = await (await fetch(`deployments/${pick}.json`)).json()
  S.abis = await (await fetch('abi.json')).json()
  S.chain = defineChain({
    id: S.dep.chainId, name: S.dep.network, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [S.dep.rpc] } },
  })
  S.pub = createPublicClient({ chain: S.chain, transport: http(S.dep.rpc) })
  const net = $('[data-net]')
  net.textContent = S.dep.network
  if (S.dep.testTokens) net.classList.add('net--test')

  const names = ['minVouch', 'vouchMaturity', 'loanTerm', 'grace', 'feeBps', 'voucherShareBps', 'markPeriod', 'cap0', 'cap1', 'cap2', 'cap3']
  const vals = await Promise.all(names.map((n) => read(n)))
  names.forEach((n, i) => { S.params[n] = vals[i] })
  for (let i = 0; i < 4; i++) { const el = $(`[data-cap="${i}"]`); if (el) el.textContent = String(Number(S.params['cap' + i]) / 1e6) }
  const links = Object.entries(LINKS).filter(([, u]) => u).map(([k, u]) => `<a href="${u}" target="_blank" rel="noopener">${k}</a>`)
  if (S.dep.explorer) links.unshift(`Contract <a href="${S.dep.explorer}/address/${S.dep.Pave}" target="_blank" rel="noopener">${short(S.dep.Pave)}</a> on ${S.dep.network}`)
  $('[data-links]').innerHTML = links.join(' · ')

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]')
    if (b && ACTIONS[b.dataset.act]) { e.preventDefault(); ACTIONS[b.dataset.act](b) }
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.dataset?.in === 'pick-for') ACTIONS['start-vouch']()
  })
  document.addEventListener('input', (e) => {
    if (e.target.dataset?.in === 'vouch-for') {
      const v = e.target.value.trim()
      if (isAddress(v)) { S.vouchFor = getAddress(v); render() }
    }
  })

  const forAddr = new URLSearchParams(location.search).get('for')
  if (forAddr && isAddress(forAddr)) S.vouchFor = getAddress(forAddr)
  spy()
  reveal()
  setupTour()

  // Reconnect silently: the demo person from last time (local chain), or a wallet that already trusts this site.
  const lastDemo = store.get('pave-demo-on')
  if (isLocal() && lastDemo != null && !window.ethereum) await useDemo(Number(lastDemo)).catch(() => {})
  else try {
    const accts = await window.ethereum?.request({ method: 'eth_accounts' })
    if (accts?.length) await connect()
  } catch { /* no wallet */ }

  await refresh()
  if (S.vouchFor) openVouch(null, false)
  await findOverdue().then(render).catch(() => {})
  setInterval(async () => { await refresh(); await findOverdue().then(render).catch(() => {}) }, 15_000)
}

boot().catch((e) => { console.error(e); toast('Could not start: ' + explain(e), 'err') })
