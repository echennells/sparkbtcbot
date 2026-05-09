import "dotenv/config";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { loadMnemonicFromEnv } from "../../../lib/encrypted-seed.js";

const network = process.env.SPARK_NETWORK || "MAINNET";

async function main() {
  const mnemonic = await loadMnemonicFromEnv();
  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: mnemonic,
    options: { network },
  });

  // Check BTC balance
  const { satsBalance, tokenBalances } = await wallet.getBalance();
  console.log("=== Balance ===");
  console.log("BTC:", satsBalance.available.toString(), "sats");

  // Check token balances
  if (tokenBalances.size > 0) {
    console.log("\n=== Tokens ===");
    for (const [id, info] of tokenBalances) {
      const meta = info.tokenMetadata;
      console.log(`${meta.tokenName} (${meta.tokenTicker}): ${info.ownedBalance.toString()}`);
    }
  } else {
    console.log("\nNo token balances.");
  }

  // Generate deposit addresses
  console.log("\n=== Deposit Addresses ===");

  const staticAddr = await wallet.getStaticDepositAddress();
  console.log("Static (reusable):", staticAddr);

  const singleAddr = await wallet.getSingleUseDepositAddress();
  console.log("Single-use:       ", singleAddr);

  console.log("\nSend BTC to either address. Deposits need 3 L1 confirmations.");
  console.log("After confirmation, claim with:");
  console.log('  wallet.claimStaticDeposit({ transactionId: "txid", ... })');

  // List recent transfers
  const { transfers } = await wallet.getTransfers(5, 0);
  if (transfers.length > 0) {
    console.log("\n=== Recent Transfers ===");
    for (const tx of transfers) {
      console.log(`  ${tx.id}: ${tx.totalValue} sats [${tx.status}]`);
    }
  } else {
    console.log("\nNo transfers yet.");
  }

  wallet.cleanupConnections();
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
