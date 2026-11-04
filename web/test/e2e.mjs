// TEST ONLY. Drives the real page in headless Chrome against a local Hardhat chain, through a
// whole road in the app: two vouches, a mutual vouch, borrow, repay (gravel), the vouchers'
// rewards, a second loan left unpaid that a stranger ends from Notifications, and the lender
// collecting the $WIF. Every action is a click on the page, and every transaction must reach the
// status card's "Transaction Successful". The wallet is a stand-in injected as window.ethereum that
// forwards to the local node, whose test accounts are unlocked (?wallet=N picks the account).
// Screenshots go to SHOTS.
//   npm run local (or: hardhat node, deploy to localhost, node build.mjs, node serve.mjs); node test/e2e.mjs
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { encodeFunctionData, parseAbi } from 'viem'

const APP = 'http://127.0.0.1:7930'
const NODE = 'http://127.0.0.1:8545'
const ROOT = join(import.meta.dirname, '..', '..')
const SHOTS = process.env.SHOTS ?? join(tmpdir(), 'pave-e2e')
mkdirSync(SHOTS, { recursive: true })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const rpc = async (method, params = []) => {
  const r = await (await fetch(NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })).json()
  if (r.error) throw new Error(r.error.message)
  return r.result
}
// A clean chain every run: reset the node, redeploy, rebuild the site's deployment file.
await rpc('hardhat_reset', [])
execSync('npx hardhat run scripts/deploy.ts --network localhost', { cwd: ROOT, stdio: 'ignore' })
execSync('node build.mjs', { cwd: join(ROOT, 'web'), stdio: 'ignore' })
const PAVE = JSON.parse(readFileSync(join(ROOT, 'deployments', 'local.json'), 'utf8')).Pave
const accounts = await rpc('eth_accounts')
const [LENDER, BORROWER, ALICE, BOB, STRANGER] = [0, 1, 2, 3, 4]

// ---------------------------------------------------------------- browser
const port = 9400 + Math.floor(Math.random() * 500)
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, '--window-size=1440,1000',
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`, 'about:blank',
])
let target
for (let i = 0; i < 100 && !target; i++) {
  await sleep(200)
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page') } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let n = 0
const pending = new Map()
const logs = []
ws.onmessage = (m) => {
  const d = JSON.parse(m.data)
  if (d.method === 'Runtime.exceptionThrown') logs.push('EXCEPTION ' + JSON.stringify(d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text))
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') logs.push('console.error ' + d.params.args.map((a) => a.value ?? a.description).join(' '))
  pending.get(d.id)?.(d); pending.delete(d.id)
}
const send = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.result?.exceptionDetails) throw new Error('page: ' + JSON.stringify(r.result.exceptionDetails.exception?.description))
  return r.result?.result?.value
}
await send('Page.enable')
// Motion off: numbers land at once, and every section shows as designed without scrolling.
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await send('Runtime.enable')
const size = (width, height, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
await size(1440, 1000)

// The stand-in wallet: forwards to the node; the chosen account signs (Hardhat keeps them unlocked).
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const accts = ${JSON.stringify(accounts)}
  const me = accts[Number(new URLSearchParams(location.search).get('wallet') || 0)]
  window.ethereum = {
    request: async ({ method, params }) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [me]
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') return null
      if (method === 'eth_sendTransaction') params = [{ ...params[0], from: me }]
      const r = await fetch('${NODE}', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) })
      const j = await r.json()
      if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e }
      return j.result
    },
    on() {}, removeListener() {}, removeAllListeners() {},
  }
})()` })

