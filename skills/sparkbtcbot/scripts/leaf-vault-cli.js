#!/usr/bin/env node
// CLI for the leaf-vault: `node leaf-vault-cli.js verify` checks the current
// bundle; no arg takes a snapshot using the encrypted-seed wallet. Kept separate
// from leaf-vault.js so importing the library never loads .env into the caller's
// process — dotenv/config below evaluates before ./leaf-vault.js by declaration
// order, so SPARK_LEAF_VAULT_PATH / SPARK_NETWORK from .env reach both branches.
import "dotenv/config";
import { snapshotLeafVault, verifyVault, reportedBalanceSats, judgeMissingVault } from "./leaf-vault.js";

// Back up the SAME wallet the operator funds and that SparkAgent's auto-vault
// backs up: the SDK's network-correct default (account 1 on MAINNET, 0 on
// REGTEST), which every other script uses by OMITTING accountNumber. So leave it
// undefined unless SPARK_ACCOUNT_NUMBER is set — hardcoding 0 would inspect a
// different, empty wallet on MAINNET and falsely report "nothing to back up".
const acctEnv = process.env.SPARK_ACCOUNT_NUMBER;
const accountNumber = acctEnv != null && acctEnv !== "" ? Number(acctEnv) : undefined;
if (accountNumber !== undefined && !Number.isInteger(accountNumber)) {
  console.error(`leaf-vault: SPARK_ACCOUNT_NUMBER="${acctEnv}" is not an integer.`);
  process.exit(2);
}
const acctLabel = accountNumber ?? "default";
const openWallet = async () => {
  const [{ SparkWallet }, { loadMnemonicFromEnv }] = await Promise.all([
    import("@buildonspark/spark-sdk"),
    import("../../../lib/encrypted-seed.js"),
  ]);
  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: await loadMnemonicFromEnv(),
    accountNumber,
    options: { network: process.env.SPARK_NETWORK || "MAINNET" },
  });
  return wallet;
};

if (process.argv[2] === "verify") {
  const r = await verifyVault();
  if (!r.missing) {
    console.log(r.ok ? "✅" : "❌", JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  }
  // No vault. Whether that is fine or an emergency depends on whether there is
  // anything to lose, so ask the wallet. If we cannot (no passphrase available,
  // e.g. verifying a bundle on a machine that holds no secrets), say INDETERMINATE
  // rather than guess — reporting "fine" would hide a real backup gap.
  let wallet;
  try {
    wallet = await openWallet();
  } catch (err) {
    console.log("⚠️ INDETERMINATE:", r.reason, `— cannot check balance to judge severity (${err.message}).`,
      "Set SPARK_PASSPHRASE to resolve, or treat as CRITICAL if this wallet is funded.");
    process.exit(2);
  }
  try {
    // Judge severity on OWNED sats, via the same helper the snapshot guards use.
    // Funds locked in an in-flight transfer are owned, still exitable, and
    // still need a backup, but would read as available=0 and hide the gap.
    const sats = await reportedBalanceSats(wallet);
    const { level, exitCode } = judgeMissingVault(sats);
    if (level === "INDETERMINATE") {
      console.log("⚠️ INDETERMINATE:", r.reason, "— could not read the wallet balance to judge severity.",
        "Treat as CRITICAL if this wallet is funded.");
    } else if (level === "CRITICAL") {
      console.log("❌ CRITICAL:", r.reason, `— but account ${acctLabel} holds ${sats} sats.`,
        "These funds have NO unilateral-exit backup. Take a snapshot now (`npm run leaf-vault`).");
    } else {
      console.log("✅ no vault, and nothing to back up:", `account ${acctLabel} holds 0 sats.`,
        "A vault will be written once the wallet holds leaves.");
    }
    process.exit(exitCode);
  } finally {
    await wallet.cleanup();
  }
} else {
  const wallet = await openWallet();
  try {
    console.log("✅ leaf-vault snapshot:", JSON.stringify(await snapshotLeafVault(wallet, { networkLabel: process.env.SPARK_NETWORK || "MAINNET" })));
  } finally {
    await wallet.cleanup();
  }
}
