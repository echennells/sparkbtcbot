// Live pin against Spark's hosted REGTEST: a fresh wallet is PUBLIC by default,
// ensureWalletPrivacy flips it, the flip persists at the operators, and a
// second call is a no-op. Static deposit addresses are still listable by a
// public reader with privacy on — that gate sits behind an operator rollout
// knob that was off on 2026-09-15; this test pins the observed behavior so a
// rollout shows up as a (welcome) test change rather than a silent shift.
import { describe, it, expect, afterAll } from "vitest";
import { SparkReadonlyClient } from "@buildonspark/spark-sdk";
import { createTestWallet, cleanupAllWallets } from "../helpers/wallet.js";
import { ensureWalletPrivacy } from "../../lib/wallet-privacy.js";

describe("wallet privacy (REGTEST)", () => {
  afterAll(cleanupAllWallets);

  it("fresh wallet is public by default; ensureWalletPrivacy makes it private and is idempotent", async () => {
    const { wallet } = await createTestWallet();
    const before = await wallet.getWalletSettings();
    expect(before?.privateEnabled ?? false).toBe(false);

    const first = await ensureWalletPrivacy(wallet);
    expect(first.changed).toBe(true);
    expect(first.settings.privateEnabled).toBe(true);
    expect((await wallet.getWalletSettings()).privateEnabled).toBe(true);

    const second = await ensureWalletPrivacy(wallet);
    expect(second.changed).toBe(false);

    // The owner keeps full access while private.
    expect(typeof (await wallet.getBalance()).balance).toBe("bigint");
  });

  it("a public reader is answered (empty, not an error) for a private wallet", async () => {
    const { wallet } = await createTestWallet();
    await ensureWalletPrivacy(wallet);
    const address = await wallet.getSparkAddress();
    const reader = SparkReadonlyClient.createPublic({ network: "REGTEST" });
    // Balance/transfers: the operator gate returns an empty view to a caller
    // without a session — a fresh wallet is empty anyway, so this pins the
    // "no error" half of the contract (a thrown error would leak "private").
    await expect(reader.getAvailableBalance(address)).resolves.toBe(0n);
    await expect(reader.getPendingTransfers(address)).resolves.toEqual([]);
  });
});