let step = 0
async function shot(name) {
  const r = await send('Page.captureScreenshot', { format: 'png' })
  const file = join(SHOTS, `${String(++step).padStart(2, '0')}-${name}.png`)
  writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  console.log(`  shot ${file}`)
}
/// Opens the app as one of the test accounts, on a page (#/road, ...), once the chain has been read.
async function open(wallet, hash = '', extra = '') {
  await send('Page.navigate', { url: `${APP}/?net=local&wallet=${wallet}${extra}${hash}` })
  for (let i = 0; i < 100; i++) {
    await sleep(200)
    if (await evaluate(`!!document.querySelector('[data-me-short]') && document.querySelector('[data-me-short]').textContent.startsWith('0x') && document.querySelector('[data-L="total"]').textContent !== '—'`)) break
  }
  await sleep(500)
}
const go = async (page) => { await evaluate(`location.hash = '#/${page}'`); await sleep(500) }
async function type(key, value) {
  await evaluate(`(() => { const i = document.querySelector('[data-in="${key}"]'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
}
/// Clicks an action and waits for its result: the status card (successful or failed), or a message.
async function click(act, scope = '') {
  await evaluate(`(() => { document.querySelector('[data-toast]').hidden = true; const m = document.querySelector('[data-txm]'); m.hidden = true; m.dataset.state = '' })()`)
  await evaluate(`(() => { const b = [...document.querySelectorAll('${scope} [data-act="${act}"]')].find((x) => x.offsetParent || x.closest('[data-tools]')); if (!b) throw new Error('no visible ${act} button'); b.click() })()`)
  for (let i = 0; i < 150; i++) {
    await sleep(200)
    const r = await evaluate(`(() => {
      const m = document.querySelector('[data-txm]'), t = document.querySelector('[data-toast]')
      if (!m.hidden && m.dataset.state === 'ok') return 'ok|' + document.querySelector('[data-txm-rows]').textContent
      if (!m.hidden && m.dataset.state === 'bad') return 'bad|' + document.querySelector('[data-txm-rows]').textContent
      if (!t.hidden) return t.className + '|' + t.textContent
      return ''
    })()`)
    if (r.startsWith('ok|')) {
      console.log(`  ✓ ${act}: Transaction Successful`)
      await evaluate(`document.querySelector('[data-txm-go="continue"]').click()`)
      await sleep(600)
      return 'ok'
    }
    if (r.includes('toast--ok')) { console.log(`  ✓ ${act}: ${r.split('|')[1]}`); return 'ok' }
    if (r.startsWith('bad|') || r.includes('toast--err')) return 'err|' + r.split('|')[1]
  }
  throw new Error(`${act}: no result`)
}
async function must(act, scope) { const r = await click(act, scope); if (r !== 'ok') throw new Error(`${act} failed on the page: ${r.slice(4)}`) }
const text = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent?.trim()`)
async function chainTime(seconds) { await rpc('evm_increaseTime', [seconds]); await rpc('evm_mine') }
/// A price reading, sent straight to the node (the site's own keeper is pointed at the last chain).
const poke = () => rpc('eth_sendTransaction', [{ from: accounts[LENDER], to: PAVE, data: encodeFunctionData({ abi: parseAbi(['function poke()']), functionName: 'poke' }) }])
function check(cond, what) { if (!cond) throw new Error('check failed: ' + what); console.log(`  ✓ ${what}`) }

try {
  const borrower = accounts[BORROWER]

  console.log("1. Alice opens the borrower's vouch link, gets test $WIF and vouches 100,000")
  await open(ALICE, '', `&for=${borrower}`)
  check((await evaluate(`location.hash`)) === '#/vouch', 'a vouch link opens the Vouch page')
  check((await evaluate(`document.querySelector('[data-in="vouch-for"]').value`))?.toLowerCase() === borrower.toLowerCase(), 'with the address filled in')
  await must('mint-wif')
  await go('vouch')
  await type('vouch-amt', '100000')
  await must('vouch')
  await shot('alice-vouched')

  console.log('2. Bob vouches 50,000')
  await open(BOB, '', `&for=${borrower}`)
  await must('mint-wif')
  await go('vouch')
  await type('vouch-amt', '50000')
  await must('vouch')

  console.log('3. The borrower vouches back for Alice')
  await open(BORROWER, '', `&for=${accounts[ALICE]}`)
  await must('mint-wif')
  await go('vouch')
  await type('vouch-amt', '20000')
  await must('vouch')

  console.log('4. The stones mature; the borrower borrows the most the road allows')
  // borrowing needs price marks from two earlier 5-minute periods (the keeper's job on a real chain)
  await chainTime(3 * 60)
  await poke()
  await chainTime(5 * 60)
  await poke()
  await chainTime(5 * 60)
  await open(BORROWER, '#/borrow')
  const limit = await text('[data-bw="limit"]')
  check(limit === 'Available Limit: $10.00', `a dirt road lends up to $10 (${limit})`)
  await evaluate(`document.querySelector('[data-act="borrow-max"]').click()`); await sleep(200)
  check((await text('[data-bw="total"]')) === '$10.30', 'the summary asks back $10.30 (3% fee)')
  await must('borrow')
  check((await evaluate('location.hash')) === '#/road', 'Continue goes back to Your Road')
  check((await text('[data-bc="go"]')) === 'Repay Now' && (await text('[data-bc="owed"]')) === '10.30', 'the road card shows the loan: Repay Now, 10.30')
  await shot('borrowed')

  console.log('5. Repay: short of USDG is refused before signing; then the road reaches gravel')
  await go('repay')
  check((await text('[data-rp="owed"]')) === '$10.30', 'the repay page owes $10.30')
  const short = await click('repay')
  check(short.startsWith('err|') && short.includes('more USDG'), 'repaying without enough USDG is stopped with a plain message')
  await must('mint-usdg')
  await go('repay')
  await must('repay')
  await go('road')
  check((await text('[data-r2="next"]')) === 'Progress to Cobblestone', 'the road is now gravel, heading for cobblestone')
  await go('levels')
  check(await evaluate(`document.querySelector('.lvlcard.here')?.dataset.lv === '1'`), 'the levels page marks Level 1')
  await shot('gravel')

  console.log("6. Alice's share of the fee")
  await open(ALICE, '#/vouch')
  check((await text('[data-vc="claim"]')) === '+$0.06', 'Alice can claim $0.06')
  await must('claim-rewards')

  console.log('7. A second loan goes unpaid; after the grace period a stranger ends it from Notifications')
  await open(BORROWER, '#/road')
  await go('borrow')
  await evaluate(`document.querySelector('[data-act="borrow-max"]').click()`); await sleep(200)
  await must('borrow')
  await chainTime(13 * 60)
  await open(STRANGER, '#/notifications')
  for (let i = 0; i < 40 && !(await evaluate(`!!document.querySelector('[data-sheet]:not([hidden]) [data-act="default"]')`)); i++) {
    await evaluate(`(() => { const r = [...document.querySelectorAll('.nrow')].find((x) => x.textContent.includes('Grace Period')); r?.click() })()`)
    await sleep(250)
  }
  await must('default', '[data-sheet]')
  await shot('defaulted')
  await open(BORROWER, '#/road')
  check((await text('[data-bc="title"]')) === 'Road closed', "the borrower's road is closed")
  check((await text('[data-p="status"]')) === 'Defaulted' && (await text('[data-p="level"]')) === 'Cracked', 'the map card says Cracked, Defaulted')

  console.log('8. The lender collects the $WIF from the default')
  await open(LENDER, '#/lend')
  await must('claim-wif', '[data-pg="lend"]')

  console.log('9. Believers, activity')
  await go('believers')
  const rows = await evaluate(`document.querySelectorAll('[data-lboard] .lrow .vp').length`)
  check(rows >= 3, `the leaderboard lists ${rows} believers`)
  await open(BORROWER, '#/activity')
  for (let i = 0; i < 40 && !(await evaluate(`document.querySelectorAll('[data-arows] .arow').length`)); i++) await sleep(250)
  const acts = await evaluate(`document.querySelectorAll('[data-arows] .arow').length`)
  check(acts >= 4, `the borrower's activity lists ${acts} transactions`)
  await shot('activity')

  console.log('10. Phone width: nothing past the page edge')
  await size(390, 900, true)
  await open(BORROWER, '#/road')
  const over = await evaluate(`document.documentElement.scrollWidth - window.innerWidth`)
  check(over <= 0, `no horizontal overflow at 390px (${over}px)`)
  await shot('phone')

  check(logs.length === 0, `no page errors${logs.length ? ': ' + logs.join(' | ') : ''}`)
  console.log('\nE2E passed.')
} catch (e) {
  await shot('failure').catch(() => {})
  console.error('\nE2E FAILED: ' + e.message)
  if (logs.length) console.error(logs.join('\n'))
  process.exitCode = 1
} finally {
  ws.close()
  chrome.kill()
}
