// Probe: what a REGTEST Lightning send reports as its fee vs what leaves the wallet.
import { readFileSync } from "node:fs";
import { parse } from "dotenv";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { sparkWalletOptions } from "/workspace/lib/wallet-options.js";

const mn = parse(readFileSync("/workspace/.env")).SPARK_TEST_MNEMONIC.trim();
const open = async (m) => (await SparkWallet.initialize({ mnemonicOrSeed: m, options: sparkWalletOptions("REGTEST", { optimizationOptions: { auto: false } }) })).wallet;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bal = async (w) => (await w.getBalance()).satsBalance;
const settle = async (w) => { for (let i = 0; i < 40; i++) { const b = await bal(w); if (b.incoming === 0n) return b; await sleep(1500); } return bal(w); };

const payer = await open(mn);
const receiver = await open(undefined);
try {
  const before = await settle(payer);
  const inv = await receiver.createLightningInvoice({ amountSats: 1000, memo: "fee probe", expirySeconds: 600 });
  const est = await payer.getLightningSendFeeEstimate({ encodedInvoice: inv.invoice.encodedInvoice });
  console.log("estimate", est);
  const r = await payer.payLightningInvoice({ invoice: inv.invoice.encodedInvoice, maxFeeSats: 25, preferSpark: true });
  console.log("pay result: status", r.status, "fee", JSON.stringify(r.fee), "transfer", r.transfer ? JSON.stringify({ totalAmount: r.transfer.totalAmount, status: r.transfer.status }) : "none", "keys", Object.keys(r));
  let s;
  for (let i = 0; i < 20; i++) {
    s = await payer.getLightningSendRequest(r.id);
    if (s?.paymentPreimage) break;
    await sleep(2000);
  }
  console.log("status read: status", s?.status, "fee", JSON.stringify(s?.fee), "transfer", s?.transfer ? JSON.stringify({ totalAmount: s.transfer.totalAmount, status: s.transfer.status }) : "none");
  const after = await settle(payer);
  console.log("payer delta immediately", String(after.available - before.available));
  await sleep(45_000);
  const later = await settle(payer);
  console.log("payer delta after 45s", String(later.available - before.available));
  const rb = await settle(receiver);
  console.log("receiver", String(rb.available));
  if (rb.available > 0n) await receiver.transfer({ receiverSparkAddress: await payer.getSparkAddress(), amountSats: Number(rb.available) });
} finally {
  await receiver.cleanup();
  await payer.cleanup();
}
