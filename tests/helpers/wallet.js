import { SparkWallet } from "@buildonspark/spark-sdk";

const NETWORK = "REGTEST";

const tracked = new Set();

export async function createTestWallet(opts = {}) {
  const { wallet, mnemonic } = await SparkWallet.initialize({
    mnemonicOrSeed: opts.mnemonic,
    options: { network: NETWORK },
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
