import "dotenv/config";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { loadMnemonicFromEnv } from "../../../lib/encrypted-seed.js";
import { SparkAgent } from "./spark-agent.js";

const network = process.env.SPARK_NETWORK || "MAINNET";

async function main() {
  const mnemonic = await loadMnemonicFromEnv();
  // One-shot script, so optimizeLeaves: false. Nothing here moves value, but
  // booting does: the SDK claims any pending inbound transfer in the
  // background, and a claim can start its leaf optimizer. cleanup() at exit
  // would interrupt it (references/wallet.md → Cleanup).
  const { agent } = await SparkAgent.create(mnemonic, network, { optimizeLeaves: false });

  // Claimed, spendable balance. A confirmed L1 deposit that has not been
  // claimed yet is not in this number — see listPendingDeposits() below.
  const { sats, tokens } = await agent.getBalance();
  console.log("=== Balance ===");
  console.log("BTC:", sats, "sats");

  const tokenEntries = Object.entries(tokens);
  if (tokenEntries.length > 0) {
    console.log("\n=== Tokens ===");
    for (const [id, info] of tokenEntries) {
      console.log(`${info.name} (${info.ticker}): ${info.balance} [${id}]`);
    }
  } else {
    console.log("\nNo token balances.");
  }

  console.log("\n=== Deposit Addresses ===");
  console.log("Static (reusable):", await agent.getDepositAddress());
  console.log("Single-use:       ", await agent.getSingleUseDepositAddress());
  console.log("\nSend BTC to either address. Deposits need 3 L1 confirmations.");

  console.log("\n=== Unclaimed deposits (confirmed, waiting to be claimed) ===");
  const pending = await agent.listPendingDeposits();
  if (pending.length === 0) {
    console.log("  none yet — nothing confirmed-and-unclaimed (keep waiting after you send).");
  } else {
    for (const d of pending) {
      console.log(`  ${d.txid}:${d.vout}  at ${d.address}`);
      console.log(`    preview: agent.claimDeposit({ txid: "${d.txid}", vout: ${d.vout}, dryRun: true })`);
    }
  }

  const { transfers } = await agent.getTransfers(5, 0);
  if (transfers.length > 0) {
    console.log("\n=== Recent Transfers ===");
    for (const tx of transfers) {
      // valueReceivedByWallet / valueSentByWallet (SDK >= 0.12) are THIS wallet's
      // share; the deprecated totalValue is the whole transfer across every
      // receiver and over-reports on multi-receiver transfers.
      const amount = tx.valueReceivedByWallet || tx.valueSentByWallet || 0;
      console.log(`  ${tx.id}: ${amount} sats [${tx.status}]`);
    }
  } else {
    console.log("\nNo transfers yet.");
  }

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
