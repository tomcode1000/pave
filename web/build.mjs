import { mkdir, writeFile, copyFile, readFile, readdir } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'

/*
  Writes dist/: the page, the stylesheet, the app bundled with viem (app.js), the contract ABIs
  and every deployment in ../deployments. Nothing is loaded from outside at runtime except the RPC.
  `node build.mjs`
*/

const HERE = import.meta.dirname
const OUT = join(HERE, 'dist')
const ROOT = join(HERE, '..')

await mkdir(join(OUT, 'deployments'), { recursive: true })
for (const f of ['style.css', 'app.css', 'app-pages.css', 'favicon.svg', 'favicon.png']) await copyFile(join(HERE, f), join(OUT, f))
// The page, with its parts (<!--#include file.html-->) put in place.
let page = await readFile(join(HERE, 'index.html'), 'utf8')
const INCLUDE = /<!--#include ([\w.-]+)-->/g
while (INCLUDE.test(page)) page = page.replace(INCLUDE, (_, f) => readFileSync(join(HERE, f), 'utf8'))
await writeFile(join(OUT, 'index.html'), page)
// The pictures cut from the Figma frames (design/cut.py) and the typeface.
for (const dir of ['assets', 'fonts']) {
  await mkdir(join(OUT, dir), { recursive: true })
  for (const f of await readdir(join(HERE, dir))) await copyFile(join(HERE, dir, f), join(OUT, dir, f))
}

// ABIs straight from the compiled contracts (run `npx hardhat compile` in the parent first).
const abi = async (path) => JSON.parse(await readFile(join(ROOT, 'artifacts', 'contracts', path), 'utf8')).abi
const abis = {
  Pave: await abi('Pave.sol/Pave.json'),
  Token: await abi('test/Mocks.sol/MockERC20.json'),
  StateView: await abi('test/Mocks.sol/MockStateView.json'),
  Feed: await abi('test/Mocks.sol/TestnetFeed.json'),
}
await writeFile(join(OUT, 'abi.json'), JSON.stringify(abis))

const nets = []
if (existsSync(join(ROOT, 'deployments'))) {
  for (const f of await readdir(join(ROOT, 'deployments'))) {
    if (!f.endsWith('.json')) continue
    await copyFile(join(ROOT, 'deployments', f), join(OUT, 'deployments', f))
    nets.push(f.replace(/\.json$/, ''))
  }
}
await writeFile(join(OUT, 'deployments', 'index.json'), JSON.stringify(nets))

await build({
  entryPoints: [join(HERE, 'src', 'app.mjs')],
  outfile: join(OUT, 'app.js'),
  bundle: true,
  format: 'iife',
  minify: true,
  target: 'es2020',
  legalComments: 'eof',
  logLevel: 'warning',
})
console.log(`built dist/ with ${nets.length ? nets.join(', ') : 'no deployments'}`)
