import { homedir } from "node:os";
const dir = `${homedir()}/.spark/bepsi-test`;
delete process.env.SPARK_PASSPHRASE;
delete process.env.SPARK_DAILY_BUDGET_SATS;
Object.assign(process.env, {
  SPARK_SEED_PATH: `${dir}/seed.enc`,
  SPARK_PASSPHRASE_FILE: `${dir}/passphrase`,
  SPARK_NETWORK: "MAINNET",
  SPARK_LEAF_VAULT: "off",
  SPARK_AUDIT_LOG_PATH: `${dir}/audit.jsonl`,
  SPARK_SPEND_LEDGER_PATH: `${dir}/spend-ledger.json`,
  SPARK_LN_DEDUP_PATH: `${dir}/ln-dedup`,
});
const { loadMnemonicFromEnv } = await import("/workspace/lib/encrypted-seed.js");
const { SparkAgent } = await import("/workspace/skills/sparkbtcbot/scripts/spark-agent.js");
const TOKEN = "btkn1xecvlqngfwwvw2z38s67rn23r76m2vpkmwavfr9cr6ytzgqufu0ql0a4qk";
const TO = "spark1pgssx67qzgsqg0zv5vp98q82p22sx66w80udphrrxrh5cpawy9c0k2mf863y0y";
const { agent } = await SparkAgent.create(await loadMnemonicFromEnv(), "MAINNET", { optimizeLeaves: false });
const amount = BigInt((await agent.getBalance()).tokens[TOKEN]?.balance ?? "0");
if (amount === 0n) throw new Error("no BEPSI to send");
console.log("dry run:", JSON.stringify(await agent.transferTokens({ tokenIdentifier: TOKEN, amount, to: TO, dryRun: true })));
const result = await agent.transferTokens({ tokenIdentifier: TOKEN, amount, to: TO });
console.log("sent:", typeof result === "string" ? result : JSON.stringify(result));
let left = amount;
for (let i = 0; i < 10 && left > 0n; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  left = BigInt((await agent.getBalance()).tokens[TOKEN]?.balance ?? "0");
}
console.log("BEPSI left in the test wallet (base units):", String(left));
await agent.cleanup();
process.exit(0);
