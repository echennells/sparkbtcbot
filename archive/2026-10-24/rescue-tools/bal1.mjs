// Balance of one encrypted seed: node bal1.mjs <seed.enc> <passphrase-file> <NETWORK>. Prints no secrets.
import { SparkWallet } from "/workspace/node_modules/@buildonspark/spark-sdk/dist/index.node.js";
import { loadMnemonic, readPassphraseFile } from "/workspace/lib/encrypted-seed.js";
import { sparkWalletOptions } from "/workspace/lib/wallet-options.js";
const [seed, pass, net] = process.argv.slice(2);
const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: await loadMnemonic({ passphrase: readPassphraseFile(pass), path: seed }), options: sparkWalletOptions(net) });
const { satsBalance, tokenBalances } = await wallet.getBalance();
console.log(JSON.stringify({ address: await wallet.getSparkAddress(), available: String(satsBalance.available), owned: String(satsBalance.owned), incoming: String(satsBalance.incoming),
  tokens: [...tokenBalances.values()].filter((t) => t.ownedBalance > 0n).map((t) => `${t.ownedBalance} ${t.tokenMetadata.tokenTicker}`) }));
process.exit(0);
