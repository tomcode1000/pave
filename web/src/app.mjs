import {
  createPublicClient, createWalletClient, custom, http, defineChain, isAddress, getAddress,
  BaseError, ContractFunctionRevertedError, UserRejectedRequestError,
} from 'viem'

/*
  The Pave site. Everything is read from the chain: the contract's views for numbers, and its
  events for the map, the stones and the Believers board. Nothing in the page holds a key; every
  action is signed in the wallet the visitor connects, after a simulation that turns a revert
  into a plain sentence.
*/

const $ = (s, el = document) => el.querySelector(s)
const $$ = (s, el = document) => [...el.querySelectorAll(s)]
const LEVELS = ['Dirt path', 'Gravel', 'Cobblestone', 'Highway']
const NEXT_AT = [1, 3, 6] // loans repaid to reach gravel, cobblestone, highway
const ROAD_COLORS = ['#8b6b4a', '#a7a69b', '#d2b77a', '#f4f3ea']
const MAX = 2n ** 256n - 1n

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
  tab: 'road', busy: false,
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
  const { request } = await S.pub.simulateContract({ address, abi, functionName, args, account: S.me })
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
    await refresh()
    await findOverdue().then(render).catch(() => {})
  }
}

async function ensureChain() {
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
  if (!eth) { toast('No wallet found. Install MetaMask or Rabby, then reload.', 'err'); return }
  try {
    const [a] = await eth.request({ method: 'eth_requestAccounts' })
    S.me = getAddress(a)
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
      S.mine = { credit, path, loan, vouches, shares, shareValue, pendingWif, rewards, wifBal, usdgBal, eth }
    } else {
      S.mine = null
    }
    render()
  } catch (e) {
    console.error(e)
    toast('Could not read the chain: ' + explain(e), 'err')
  }
}

// ------------------------------------------------------------------ the map

