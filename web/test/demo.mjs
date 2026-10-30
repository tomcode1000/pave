// TEST ONLY. The local demo wallets, in headless Chrome with no wallet extension: person A
// appears, is funded, mints test $WIF and vouches for person B; switching gives person B.
// Needs `npm run local` running.
import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = 'http://127.0.0.1:7930/?net=local'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const port = 9400 + Math.floor(Math.random() * 500)
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', `--remote-debugging-port=${port}`, '--window-size=1440,1200',
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`, 'about:blank',
])
let target
for (let i = 0; i < 100 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page') } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let n = 0
const pending = new Map()
const errors = []
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errors.push(d.params.exceptionDetails.exception?.description); pending.get(d.id)?.(d); pending.delete(d.id) }
const send = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
const check = (c, what) => { if (!c) throw new Error('check failed: ' + what); console.log('  ✓ ' + what) }
async function click(act) {
  await evaluate(`document.querySelector('[data-toast]').hidden = true; document.querySelector('[data-act="${act}"]').click()`)
  for (let i = 0; i < 100; i++) {
    await sleep(200)
    const t = await evaluate(`(() => { const t = document.querySelector('[data-toast]'); return t.hidden ? '' : t.className + '|' + t.textContent })()`)
    if (t.includes('toast--ok')) { console.log(`  ✓ ${act}: ${t.split('|')[1]}`); await sleep(300); return }
    if (t.includes('toast--err')) throw new Error(`${act}: ${t.split('|')[1]}`)
  }
  throw new Error(act + ': no result')
}

try {
  await send('Page.enable'); await send('Runtime.enable')
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
  await send('Page.navigate', { url: APP })
  for (let i = 0; i < 60 && (await evaluate(`document.querySelector('[data-k="pool"]').textContent`)) === '—'; i++) await sleep(250)
  check((await evaluate(`document.querySelector('[data-act="connect"]').textContent`)) === 'Use demo wallet', 'with no wallet app, the button offers a demo wallet')
  await click('connect')
  const a = await evaluate(`document.querySelector('[data-act="connect"]').textContent`)
  check(a.startsWith('0x'), `person A is connected (${a})`)
  await click('mint-wif')
  await click('demo-next')
  const b = await evaluate(`document.querySelector('[data-act="connect"]').textContent`)
  check(b.startsWith('0x') && b !== a, `switched to person B (${b})`)
  const bFull = await evaluate(`(() => { const t = document.querySelector('[data-act="demo-next"]').textContent; return t })()`)
  check(bFull.startsWith('Person B'), `the switcher says ${bFull}`)
  // A vouches for B
  const bAddr = await evaluate(`new URL(document.querySelector('.share code').textContent).searchParams.get('for')`)
  for (let i = 0; i < 3; i++) await click('demo-next') // back round to A
  await evaluate(`document.querySelector('[data-tab="vouch"]').click()`)
  await evaluate(`(() => { const s = (k, v) => { const i = document.querySelector('[data-in="' + k + '"]'); i.value = v; i.dispatchEvent(new Event('input', { bubbles: true })) }; s('vouch-for', '${bAddr}'); s('vouch-amt', '50000') })()`)
  await sleep(300)
  await click('vouch')
  check((await evaluate(`document.querySelectorAll('.map .road').length`)) >= 1, "B's road is on the map")
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  const file = join(tmpdir(), 'pave-demo.png')
  writeFileSync(file, Buffer.from(shot.result.data, 'base64'))
  console.log('  shot ' + file)
  check(errors.length === 0, 'no page errors' + (errors.length ? ': ' + errors.join(' | ') : ''))
  console.log('\nDemo wallets work.')
} catch (e) {
  console.error('\nFAILED: ' + e.message)
  process.exitCode = 1
} finally {
  ws.close(); chrome.kill()
}
