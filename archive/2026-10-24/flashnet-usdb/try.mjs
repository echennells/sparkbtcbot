import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { FlashnetClient } from "@flashnet/sdk";
import { loadMnemonic } from "/workspace/lib/encrypted-seed.js";
import { sparkWalletOptions } from "/workspace/lib/wallet-options.js";
import { fetchBtcPrice } from "/workspace/lib/fiat-rate.js";
const BT = `${homedir()}/.spark/bepsi-test`;
const OPTS = sparkWalletOptions("MAINNET", { optimizationOptions: { auto: false } });
const BTC = "020202020202020202020202020202020202020202020202020202020202020202";
const USDB = "3206c93b24a4d18ea19d0a9a213204af2c7e74a6d16c7535cc5d33eca4ad1eca";
const USDB_B32 = "btkn1xgrvjwey5ngcagvap2dzzvsy4uk8ua9x69k82dwvt5e7ef9drm9qztux87";
const POOL = "037579aee81891fc3a28cbe7b13e565031d46248b420fb39dcb308598f472b4513";
const j = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { startedAt: new Date().toISOString(), steps: [] };
const step = (name, data) => { report.steps.push({ name, ...data }); log(name, j(data).slice(0, 700)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const m = await loadMnemonic({ passphrase: readFileSync(`${BT}/passphrase`, "utf8").trim(), path: `${BT}/seed.enc` });
const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: m, options: OPTS });
const MF = `${BT}/flashnet-merchant.json`;
if (!existsSync(MF)) writeFileSync(MF, JSON.stringify({ mnemonic: generateMnemonic(wordlist) }), { mode: 0o600 });
const { wallet: merchant } = await SparkWallet.initialize({ mnemonicOrSeed: JSON.parse(readFileSync(MF, "utf8")).mnemonic, options: OPTS });
const bal = async (w) => { const b = await w.getBalance(); return { sats: b.satsBalance.available, owned: b.satsBalance.owned, incoming: b.satsBalance.incoming, usdb: b.tokenBalances.get(USDB_B32)?.ownedBalance ?? 0n }; };
const settle = async (w, pred, tries = 15) => { let b; for (let i = 0; i < tries; i++) { b = await bal(w); if (pred(b)) break; await sleep(3000); } return b; };
const price = await fetchBtcPrice();
report.btcUsd = price.price;
const usd = (sats) => (Number(sats) * price.price / 1e8).toFixed(4);
const usdb = (units) => (Number(units) / 1e6).toFixed(6);

try {
  const client = new FlashnetClient(wallet);
  await client.initialize();
  step("start", { wallet: await bal(wallet), merchant: await bal(merchant), btcUsd: price.price });

  // A. BTC -> USDB
  const sim = await client.simulateSwap({ poolId: POOL, assetInAddress: BTC, assetOutAddress: USDB, amountIn: "5000" });
  step("A1 simulate 5000 sats -> USDB", { ...sim, marketUsd: usd(5000), outUsdb: usdb(sim.amountOut) });
  const minOut = String((BigInt(sim.amountOut) * 99n) / 100n);
  const swap = await client.executeSwap({ poolId: POOL, assetInAddress: BTC, assetOutAddress: USDB, amountIn: "5000", maxSlippageBps: 100, minAmountOut: minOut });
  step("A2 swap executed", { accepted: swap.accepted, amountOut: swap.amountOut, outUsdb: swap.amountOut && usdb(swap.amountOut), feeAmount: swap.feeAmount, error: swap.error, keys: Object.keys(swap).join(",") });
  const afterSwap = await settle(wallet, (b) => b.usdb > 0n && b.incoming === 0n);
  step("A3 wallet after swap", { ...afterSwap, usdbHuman: usdb(afterSwap.usdb) });

  // B. quote paying a 1,000-sat Lightning invoice with USDB
  const { invoice } = await merchant.createLightningInvoice({ amountSats: 1000, memo: "flashnet pay-with-token test", expirySeconds: 3600 });
  const bolt11 = invoice.encodedInvoice;
  const quote = await client.getPayLightningWithTokenQuote(bolt11, USDB, { maxSlippageBps: 100 });
  step("B quote: pay 1000 sats with USDB", { ...quote, tokenUsdb: usdb(quote.tokenAmountRequired), marketUsdFor1000: usd(1000) });

  // C. pay it
  const before = await bal(wallet);
  const paid = await client.payLightningWithToken({ invoice: bolt11, tokenAddress: USDB, maxSlippageBps: 100, rollbackOnFailure: true });
  step("C pay result", { ...paid, tokenUsdb: paid.tokenAmountSpent && usdb(paid.tokenAmountSpent) });
  const mAfter = await settle(merchant, (b) => b.sats >= 1000n && b.incoming === 0n);
  const wAfter = await settle(wallet, (b) => b.incoming === 0n);
  step("C balances", { merchant: mAfter, walletBefore: before, walletAfter: wAfter, usdbSpent: usdb(before.usdb - wAfter.usdb), satsDelta: String(wAfter.sats - before.sats) });

  // D. failure: the same invoice again (already paid), rollbackOnFailure on
  const before2 = await bal(wallet);
  let again;
  try { again = await client.payLightningWithToken({ invoice: bolt11, tokenAddress: USDB, maxSlippageBps: 100, rollbackOnFailure: true }); }
  catch (e) { again = { threw: String(e.message).slice(0, 400) }; }
  const after2 = await settle(wallet, (b) => b.incoming === 0n);
  const m2 = await bal(merchant);
  step("D pay the same invoice again", { result: again, walletBefore: before2, walletAfter: after2, usdbDelta: usdb(after2.usdb - before2.usdb), satsDelta: String(after2.sats - before2.sats), merchantSats: m2.sats });

  // E. merchant's sats back to the test wallet
  const mb = await bal(merchant);
  if (mb.sats > 0n) await merchant.transfer({ receiverSparkAddress: await wallet.getSparkAddress(), amountSats: Number(mb.sats) });
  const end = await settle(wallet, (b) => b.incoming === 0n);
  step("E end", { wallet: end, usdbHuman: usdb(end.usdb), returnedFromMerchant: String(mb.sats) });
} catch (e) {
  step("ERROR", { message: String(e?.message ?? e).slice(0, 600), stack: String(e?.stack ?? "").split("\n").slice(0, 4).join(" | ") });
} finally {
  writeFileSync(`${BT}/flashnet-try-${report.startedAt.replace(/[:.]/g, "-")}.json`, j(report));
  await merchant.cleanup().catch(() => {});
  await wallet.cleanup().catch(() => {});
  process.exit(0);
}
