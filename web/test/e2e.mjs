// TEST ONLY. Drives the real page in headless Chrome against a local Hardhat chain, through a
// whole road: two vouches, a mutual vouch, borrow, repay (gravel), a second
// loan left unpaid, a stranger ends it, the lender collects the $WIF. Every action is a click on
// the page. The wallet is a stand-in injected as window.ethereum that forwards to the local node,
// whose test accounts are unlocked (?wallet=N picks the account). Screenshots go to SHOTS.
//   npx hardhat node; npx hardhat run scripts/deploy.ts --network localhost; node build.mjs;
//   node serve.mjs; node test/e2e.mjs
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = 'http://127.0.0.1:7930'
const NODE = 'http://127.0.0.1:8545'
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
execSync('npx hardhat run scripts/deploy.ts --network localhost', { cwd: join(import.meta.dirname, '..', '..'), stdio: 'ignore' })
execSync('node build.mjs', { cwd: join(import.meta.dirname, '..'), stdio: 'ignore' })
const accounts = await rpc('eth_accounts')
const [LENDER, BORROWER, ALICE, BOB, STRANGER] = [0, 1, 2, 3, 4]

// ---------------------------------------------------------------- browser
const port = 9400 + Math.floor(Math.random() * 500)
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, '--window-size=1440,1200',
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
await size(1440, 1200)

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
  const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  const file = join(SHOTS, `${String(++step).padStart(2, '0')}-${name}.png`)
  writeFileSync(file, Buffer.from(r.result.data, 'base64'))
  console.log(`  shot ${file}`)
}
async function open(query) {
  await send('Page.navigate', { url: `${APP}/?net=local&${query}` })
  for (let i = 0; i < 100; i++) {
    await sleep(200)
    if (await evaluate(`!!document.querySelector('[data-k="pool"]') && document.querySelector('[data-k="pool"]').textContent !== '—'`)) break
  }
  await sleep(400)
}
async function type(key, value) {
  await evaluate(`(() => { const i = document.querySelector('[data-in="${key}"]'); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })) })()`)
}
/// Click an action and wait for its toast to say done (or fail with what the page said).
async function click(act, extra = '') {
  await evaluate(`document.querySelector('[data-toast]').hidden = true`)
  await evaluate(`document.querySelector('[data-act="${act}"]${extra}').click()`)
  for (let i = 0; i < 150; i++) {
    await sleep(200)
    const t = await evaluate(`(() => { const t = document.querySelector('[data-toast]'); return t.hidden ? '' : t.className + '|' + t.textContent })()`)
    if (t.includes('toast--ok')) { console.log(`  ✓ ${act}: ${t.split('|')[1]}`); await sleep(300); return }
    if (t.includes('toast--err')) throw new Error(`${act} failed on the page: ${t.split('|')[1]}`)
  }
  throw new Error(`${act}: no result`)
}
const text = (sel) => evaluate(`document.querySelector(${JSON.stringify(sel)})?.textContent?.trim()`)
async function chainTime(seconds) { await rpc('evm_increaseTime', [seconds]); await rpc('evm_mine') }
function check(cond, what) { if (!cond) throw new Error('check failed: ' + what); console.log(`  ✓ ${what}`) }

try {
  const borrower = accounts[BORROWER]

  console.log('1. Alice opens the borrower\'s link, gets test $WIF and vouches 100,000')
  await open(`wallet=${ALICE}&for=${borrower}`)
  check((await evaluate(`document.querySelector('[data-in="vouch-for"]').value`))?.toLowerCase() === borrower.toLowerCase(), 'a vouch link fills in the vouch form')
  await click('mint-wif')
  await type('vouch-amt', '100000')
  await click('vouch')
  await shot('alice-vouched')

  console.log('2. Bob vouches 50,000')
  await open(`wallet=${BOB}&for=${borrower}`)
  await click('mint-wif')
  await type('vouch-amt', '50000')
  await click('vouch')

  console.log('3. The borrower vouches back for Alice: their roads connect')
  await open(`wallet=${BORROWER}&for=${accounts[ALICE]}`)
  await click('mint-wif')
  await type('vouch-amt', '20000')
  await click('vouch')

  console.log('4. The stones mature; the borrower borrows the most their road allows')
  await chainTime(3 * 60)
  await open(`wallet=${BORROWER}`)
  await click('poke')
  await chainTime(70)
  await open(`wallet=${BORROWER}`)
  const can = await evaluate(`[...document.querySelectorAll('.kv dt')].find((d) => d.textContent === 'Can borrow now').nextElementSibling.textContent`)
  check(can === '$10.00', `dirt road lends up to $10 (page says ${can})`)
  await click('borrow')
  await shot('borrowed')
  check((await text('[data-panel="road"] [data-act="repay"]'))?.startsWith('Repay $10.30'), 'the repay button asks for $10.30')
  check((await text('[data-p="status"]')) === 'Active' && (await text('[data-p="backing"]')) === '150,000', 'the map card shows the open loan and 150,000 $WIF behind the road')

  console.log('5. Repay: the road reaches gravel, the vouchers earn')
  check(((await text('[data-panel="road"] .note--warn')) ?? '').includes('more USDG needed'), 'the page warns the borrower is short of the fee')
  await click('mint-usdg')
  await click('repay')
  check((await text('.levelname')) === 'Gravel', 'road level is Gravel')
  check((await text('[data-p="level"]')) === 'Level 1' && (await text('[data-p="pct"]')) === '0%', 'the map card says Level 1, 0% toward cobblestone')
  await shot('gravel')
  await open(`wallet=${ALICE}`)
  check((await text('[data-r="claim"]')) === '$0.06', 'the rewards card shows $0.06 to collect')
  check((await text('[data-act="claim-rewards"]'))?.startsWith('Collect $0.06'), 'Alice can collect her share of the fee ($0.06)')
  await click('claim-rewards')

  console.log('6. A second loan goes unpaid; after the grace period a stranger ends it')
  await open(`wallet=${BORROWER}`)
  await click('borrow')
  await chainTime(13 * 60)
  await open(`wallet=${STRANGER}`)
  for (let i = 0; i < 40 && !(await evaluate(`!!document.querySelector('[data-act="default"]')`)); i++) await sleep(250)
  await click('default')
  await shot('defaulted')
  const burned = await text('[data-k="burned"]')
  check(burned && burned !== '0', `$WIF burned shows ${burned}`)
  await open(`wallet=${BORROWER}`)
  check((await text('.levelname')) === 'Cracked', "the borrower's road is cracked")
  check((await text('[data-p="status"]')) === 'Defaulted' && (await text('[data-p="level"]')) === 'Cracked', 'the map card says Cracked, Defaulted')

  console.log('7. The lender collects the $WIF from the default')
  await open(`wallet=${LENDER}`)
  await click('claim-wif')

  console.log('8. Believers board')
  const rows = await evaluate(`document.querySelectorAll('.board tbody tr').length`)
  check(rows >= 3, `Believers board lists ${rows} people`)
  await shot('believers')

  console.log('9. Phone width: nothing past the page edge')
  await size(390, 900, true)
  await open(`wallet=${BORROWER}`)
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
