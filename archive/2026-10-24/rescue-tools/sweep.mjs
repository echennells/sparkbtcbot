// Sweep the bepsi-test wallet to DEST. Usage: node sweep.mjs dry|live <spark1… address>
// Prints amounts, ids and public keys only; the mnemonic stays in memory.
import { decodeSparkAddress } from "/workspace/node_modules/@buildonspark/spark-sdk/dist/index.node.js";
import { loadMnemonicFromEnv } from "/workspace/lib/encrypted-seed.js";
import { SparkAgent } from "/workspace/skills/sparkbtcbot/scripts/spark-agent.js";

const DEST = process.argv[3] ?? "<destination spark1… address>";
const OWN = ["0225a3e5d0de", "03885d1b798d", "03aaf808744a", "035390cc9739", "024a6aa27b5f", "03c157f794c6"];
const live = process.argv[2] === "live";

const dec = decodeSparkAddress(DEST, "MAINNET");
console.log("dest identityPublicKey:", dec.identityPublicKey, "| one of this folder's wallets:", OWN.some((p) => dec.identityPublicKey.startsWith(p)));

const { agent } = await SparkAgent.create(await loadMnemonicFromEnv(), "MAINNET", { optimizeLeaves: false });
try {
  console.log("policy:", JSON.stringify(await agent.policy()));
  const { sats, tokens } = await agent.getBalance();
  console.log("balance before:", sats, "sats", JSON.stringify(tokens));
  for (const [id, t] of Object.entries(tokens)) {
    if (BigInt(t.balance) === 0n) continue;
    const r = await agent.transferTokens({ tokenIdentifier: id, amount: BigInt(t.balance), to: DEST, dryRun: !live });
    console.log(`${t.ticker}:`, JSON.stringify(r, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  }
  if (BigInt(sats) > 0n) {
    const r = await agent.transfer({ to: DEST, amount: BigInt(sats), dryRun: !live });
    console.log("sats:", JSON.stringify(r, (_, v) => (typeof v === "bigint" ? String(v) : v)));
  }
  if (live) {
    const after = await agent.getBalance();
    console.log("balance after:", after.sats, "sats", JSON.stringify(after.tokens));
  }
} finally {
  await agent.cleanup();
}
process.exit(0);
