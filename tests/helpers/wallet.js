import { SparkWallet } from "@buildonspark/spark-sdk";
import { sparkWalletOptions } from "../../lib/wallet-options.js";

const NETWORK = "REGTEST";

const tracked = new Set();

// Fee ladders off like every wallet the package opens (lib/wallet-options.js).
export async function createTestWallet(opts = {}) {
  const { wallet, mnemonic } = await SparkWallet.initialize({
    mnemonicOrSeed: opts.mnemonic,
    options: sparkWalletOptions(NETWORK),
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

// Poll until the wallet has claimed everything (incoming 0) and holds exactly
// `expected` (bigint), or the timeout passes; returns the last reading. Use a
// FRESH receiver per payment: mid-claim, available + incoming can read low or
// high, so a before/after delta on a busy wallet is not reliable.
export async function waitForSettled(wallet, expected, { timeoutMs = 45_000, everyMs = 1_500 } = {}) {
  const end = Date.now() + timeoutMs;
  let b;
  for (;;) {
    ({ satsBalance: b } = await wallet.getBalance());
    if ((b.incoming === 0n && b.available === expected) || Date.now() > end) return { available: b.available, incoming: b.incoming };
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// Send a throwaway wallet's claimed balance back to the funded wallet, so a
// run doesn't bleed the shared REGTEST float. Waits for incoming transfers to
// be claimed first. Returns the sats sent (0n if none, or on failure). Best
// effort: a failure is logged, never thrown.
export async function returnSats(wallet, toAddress) {
  try {
    const end = Date.now() + 30_000;
    let b;
    for (;;) {
      ({ satsBalance: b } = await wallet.getBalance());
      if (b.incoming === 0n || Date.now() > end) break;
      await new Promise((r) => setTimeout(r, 1_500));
    }
    if (b.available === 0n) return 0n;
    await wallet.transfer({ receiverSparkAddress: toAddress, amountSats: Number(b.available) });
    return b.available;
  } catch (err) {
    console.warn(`returnSats: could not return funds (${err?.message ?? err})`);
    return 0n;
  }
}

// After returning funds, wait until the funded wallet has CLAIMED them:
// `readAvailable()` (the funded wallet's available sats, bigint) reaches
// `target`. Otherwise the claim lands during the next test file and moves a
// balance that test is comparing (the funded privacy test did exactly that).
export async function waitForClaimed(readAvailable, target, { timeoutMs = 60_000, everyMs = 1_500 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if ((await readAvailable()) >= target || Date.now() > end) return;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
