// Prints balances only. Mnemonics stay in memory; nothing secret is logged.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { SparkWallet } from "/workspace/node_modules/@buildonspark/spark-sdk/dist/index.node.js";
import { loadMnemonic, readPassphraseFile } from "/workspace/lib/encrypted-seed.js";
import { sparkWalletOptions } from "/workspace/lib/wallet-options.js";

const dir = `${homedir()}/.spark/bepsi-test`;
const wallets = [
  ["seed.enc", await loadMnemonic({ passphrase: readPassphraseFile(`${dir}/passphrase`), path: `${dir}/seed.enc` })],
  ...Object.entries(JSON.parse(readFileSync(`${dir}/e2e-wallets.json`, "utf8"))).map(([k, v]) => [`e2e:${k}`, v]),
  ["flashnet-merchant", JSON.parse(readFileSync(`${dir}/flashnet-merchant.json`, "utf8")).mnemonic],
];
for (const [label, mnemonic] of wallets) {
  try {
    const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, options: sparkWalletOptions("MAINNET") });
    const { satsBalance, tokenBalances } = await wallet.getBalance();
    const tokens = [...tokenBalances.entries()].filter(([, t]) => t.ownedBalance > 0n)
      .map(([, t]) => `${t.ownedBalance} base units ${t.tokenMetadata.tokenTicker} (dec ${t.tokenMetadata.decimals})`);
    const pk = await wallet.getIdentityPublicKey();
    console.log(JSON.stringify({ label, idPubKey: pk.slice(0, 12) + "…", available: String(satsBalance.available), owned: String(satsBalance.owned), incoming: String(satsBalance.incoming), tokens }));
    await wallet.cleanupConnections?.();
  } catch (e) {
    console.log(JSON.stringify({ label, error: String(e?.message ?? e).slice(0, 200) }));
  }
}
process.exit(0);
