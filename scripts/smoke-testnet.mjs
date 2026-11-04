// A whole road on Robinhood Chain testnet, with real transactions: a throwaway friend (made here,
// funded with a little gas by the deployer) gets test $WIF and vouches for the deployer; once the
// vouch matures the deployer borrows the most it can and repays it.
// `node scripts/smoke-testnet.mjs` with PAVE_DEPLOYER_KEY set (e.g. from .env).
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, parseAbi, parseEther, defineChain } from 'viem'
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts'

const d = JSON.parse(readFileSync(new URL('../deployments/robinhood-testnet.json', import.meta.url), 'utf8'))
const chain = defineChain({ id: d.chainId, name: d.network, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [d.rpc] } } })
const pub = createPublicClient({ chain, transport: http(d.rpc) })
const me = privateKeyToAccount(process.env.PAVE_DEPLOYER_KEY)
const friend = privateKeyToAccount(generatePrivateKey())
const W = (account) => createWalletClient({ chain, transport: http(d.rpc), account })
const TOKEN = parseAbi(['function mint(address,uint256)', 'function approve(address,uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)'])
const PAVE = parseAbi(['function vouch(address,uint256)', 'function borrow(uint256)', 'function repay(address)', 'function poke()',
  'function loans(address) view returns (uint256 principal, uint256 fee, uint256 due, uint256 debtWif)',
  'function creditOf(address) view returns ((uint256 vouchedWif, uint256 matureWif, uint256 matureUsdg, uint256 backed, uint256 levelCap, uint256 available, uint8 level, uint256 vouchers, (uint32 repaid, uint32 streak, uint32 late, bool defaulted) path))'])
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (what, hash) => console.log(`${what.padEnd(26)} ${d.explorer}/tx/${hash}`)
async function tx(account, what, address, abi, functionName, args = []) {
  const { request } = await pub.simulateContract({ address, abi, functionName, args, account })
  const hash = await W(account).writeContract(request)
  const r = await pub.waitForTransactionReceipt({ hash })
  if (r.status !== 'success') throw new Error(what + ' failed')
  log(what, hash)
}

// SKIP_VOUCH=1: a friend's vouch is already in place (an earlier run); go straight to the loan.
if (!process.env.SKIP_VOUCH) {
console.log('friend (throwaway):', friend.address)
const gas = await W(me).sendTransaction({ to: friend.address, value: parseEther('0.002') })
await pub.waitForTransactionReceipt({ hash: gas })
log('gas for the friend', gas)
const amt = parseEther('100000')
await tx(friend, 'friend gets test $WIF', d.wif, TOKEN, 'mint', [friend.address, amt])
await tx(friend, 'friend approves $WIF', d.wif, TOKEN, 'approve', [d.Pave, amt])
await tx(friend, 'friend vouches 100,000', d.Pave, PAVE, 'vouch', [me.address, amt])
}
console.log(`waiting for the vouch to mature and price marks from ${d.params.minMarks} earlier periods…`)
let c = { available: 0n }
for (let i = 0; i < 40; i++) {
  await sleep(60_000)
  try {
    await tx(me, 'record price', d.Pave, PAVE, 'poke')
    c = await pub.readContract({ address: d.Pave, abi: PAVE, functionName: 'creditOf', args: [me.address] })
  } catch (e) { console.log('network hiccup, trying again:', e.shortMessage ?? e.message); continue }
  if (c.available === 0n) continue
  try { await pub.simulateContract({ address: d.Pave, abi: PAVE, functionName: 'borrow', args: [c.available], account: me }); break } catch {}
}
console.log('can borrow', Number(c.available) / 1e6, 'USDG')
await tx(me, `borrow ${Number(c.available) / 1e6} USDG`, d.Pave, PAVE, 'borrow', [c.available])
const l = await pub.readContract({ address: d.Pave, abi: PAVE, functionName: 'loans', args: [me.address] })
const owed = l[0] + l[1]
await tx(me, 'get test USDG for the fee', d.usdg, TOKEN, 'mint', [me.address, owed])
await tx(me, 'approve USDG', d.usdg, TOKEN, 'approve', [d.Pave, owed])
await tx(me, `repay ${Number(owed) / 1e6} USDG`, d.Pave, PAVE, 'repay', [me.address])
const after = await pub.readContract({ address: d.Pave, abi: PAVE, functionName: 'creditOf', args: [me.address] })
console.log(`done: ${after.path.repaid} loan repaid, road level ${after.level}`)
