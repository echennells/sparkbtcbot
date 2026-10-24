import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { FlashnetClient } from "@flashnet/sdk";
import { loadMnemonic } from "/workspace/lib/encrypted-seed.js";
import { sparkWalletOptions } from "/workspace/lib/wallet-options.js";
const BT = `${homedir()}/.spark/bepsi-test`;
const m = await loadMnemonic({ passphrase: readFileSync(`${BT}/passphrase`, "utf8").trim(), path: `${BT}/seed.enc` });
const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: m, options: sparkWalletOptions("MAINNET", { optimizationOptions: { auto: false } }) });
const j = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x));
const client = new FlashnetClient(wallet);
try {
  await client.initialize();
  console.log("initialized OK");
  for (const [name, fn] of [["features", () => client.getFeatureStatus()], ["minAmounts", () => client.getMinAmounts()], ["allowedAssets", () => client.getAllowedAssets()]]) {
    try { console.log(name, j(await fn()).slice(0, 1500)); } catch (e) { console.log(name, "ERR", e.message.slice(0, 200)); }
  }
  const pools = await client.listPools({ limit: 50 });
  console.log("pools:", pools.pools?.length ?? j(pools).slice(0, 300));
  for (const p of (pools.pools ?? []).slice(0, 50)) console.log(j({ id: p.lpPublicKey ?? p.poolId, a: p.assetAAddress ?? p.assetATokenPublicKey, b: p.assetBAddress ?? p.assetBTokenPublicKey, tvl: p.tvlAssetB ?? p.tvl, curve: p.curveType, keys: Object.keys(p).join(",") }).slice(0, 400));
} catch (e) {
  console.log("ERR", e.message.slice(0, 400));
}
await wallet.cleanup(); process.exit(0);
