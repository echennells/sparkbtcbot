import "dotenv/config";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { loadMnemonicFromEnv } from "../../../lib/encrypted-seed.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const network = process.env.SPARK_NETWORK || "MAINNET";

async function main() {
  const mnemonic = await loadMnemonicFromEnv();
  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: mnemonic,
    options: { network },
  });

  // --- Token Balances ---
  console.log("=== Token Balances ===");
  const { satsBalance, tokenBalances } = await wallet.getBalance();
  console.log("BTC:", satsBalance.available.toString(), "sats\n");

  if (tokenBalances.size > 0) {
    for (const [id, info] of tokenBalances) {
      const meta = info.tokenMetadata;
      console.log(`Token: ${meta.tokenName} (${meta.tokenTicker})`);
      console.log(`  Identifier: ${id}`);
      console.log(`  Balance:    ${info.ownedBalance.toString()}`);
      console.log(`  Decimals:   ${meta.decimals}`);
      console.log(`  Max Supply: ${meta.maxSupply.toString()}`);
      console.log();
    }
  } else {
    console.log("No tokens held.\n");
  }

  // --- Transfer Tokens ---
  // Uncomment with real values to send tokens:
  //
  // const txId = await wallet.transferTokens({
  //   tokenIdentifier: "btkn1...",
  //   tokenAmount: 100n,
  //   receiverSparkAddress: "sp1p...",
  // });
  // console.log("Token transfer:", txId);

  // --- Batch Transfer ---
  // Send tokens to multiple recipients in one call:
  //
  // const txIds = await wallet.batchTransferTokens([
  //   { tokenIdentifier: "btkn1...", tokenAmount: 50n, receiverSparkAddress: "sp1p..." },
  //   { tokenIdentifier: "btkn1...", tokenAmount: 50n, receiverSparkAddress: "sp1p..." },
  // ]);
  // console.log("Batch transfers:", txIds);

  // --- Token Invoice ---
  // Request payment in a specific token:
  //
  // const invoice = await wallet.createTokensInvoice({
  //   amount: 100n,
  //   tokenIdentifier: "btkn1...",
  //   memo: "Pay me in tokens",
  // });
  // console.log("Token invoice:", invoice);

  // --- Listen for Incoming Tokens ---
  // wallet.on("transfer:claimed", (transferId, updatedBalance) => {
  //   console.log(`Received transfer ${transferId}`);
  //   console.log("Updated balance:", updatedBalance);
  // });
  // console.log("Listening for incoming transfers... (Ctrl+C to stop)");
  // await new Promise(() => {}); // keep alive

  wallet.cleanup();
}

// Run main() only when executed directly (node script.js), not when this
// file is imported as a module. realpathSync handles symlinked invocations
// (e.g. via ~/.claude/skills).
const isMainModule =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isMainModule) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
