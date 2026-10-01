import "dotenv/config";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { loadMnemonicFromEnv } from "../../../lib/encrypted-seed.js";
import { SparkAgent } from "./spark-agent.js";

const network = process.env.SPARK_NETWORK || "MAINNET";

async function main() {
  const mnemonic = await loadMnemonicFromEnv();
  // One-shot script, so optimizeLeaves: false. A send below can start the SDK's
  // background leaf optimizer, and so can booting: the SDK claims any pending
  // inbound transfer in the background. cleanup() at exit would interrupt it
  // (references/wallet.md → Cleanup).
  const { agent } = await SparkAgent.create(mnemonic, network, { optimizeLeaves: false });

  console.log("=== Token Balances ===");
  const { sats, tokens } = await agent.getBalance();
  console.log("BTC:", sats, "sats\n");

  const tokenEntries = Object.entries(tokens);
  if (tokenEntries.length > 0) {
    for (const [id, info] of tokenEntries) {
      console.log(`Token: ${info.name} (${info.ticker})`);
      console.log(`  Identifier: ${id}`);
      console.log(`  Balance:    ${info.balance}`);
      console.log(`  Decimals:   ${info.decimals}`);
      console.log();
    }
  } else {
    console.log("No tokens held.\n");
  }

  // --- Transfer Tokens ---
  // dryRun signs nothing. Call again without dryRun to send.
  //
  // const preview = await agent.transferTokens({
  //   tokenIdentifier: "btkn1...",
  //   amount: 100n,
  //   to: "sp1p...",
  //   dryRun: true,
  // });
  // console.log(preview);
  // const tx = await agent.transferTokens({
  //   tokenIdentifier: "btkn1...",
  //   amount: 100n,
  //   to: "sp1p...",
  // });
  // console.log("Token transfer:", tx);

  // --- Batch Transfer ---
  // batchTransferTokens has no dryRun — uncommenting this sends. Preview each
  // recipient with transferTokens({ dryRun: true }) first.
  //
  // const txIds = await agent.batchTransferTokens([
  //   { tokenIdentifier: "btkn1...", tokenAmount: 50n, receiverSparkAddress: "sp1p..." },
  //   { tokenIdentifier: "btkn1...", tokenAmount: 50n, receiverSparkAddress: "sp1p..." },
  // ]);
  // console.log("Batch transfers:", txIds);

  // --- Token Invoice ---
  //
  // const invoice = await agent.createTokenInvoice("btkn1...", 100n, "Pay me in tokens");
  // console.log("Token invoice:", invoice);

  // --- Listen for Incoming Tokens ---
  // agent.onTransferReceived((transferId, updatedBalance) => {
  //   console.log(`Received transfer ${transferId}`);
  //   console.log("Updated balance:", updatedBalance);
  // });
  // console.log("Listening for incoming transfers... (Ctrl+C to stop)");
  // await new Promise(() => {}); // keep alive

  await agent.cleanup();
}

// Run main() only when executed directly (node script.js), not when this
// file is imported as a module. realpathSync handles symlinked invocations
// (e.g. via ~/.claude/skills); if argv[1] doesn't resolve to a real file it
// can't be this script.
const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