function renderMap() {
  const W = 1000, H = 460
  const roads = S.model.shown
  const box = $('[data-map]')
  // Latitude and longitude lines on a flat world.
  let grid = ''
  for (let y = -460; y < H + 460; y += 30) grid += `<path d="M-1000 ${y} H${W + 1000}" stroke="#ffffff" stroke-opacity="${y % 90 ? '.02' : '.045'}"/>`
  for (let x = -1000; x < W + 1000; x += 30) grid += `<path d="M${x} -460 V${H + 460}" stroke="#ffffff" stroke-opacity="${x % 90 ? '.02' : '.045'}"/>`
  grid += `<ellipse cx="${W / 2}" cy="${H / 2}" rx="${W * 0.46}" ry="${H * 0.42}" fill="none" stroke="#c8f25a" stroke-opacity=".08" stroke-dasharray="2 8"/>`
  const pts = []

  // Place roads on a spiral from the centre, in the order they first appeared: a few roads sit
  // together in the middle, and the map grows outward as more people join. Positions never move.
  const cw = 170
  const spots = new Map()
  roads.forEach((r, i) => {
    const h = parseInt(r.addr.slice(2, 10), 16)
    const t = i * 2.39996 // golden angle
    const rad = 95 * Math.sqrt(i)
    spots.set(r.addr.toLowerCase(), { x: W / 2 - 40 + Math.cos(t) * rad * 1.7, y: H / 2 + Math.sin(t) * rad, h })
  })

  // Connections: two people who back each other.
  let links = ''
  const seen = new Set()
  for (const r of roads) {
    for (const v of r.vouches.values()) {
      const other = S.model.roads.get(v.addr.toLowerCase())
      if (!other || !other.vouches.has(r.addr.toLowerCase())) continue
      const key = [r.addr, v.addr].map((x) => x.toLowerCase()).sort().join()
      if (seen.has(key)) continue
      seen.add(key)
      const a = spots.get(r.addr.toLowerCase()), b = spots.get(v.addr.toLowerCase())
      if (a && b) links += `<path d="M${a.x} ${a.y} Q${(a.x + b.x) / 2} ${Math.min(a.y, b.y) - 40} ${b.x} ${b.y}" fill="none" stroke="#c8f25a" stroke-opacity=".5" stroke-width="1.5" stroke-dasharray="3 5"/>`
    }
  }

  let body = ''
  for (const r of roads) {
    const p = spots.get(r.addr.toLowerCase())
    const lv = level(r.repaid)
    const len = Math.min(cw - 30, 34 + 22 * r.repaid)
    const ang = ((p.h >> 4) % 50 - 25) * Math.PI / 180
    const ex = p.x + Math.cos(ang) * len, ey = p.y + Math.sin(ang) * len
    pts.push([p.x, p.y - 30], [p.x, p.y + 26], [ex, ey])
    const cx = (p.x + ex) / 2 + Math.sin(ang) * 14, cy = (p.y + ey) / 2 - Math.cos(ang) * 14
    const d = `M${p.x.toFixed(1)} ${p.y.toFixed(1)} Q${cx.toFixed(1)} ${cy.toFixed(1)} ${ex.toFixed(1)} ${ey.toFixed(1)}`
    const color = r.defaulted ? '#5d4d44' : ROAD_COLORS[lv]
    const dash = r.defaulted ? ' stroke-dasharray="6 5"' : ''
    let total = 0n
    for (const v of r.vouches.values()) total += v.amount
    let stones = ''
    let i = 0
    for (const v of r.vouches.values()) {
      const rad = Math.max(3, Math.min(10, 2.5 + Math.sqrt(Number(v.amount) / 1e18 / 10_000) * 2))
      const a2 = (i * 137.5) * Math.PI / 180, dist = 10 + i * 2.2
      stones += `<circle cx="${(p.x + Math.cos(a2) * dist).toFixed(1)}" cy="${(p.y - 14 + Math.sin(a2) * dist * 0.6).toFixed(1)}" r="${rad.toFixed(1)}" fill="hsl(${hue(v.addr)} 45% 62%)" stroke="#0e0f0c" stroke-width="1.5"/>`
      i++
    }
    const open = r.open ? `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="4" fill="none" stroke="#c8f25a" stroke-width="2"><animate attributeName="r" values="3;7;3" dur="1.6s" repeatCount="indefinite"/></circle>` : ''
    const highway = lv === 3 && !r.defaulted ? `<path d="${d}" stroke="#c8f25a" stroke-width="1.5" stroke-dasharray="6 6" fill="none"/>` : ''
    const me = same(r.addr, S.me) ? ' me' : ''
    const tip = `${short(r.addr)}: ${r.defaulted ? 'defaulted' : LEVELS[lv]}, ${r.repaid} repaid, ${r.vouches.size} stones (${wifFmt(total)} $WIF)${r.open ? ', loan open' : ''}`
    body += `<g class="road${me}" data-road="${r.addr}"><title>${tip}</title>
      <path class="road__line" d="${d}" stroke="${color}" stroke-width="7" stroke-linecap="round" fill="none"${dash}/>${highway}${open}${stones}
      <text x="${p.x}" y="${p.y + 22}" fill="#7f7d70" style="font-size: var(--fs)" font-family="ui-monospace, monospace">${short(r.addr)}</text></g>`
  }
  // Fit the view to the roads (a few roads fill the frame; many show the whole world).
  let vb = [0, 0, W, H]
  if (pts.length) {
    let x0 = Math.min(...pts.map((q) => q[0])) - 60, x1 = Math.max(...pts.map((q) => q[0])) + 60
    let y0 = Math.min(...pts.map((q) => q[1])) - 40, y1 = Math.max(...pts.map((q) => q[1])) + 40
    let w = Math.max(x1 - x0, 360), h = Math.max(y1 - y0, 150)
    if (w / h > W / H) h = w * H / W; else w = h * W / H
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2
    vb = [cx - w / 2, cy - h / 2, w, h].map((v) => +v.toFixed(1))
  }
  box.innerHTML = `<svg viewBox="${vb.join(' ')}" style="--fs: ${(vb[2] / 85).toFixed(1)}px" role="img" aria-label="Map of ${roads.length} roads">${grid}${links}${body}</svg>` +
    (roads.length ? '' : `<div class="map-empty">No roads yet. Be the first: connect, share your link, and get vouched for.</div>`)
  $$('.road', box).forEach((g) => g.addEventListener('click', () => {
    openVouch(g.dataset.road)
  }))
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
      <div class="strip" aria-label="${repaid} loans repaid">${tiles}</div>
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
    ? rows.map((b, i) => `<tr${same(b.addr, S.me) ? ' style="background: #1d2210"' : ''}><td>${i + 1}</td><td><span class="addr">${short(b.addr)}</span>${b.badges.map((x) => `<span class="badge">${x}</span>`).join('')}</td>
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
    </div>
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
  $('[data-act="connect"]').textContent = S.me ? short(S.me) : 'Connect wallet'
  renderMap()
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

function showTab(name) {
  S.tab = name
  $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)))
  $$('[data-panel]').forEach((p) => { p.hidden = p.dataset.panel !== name })
}

function openVouch(addr) {
  if (addr && isAddress(addr)) S.vouchFor = getAddress(addr)
  showTab('vouch')
  render()
  $('[data-panel="vouch"]').scrollIntoView({ behavior: 'smooth', block: 'start' })
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
  if (S.dep.explorer) $('[data-links]').innerHTML = `Contract <a href="${S.dep.explorer}/address/${S.dep.Pave}" target="_blank" rel="noopener">${short(S.dep.Pave)}</a> on ${S.dep.network}.`

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]')
    if (b && ACTIONS[b.dataset.act]) { e.preventDefault(); ACTIONS[b.dataset.act](b) }
    const t = e.target.closest('[data-tab]')
    if (t) showTab(t.dataset.tab)
  })
  document.addEventListener('input', (e) => {
    if (e.target.dataset?.in === 'vouch-for') {
      const v = e.target.value.trim()
      if (isAddress(v)) { S.vouchFor = getAddress(v); render() }
    }
  })

  const forAddr = new URLSearchParams(location.search).get('for')
  if (forAddr && isAddress(forAddr)) { S.vouchFor = getAddress(forAddr); showTab('vouch') }

  // Reconnect silently if the wallet already trusts this site.
  try {
    const accts = await window.ethereum?.request({ method: 'eth_accounts' })
    if (accts?.length) await connect()
  } catch { /* no wallet */ }

  await refresh()
  await findOverdue().then(render).catch(() => {})
  setInterval(async () => { await refresh(); await findOverdue().then(render).catch(() => {}) }, 15_000)
}

boot().catch((e) => { console.error(e); toast('Could not start: ' + explain(e), 'err') })
