// The "agent program": written the way the docs tell a user to — the package's
// own imports, the seed opened with loadMnemonicFromEnv (SPARK_PASSPHRASE_FILE),
// every ~/.spark path at its default (HOME is a sandbox). Prints one JSON line
// per step: { step, ok, ... }.
import { loadMnemonicFromEnv } from "sparkbtcbot-skill";
import { SparkAgent } from "sparkbtcbot-skill/agent";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const [phase, tokenId] = process.argv.slice(2);
const out = (step, obj) => console.log(JSON.stringify({ step, ...obj }, (k, v) => (typeof v === "bigint" ? String(v) : v)));
const outcome = async (step, fn) => {
  try { out(step, { ok: true, result: await fn() }); }
  catch (e) { out(step, { ok: false, code: e?.code ?? e?.name, rule: e?.rule, message: String(e?.message ?? e).slice(0, 220), ...(e?.paid ? { paid: e.paid.length, failed: e.failed.length } : {}), ...(e?.invalidInvoices ? { invalid: e.invalidInvoices.map((i) => i.reason) } : {}) }); }
};
const settle = async (w, want) => { for (let i = 0; i < 30; i++) { const b = (await w.getBalance()).satsBalance; if (b.incoming === 0n && b.available >= want) return b.available; await new Promise((r) => setTimeout(r, 1500)); } return (await w.getBalance()).satsBalance.available; };
const tokenBal = async (w) => { for (let i = 0; i < 20; i++) { const t = (await w.getBalance()).tokenBalances.get(tokenId)?.ownedBalance ?? 0n; if (t > 0n) return t; await new Promise((r) => setTimeout(r, 1500)); } return 0n; };

const mnemonic = await loadMnemonicFromEnv();
const { agent } = await SparkAgent.create(mnemonic, "REGTEST", { optimizeLeaves: false });
const { wallet: recv } = await SparkWallet.initialize({ options: { network: "REGTEST", optimizationOptions: { auto: false } } });
const to = await recv.getSparkAddress();

if (phase === "limits") {
  // The funding transfer arrives as incoming; wait until the agent has claimed it.
  for (let i = 0; i < 40 && Number((await agent.getBalance()).sats) < 8000; i++) await new Promise((r) => setTimeout(r, 1500));
  out("funded", { ok: true, sats: (await agent.getBalance()).sats });
  const p = await agent.policy();
  out("policy", { ok: true, sealed: p.sealed, tokens: p.tokens, budget: p.budget });
  await outcome("sats 1500 within caps", () => agent.transfer({ to, amount: 1500 }).then((r) => r.valueSentByWallet));
  await outcome("sats 2500 over maxPerTxSats", () => agent.transfer({ to, amount: 2500 }));
  await outcome("sats 1600 over the daily budget", () => agent.transfer({ to, amount: 1600 }));
  await outcome("tokens 0.005001 over maxPerTx", () => agent.transferTokens({ tokenIdentifier: tokenId, amount: 5001n, to }));
  await outcome("tokens 0.005 at the cap", () => agent.transferTokens({ tokenIdentifier: tokenId, amount: 5000n, to }));
  await outcome("tokens 0.004 over the token budget", () => agent.transferTokens({ tokenIdentifier: tokenId, amount: 4000n, to }));
  await outcome("tokens 0.003 = the remainder", () => agent.transferTokens({ tokenIdentifier: tokenId, amount: 3000n, to }));
  const expired = await recv.createSatsInvoice({ amount: 300, expiryTime: new Date(Date.now() + 2000) });
  await new Promise((r) => setTimeout(r, 4000));
  await outcome("expired Spark invoice", () => agent.fulfillInvoice([{ invoice: expired }]));
  const inv = await recv.createSatsInvoice({ amount: 500, memo: "e2e" });
  await outcome("Spark invoice 500", () => agent.fulfillInvoice([{ invoice: inv }]).then((r) => r.satsTransactionSuccess.length));
  await outcome("same invoice again", () => agent.fulfillInvoice([{ invoice: inv }]));
  out("spendStatus", { ok: true, status: await agent.spendStatus() });
  writeFileSync(join(homedir(), ".spark", "recipients.allow"), "sparkrt1pgss8nsxt2292rwx8smgl6r7wng5y5cgs805r3ga3t0mt2v2acldwsjgc9wgtt\n");
  await outcome("allowlist: send to an unlisted receiver", () => agent.transfer({ to, amount: 10 }));
  out("receiver", { ok: true, sats: await settle(recv, 2000n), tokens: await tokenBal(recv) });
  const audit = readFileSync(join(homedir(), ".spark", "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  out("audit", { ok: true, lines: audit.length, verdicts: audit.map((l) => `${l.op}:${l.verdict}${l.result ? "/" + l.result : ""}${l.rule ? "(" + l.rule + ")" : ""}`) });
}
if (phase === "after-reset") {
  out("spendStatus after reset-ledger", { ok: true, status: await agent.spendStatus() });
  await outcome("sats 1500 again after reset", () => agent.transfer({ to: process.argv[4], amount: 1500 }).then((r) => r.valueSentByWallet));
}
if (phase === "sweep") {
  // Return what's left to the funded wallet (raw wallet: cleanup, not agent behavior).
  const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, options: { network: "REGTEST", optimizationOptions: { auto: false } } });
  const b = (await wallet.getBalance()).satsBalance.available;
  if (b > 0n) await wallet.transfer({ receiverSparkAddress: process.argv[4], amountSats: Number(b) });
  out("swept", { ok: true, sats: b });
  await wallet.cleanup();
}
// The receiver is a throwaway: send its sats back too.
const rb = await settle(recv, 1n);
if (rb > 0n && process.argv[4]) await recv.transfer({ receiverSparkAddress: process.argv[4], amountSats: Number(rb) }).catch(() => {});
await agent.cleanup();
await recv.cleanup();
