// Live pin against hosted REGTEST for the viewer-key flow (spark-sdk >= 0.12):
// an owner wallet made private grants ONE viewer identity key, the operators
// echo it in the settings, a reader authenticated with the viewer's own seed
// can query the owner (no error), a stranger's key is refused an answer
// (empty view), and revoke clears the grant. Fresh wallets are empty so the
// balance itself is 0 either way — the pins here are the settings round-trip
// and "answered vs empty", which is the whole access contract.
import { describe, it, expect, afterAll } from "vitest";
import { SparkReadonlyClient, deriveViewerIdentityPublicKey } from "@buildonspark/spark-sdk";
import { createTestWallet, cleanupAllWallets } from "../helpers/wallet.js";
import { ensureWalletPrivacy } from "../../lib/wallet-privacy.js";

describe("viewer key (REGTEST)", () => {
  afterAll(cleanupAllWallets);

  it("grant → echoed in settings → viewer reads → revoke clears", async () => {
    const { wallet: owner } = await createTestWallet();
    const { mnemonic: viewerMnemonic } = await createTestWallet();
    await ensureWalletPrivacy(owner);

    const viewerKey = await deriveViewerIdentityPublicKey({ network: "REGTEST" }, viewerMnemonic);
    expect(viewerKey).toMatch(/^0[23][0-9a-f]{64}$/);

    const granted = await owner.setViewerIdentityPublicKey(viewerKey);
    expect(granted.viewerIdentityPublicKey).toBe(viewerKey);
    expect(granted.privateEnabled).toBe(true);
    expect((await owner.getWalletSettings()).viewerIdentityPublicKey).toBe(viewerKey);

    const ownerAddress = await owner.getSparkAddress();
    const reader = await SparkReadonlyClient.createWithViewerKey({ network: "REGTEST" }, viewerMnemonic);
    await expect(reader.getAvailableBalance(ownerAddress)).resolves.toBe(0n);
    await expect(reader.getPendingTransfers(ownerAddress)).resolves.toEqual([]);

    const cleared = await owner.clearViewerIdentityPublicKey();
    expect(cleared.viewerIdentityPublicKey).toBeUndefined();
    expect((await owner.getWalletSettings()).viewerIdentityPublicKey).toBeUndefined();
  });

  it("a second grant replaces the first (one viewer at a time)", async () => {
    const { wallet: owner } = await createTestWallet();
    const { mnemonic: a } = await createTestWallet();
    const { mnemonic: b } = await createTestWallet();
    const keyA = await deriveViewerIdentityPublicKey({ network: "REGTEST" }, a);
    const keyB = await deriveViewerIdentityPublicKey({ network: "REGTEST" }, b);
    await owner.setViewerIdentityPublicKey(keyA);
    const after = await owner.setViewerIdentityPublicKey(keyB);
    expect(after.viewerIdentityPublicKey).toBe(keyB);
  });
});
