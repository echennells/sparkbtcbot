import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { loadMnemonic } from "/workspace/lib/encrypted-seed.js";
import { sparkWalletOptions } from "/workspace/lib/wallet-options.js";
const BT = `${homedir()}/.spark/bepsi-test`;
const m = await loadMnemonic({ passphrase: readFileSync(`${BT}/passphrase`, "utf8").trim(), path: `${BT}/seed.enc` });
const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: m, options: sparkWalletOptions("MAINNET", { optimizationOptions: { auto: false } }) });
let b;
for (let i = 0; i < 8; i++) {
  b = await wallet.getBalance();
  if (b.satsBalance.owned > 0n && b.satsBalance.incoming === 0n) break;
  await new Promise((r) => setTimeout(r, 4000));
}
console.log("sats available", String(b.satsBalance.available), "owned", String(b.satsBalance.owned), "incoming", String(b.satsBalance.incoming));
console.log("tokens", [...b.tokenBalances].map(([id, t]) => `${t.tokenMetadata.tokenTicker}:${t.ownedBalance}`).join(", "));
const { transfers } = await wallet.getTransfers(5, 0);
for (const t of transfers ?? []) console.log("transfer", t.transferDirection, String(t.totalValue ?? t.valueReceivedByWallet ?? ""), t.status, t.type, t.createdTime);
await wallet.cleanup(); process.exit(0);
