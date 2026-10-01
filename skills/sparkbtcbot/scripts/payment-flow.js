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

  const { sats } = await agent.getBalance();
  console.log("Current balance:", sats, "sats\n");

  // createLightningInvoice returns the BOLT11 string. includeSparkAddress
  // defaults to true on the wrapper; the first invoice turns it off so the
  // two shapes are visible side by side.
  console.log("=== Create Lightning Invoice ===");
  const bolt11 = await agent.createLightningInvoice(1000, "Test payment - 1000 sats", {
    expirySeconds: 3600,
    includeSparkAddress: false,
  });
  console.log("BOLT11:", bolt11);
  console.log("Pay this invoice from any Lightning wallet.\n");

  console.log("=== Lightning Invoice (with Spark address) ===");
  const sparkBolt11 = await agent.createLightningInvoice(500, "Spark-preferred payment", {
    expirySeconds: 3600,
    includeSparkAddress: true,
  });
  console.log("BOLT11:", sparkBolt11);
  console.log("Spark-aware payers will route via Spark (free, instant).\n");

  console.log("=== Create Spark Invoice ===");
  const satsInvoice = await agent.createSatsInvoice(1000, "Spark native invoice");
  console.log("Spark Invoice:", satsInvoice);
  console.log("Only Spark-SDK code can pay this, via fulfillSparkInvoice. A consumer wallet cannot.\n");

  // --- Fee estimation (for paying a Lightning invoice) ---
  // Uncomment with a real BOLT11 invoice to test:
  //
  // const fee = await agent.estimateLightningFee("lnbc...", 1000);
  // console.log("Estimated Lightning fee:", fee, "sats");

  // --- Pay Lightning Invoice ---
  // dryRun signs nothing. Call again without dryRun to send. Omit maxFeeSats
  // and the wrapper sizes the fee cap from the invoice amount. Invoices over
  // maxAmountSats (default 10,000) are refused; pass a higher value to send more.
  //
  // const preview = await agent.payLightningInvoice("lnbc...", { dryRun: true });
  // console.log(preview);
  // const payment = await agent.payLightningInvoice("lnbc...");
  // console.log("Payment sent:", payment.id);

  // --- Spark-to-Spark Transfer ---
  // Same pattern: preview, then send. `to` is the receiver's Spark address.
  //
  // const transferPreview = await agent.transfer({ to: "sp1p...", amount: 100, dryRun: true });
  // console.log(transferPreview);
  // const transfer = await agent.transfer({ to: "sp1p...", amount: 100 });
  // console.log("Transfer:", transfer.id);

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
