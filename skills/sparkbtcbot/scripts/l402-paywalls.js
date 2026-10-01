import "dotenv/config";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { loadMnemonicFromEnv } from "../../../lib/encrypted-seed.js";
import { SparkAgent } from "./spark-agent.js";

const network = process.env.SPARK_NETWORK || "MAINNET";

async function main() {
  const mnemonic = await loadMnemonicFromEnv();
  // One-shot script, so optimizeLeaves: false. A payment below can start the
  // SDK's background leaf optimizer, and so can booting: the SDK claims any
  // pending inbound transfer in the background. cleanup() at exit would
  // interrupt it (references/wallet.md → Cleanup).
  const { agent } = await SparkAgent.create(mnemonic, network, { optimizeLeaves: false });

  const { sats } = await agent.getBalance();
  console.log("Current balance:", sats, "sats\n");

  const L402_TEST_URL = "https://tassandra.laisee.org/price/USD";
  console.log("=== Preview L402 Cost ===");
  console.log(`Checking ${L402_TEST_URL}...`);
  const preview = await agent.previewL402(L402_TEST_URL);

  if (!preview.requiresPayment) {
    console.log("No payment required for this endpoint.\n");
  } else {
    console.log(`Payment required: ${preview.amountSats} sats`);
    console.log(`Invoice: ${preview.invoice.slice(0, 50)}...\n`);
  }

  // fetchL402 pays. It has no dryRun — passing dryRun throws, and omitting it
  // sends. The wrapper sizes the fee cap and refuses an amountless invoice or
  // one over maxAmountSats (default 10,000). It does not cache the macaroon: a
  // second call pays again. references/l402.md → Token Caching wraps it with a
  // per-host cache. Do not log `result.preimage`; it is the authorization secret.
  //
  // console.log("=== Fetch with L402 Payment ===");
  // const result = await agent.fetchL402(L402_TEST_URL);
  // console.log("Paid:", result.paid);
  // if (result.amountSats) console.log("Amount:", result.amountSats, "sats");
  // console.log("Data:", result.data);

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
