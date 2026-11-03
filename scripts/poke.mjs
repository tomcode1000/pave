// Records one price reading on Pave (poke), for the scheduled GitHub job (.github/workflows/keeper.yml).
// Borrowing needs a reading from an earlier period within the last 24; vouches record one too,
// this keeps them coming when nobody vouches. `node scripts/poke.mjs [network]` (default
// robinhood-testnet) with PAVE_DEPLOYER_KEY set; any wallet with a little gas will do.
import { readFileSync } from 'node:fs'
import { createPublicClient, createWalletClient, http, parseAbi, defineChain, formatEther } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const net = process.argv[2] ?? 'robinhood-testnet'
const d = JSON.parse(readFileSync(new URL(`../deployments/${net}.json`, import.meta.url), 'utf8'))
const chain = defineChain({ id: d.chainId, name: d.network, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 }, rpcUrls: { default: { http: [d.rpc] } } })
const pub = createPublicClient({ chain, transport: http(d.rpc) })
const account = privateKeyToAccount(process.env.PAVE_DEPLOYER_KEY)
const { request } = await pub.simulateContract({ address: d.Pave, abi: parseAbi(['function poke()']), functionName: 'poke', account })
const hash = await createWalletClient({ chain, transport: http(d.rpc), account }).writeContract(request)
const r = await pub.waitForTransactionReceipt({ hash })
if (r.status !== 'success') throw new Error('poke failed: ' + hash)
console.log(`${d.network}: price recorded ${d.explorer ? `${d.explorer}/tx/${hash}` : hash}`)
console.log(`keeper gas left: ${formatEther(await pub.getBalance({ address: account.address }))} ETH`)
