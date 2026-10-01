import { SparkWallet } from "@buildonspark/spark-sdk";

const NETWORK = "REGTEST";

const tracked = new Set();

// Leaf optimization OFF: test wallets are short-lived, and cleanup() kills the
// SDK's background optimizer mid-swap. The operators then hold the swapped
// leaves TRANSFER_LOCKED for a while, and the next file's send on the shared
// funded wallet fails ("leaf … is not available to transfer, status:
// TRANSFER_LOCKED" — seen 2026-09-30). Same remedy wallet.md → Cleanup gives
// one-shot scripts.
export async function createTestWallet(opts = {}) {
  const { wallet, mnemonic } = await SparkWallet.initialize({
    mnemonicOrSeed: opts.mnemonic,
    options: { network: NETWORK, optimizationOptions: { auto: false } },
  });
  tracked.add(wallet);
  return { wallet, mnemonic };
}

export async function cleanupAllWallets() {
  for (const w of tracked) {
    try {
      await w.cleanup();
    } catch {}
  }
  tracked.clear();
}

// Returns the funded REGTEST mnemonic from SPARK_TEST_MNEMONIC, or null if
// the funded tier is not enabled. Tests that need funds should `it.skip`
// when this returns null so CI without the secret stays green.
export function getFundedMnemonic() {
  const m = process.env.SPARK_TEST_MNEMONIC;
  if (!m || m.trim().split(/\s+/).length < 12) return null;
  return m.trim();
}
