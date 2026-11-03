// Design check for the app frames: photographs each app page at 1280x720 (the connect page with no
// wallet, the rest as a local demo person) into design/_shots/<frame>.png, and puts each over its
// Figma frame in design/_shots/cmp-<frame>.png (via compare-app.py).
// `node design/shoot-app.mjs [frame ...]` with `npm run local` running.
import { spawn, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const OUT = join(import.meta.dirname, '_shots')
mkdirSync(OUT, { recursive: true })
// frame -> page
const ALL = { 'app-connect': 'connect', 'app-road': 'road', 'app-borrow': 'borrow', 'app-repay': 'repay', 'app-lend': 'lend', 'app-vouch': 'vouch',
  'app-believers': 'believers', pool: 'pool', 'app-activity': 'activity', 'app-profile': 'profile', 'app-notify': 'notifications', levels: 'levels' }
const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(ALL)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const port = 9400 + Math.floor(Math.random() * 500)
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', ['--headless=new', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`, 'about:blank'])
let t
for (let i = 0; i < 100 && !t; i++) { await sleep(200); try { t = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((x) => x.type === 'page') } catch {} }
const ws = new WebSocket(t.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let n = 0
const pend = new Map()
const errs = []
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.method === 'Runtime.exceptionThrown') errs.push(d.params.exceptionDetails.exception?.description); pend.get(d.id)?.(d); pend.delete(d.id) }
const send = (method, params = {}) => new Promise((r) => { const id = ++n; pend.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const ev = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value
await send('Runtime.enable')
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false })
const shot = async (frame) => {
  const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1280, height: 720, scale: 1 } })
  writeFileSync(join(OUT, frame + '.png'), Buffer.from(r.result.data, 'base64'))
}
try {
  await send('Page.navigate', { url: 'http://127.0.0.1:7930/?net=local#/connect' })
  await sleep(3000)
  if (want.includes('app-connect')) await shot('app-connect')
  await ev(`document.querySelector('[data-pg="connect"] [data-act="connect"]').click()`)
  await sleep(2500)
  for (const frame of want) {
    if (frame === 'app-connect') continue
    await ev(`location.hash = '#/${ALL[frame]}'`)
    await sleep(1200)
    await shot(frame)
  }
  execSync(`python "${join(import.meta.dirname, 'compare-app.py')}" ${want.join(' ')}`, { stdio: 'inherit' })
  console.log(errs.length ? 'page errors: ' + errs.join(' | ') : 'no page errors')
} finally {
  ws.close()
  chrome.kill()
}
