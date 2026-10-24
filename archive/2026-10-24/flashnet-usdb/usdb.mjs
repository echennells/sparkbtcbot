import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SparkWallet, SparkReadonlyClient, encodeSparkAddress } from "@buildonspark/spark-sdk";
import { FlashnetClient } from "@flashnet/sdk";
import { loadMnemonic } from "/workspace/lib/encrypted-seed.js";
import { sparkWalletOptions } from "/workspace/lib/wallet-options.js";
import { fetchBtcPrice } from "/workspace/lib/fiat-rate.js";
const BT = `${homedir()}/.spark/bepsi-test`;
const m = await loadMnemonic({ passphrase: readFileSync(`${BT}/passphrase`, "utf8").trim(), path: `${BT}/seed.enc` });
const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: m, options: sparkWalletOptions("MAINNET", { optimizationOptions: { auto: false } }) });
const j = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? String(x) : x));
const b = await wallet.getBalance();
console.log("wallet sats:", String(b.satsBalance.available), "owned", String(b.satsBalance.owned), "tokens:", [...b.tokenBalances].map(([id, t]) => `${t.tokenMetadata.tokenTicker}:${t.ownedBalance}`).join(","));
const client = new FlashnetClient(wallet);
await client.initialize();
const USDBHEX = "3206c93b24a4d18ea19d0a9a213204af2c7e74a6d16c7535cc5d33eca4ad1eca";
const pools = await client.listPools({ assetAAddress: USDBHEX, limit: 50 }).catch((e) => ({ err: e.message }));
const list = (pools.pools ?? []).filter((p) => p.assetAAddress === USDBHEX || p.assetBAddress === USDBHEX).sort((x, y) => Number(BigInt(y.tvlAssetB ?? 0) - BigInt(x.tvlAssetB ?? 0)));
console.log("USDB pools:", list.length, pools.err ?? "");
for (const p of list.slice(0, 5)) console.log(j({ pool: p.lpPublicKey, curve: p.curveType, tvlSats: p.tvlAssetB, reserveA: p.assetAReserve, reserveB: p.assetBReserve, priceAInB: p.currentPriceAInB, lpFeeBps: p.lpFeeBps, hostFeeBps: p.hostFeeBps, vol24h: p.volume24hAssetB, host: p.hostName }));
if (list[0]) {
  const ro = SparkReadonlyClient.createPublic({ network: "MAINNET" });
  const tb = await ro.getTokenBalance(encodeSparkAddress({ identityPublicKey: list[0].lpPublicKey, network: "MAINNET" })).catch((e) => new Map([["err", { tokenMetadata: { tokenTicker: e.message.slice(0, 80) } }]]));
  for (const [id, t] of tb) console.log("pool holds", id, t.tokenMetadata?.tokenTicker, t.tokenMetadata?.tokenName, "decimals", t.tokenMetadata?.decimals);
  await ro.connectionManager?.closeConnections?.().catch(() => {});
}
const rate = await fetchBtcPrice().catch((e) => ({ err: e.message }));
console.log("BTC price:", j(rate).slice(0, 300));
await wallet.cleanup(); process.exit(0);
