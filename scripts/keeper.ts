// The price keeper: records a price mark once per mark period, so Pave always has the price
// history it needs before it lends (borrowing pauses without an earlier mark; nothing else does).
// Costs one small transaction per hour on mainnet. Safe to run from several places at once:
// a second poke in the same period changes nothing but costs a little gas.
//   npx hardhat run scripts/keeper.ts --network robinhoodTestnet   (or robinhood)
//   ONCE=1 ... to poke a single time and exit.
import hre from "hardhat";
import { readFileSync } from "node:fs";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const net = hre.network.name;
  const file = `deployments/${net === "robinhood" ? "robinhood" : net === "localhost" ? "local" : "robinhood-testnet"}.json`;
  const dep = JSON.parse(readFileSync(file, "utf8"));
  const pave = await hre.viem.getContractAt("Pave", dep.Pave);
  const pub = await hre.viem.getPublicClient();
  const period = Number(await pave.read.markPeriod());
  console.log(`keeper on ${net}: Pave ${dep.Pave}, a mark every ${period}s`);
  let last = -1;
  for (;;) {
    const block = await pub.getBlock();
    const slot = Math.floor(Number(block.timestamp) / period);
    if (slot !== last) {
      try {
        const hash = await pave.write.poke();
        await pub.waitForTransactionReceipt({ hash });
        last = slot;
        console.log(`${new Date().toISOString()} marked period ${slot} (${hash})`);
      } catch (e) {
        console.error(`${new Date().toISOString()} poke failed: ${(e as Error).message.split("\n")[0]}`);
      }
      if (process.env.ONCE) return;
    }
    await sleep(Math.min(period * 1000, 60_000) / 2);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
