// Design check: photographs each section of the running site at 1280 wide (nav bar on top, like
// the Figma frames) into design/_shots/<frame>.png, to lay over design/src/<frame>.jpg.
// `node design/shoot.mjs [width]` (MOTION=1 to keep the animation on) with the site on http://127.0.0.1:7930 (npm run local).
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const W = Number(process.argv[2] ?? 1280)
const OUT = join(import.meta.dirname, '_shots')
mkdirSync(OUT, { recursive: true })
const FRAMES = { 4: '#top', 1: '#how', 2: '#map', 3: '#road', 5: '#vouch', lend: '#lend', believers: '#believers', join: '#join', footer: 'footer.frame' }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const port = 9400 + Math.floor(Math.random() * 500)
const chrome = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
  '--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`,
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`, 'about:blank',
])
let target
for (let i = 0; i < 100 && !target; i++) { await sleep(200); try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page') } catch {} }
const ws = new WebSocket(target.webSocketDebuggerUrl)
await new Promise((r) => (ws.onopen = r))
let n = 0
const pending = new Map()
ws.onmessage = (m) => { const d = JSON.parse(m.data); pending.get(d.id)?.(d); pending.delete(d.id) }
const send = (method, params = {}) => new Promise((r) => { const id = ++n; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })) })
const evaluate = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result?.result?.value

try {
  await send('Page.enable')
  // Motion off: numbers land at once, and every section shows as designed without scrolling.
  if (!process.env.MOTION) await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
  await send('Emulation.setDeviceMetricsOverride', { width: W, height: 900, deviceScaleFactor: 1, mobile: W < 600 })
  await send('Page.navigate', { url: 'http://127.0.0.1:7930/?net=local' })
  await sleep(3500)
  await evaluate(`document.documentElement.style.scrollBehavior = 'auto'; document.fonts.ready.then(() => true)`)
  if (W < 900) {
    const h = await evaluate('document.documentElement.scrollHeight')
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: h, deviceScaleFactor: 1, mobile: true })
    await sleep(800)
    const r = await send('Page.captureScreenshot', { format: 'png' })
    writeFileSync(join(OUT, `phone-${W}.png`), Buffer.from(r.result.data, 'base64'))
  } else {
    // Each section on its own (page coordinates), then the nav bar laid on top by design/compare.py.
    const nav = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: W, height: await evaluate(`document.querySelector('.top').offsetHeight`), scale: 1 } })
    writeFileSync(join(OUT, 'nav.png'), Buffer.from(nav.result.data, 'base64'))
    for (const [frame, sel] of Object.entries(FRAMES)) {
      const [y, h] = await evaluate(`(() => { const r = document.querySelector('${sel}').getBoundingClientRect(); return [r.top + scrollY, r.height] })()`)
      const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y, width: W, height: h, scale: 1 } })
      writeFileSync(join(OUT, `${frame}.png`), Buffer.from(r.result.data, 'base64'))
    }
  }
  console.log('shots in ' + OUT)
} finally {
  ws.close(); chrome.kill()
}
