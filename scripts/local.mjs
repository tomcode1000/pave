// Pave on this computer, in one command: `npm run local`, then open http://127.0.0.1:7930
// Starts a local chain (a block every 5 s), deploys Pave with test tokens and the fast clock,
// builds the site, keeps the price keeper running and serves the site. Ctrl+C stops it all.
// A fresh chain every start: nothing is kept between runs.
import { spawn, execSync } from 'node:child_process'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const kids = []
const run = (name, cmd, args, opts = {}) => {
  const p = spawn(cmd, args, { cwd: ROOT, shell: true, env: { ...process.env, ...opts.env }, stdio: ['ignore', 'pipe', 'pipe'] })
  const tag = (d) => String(d).split('\n').filter(Boolean).forEach((l) => opts.quiet || console.log(`[${name}] ${l}`))
  p.stdout.on('data', tag)
  p.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.error(`[${name}] ${l}`)))
  kids.push(p)
  return p
}
const stop = () => { for (const k of kids) { try { process.platform === 'win32' ? execSync(`taskkill /pid ${k.pid} /T /F`, { stdio: 'ignore' }) : k.kill() } catch {} } process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)

const up = async () => {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch('http://127.0.0.1:8545', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' })
      if (r.ok) return
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  throw new Error('the local chain did not start')
}

console.log('starting the local chain…')
run('chain', 'npx', ['hardhat', 'node', '--port', '8545'], { env: { LOCAL_NODE: '1' }, quiet: true })
await up()
console.log('deploying Pave…')
execSync('npx hardhat run scripts/deploy.ts --network localhost', { cwd: ROOT, stdio: 'inherit' })
execSync('node build.mjs', { cwd: join(ROOT, 'web'), stdio: 'inherit' })
run('keeper', 'npx', ['hardhat', 'run', 'scripts/keeper.ts', '--network', 'localhost'])
run('site', 'node', ['web/serve.mjs'])
console.log('\nPave is running: http://127.0.0.1:7930  (Ctrl+C to stop)\n')
