// The privacy contract, observed with REAL sats (the read-only tier can only
// show "0 either way" on an empty wallet). Pins, with the funded wallet as
// owner: while private, an unauthenticated reader and a stranger's viewer key
// both see 0 sats and 0 transfers; the ONE granted viewer key sees the true
// balance; revoke drops it back to 0; and turning privacy off restores public
// reads. Also pins that the owner's own reads are never affected. The wallet
// is left PUBLIC at the end, the state the other funded tests assume.
// First observed 2026-09-15 on hosted REGTEST (98,289 → 0 → 98,801 via viewer).
import { describe, it, expect, afterAll } from "vitest";
import { SparkReadonlyClient, deriveViewerIdentityPublicKey } from "@buildonspark/spark-sdk";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic } from "../../helpers/wallet.js";
import { ensureWalletPrivacy } from "../../../lib/wallet-privacy.js";

const fundedMnemonic = getFundedMnemonic();
const itFunded = fundedMnemonic ? it : it.skip;
const NET = { network: "REGTEST" };

describe("wallet privacy with a funded wallet (REGTEST)", () => {
  afterAll(cleanupAllWallets);

  itFunded("private hides a non-zero balance from public and stranger readers; a granted viewer sees it; revoke and off restore", async () => {
    const { wallet: owner } = await createTestWallet({ mnemonic: fundedMnemonic });
    const address = await owner.getSparkAddress();
    const { mnemonic: viewerMn } = await createTestWallet();
    const { mnemonic: strangerMn } = await createTestWallet();
    const pub = SparkReadonlyClient.createPublic(NET);
    const asViewer = await SparkReadonlyClient.createWithViewerKey(NET, viewerMn);
    const asStranger = await SparkReadonlyClient.createWithViewerKey(NET, strangerMn);
    // The funded transfer/lightning tests run before this one in `test:all`,
    // so the wallet's leaves are typically mid-reshuffle (the SDK's optimizer
    // runs after every balance change). A single owner read and a single
    // viewer read can then straddle a swap and differ by one leaf denomination
    // (observed: 95,577 vs 96,601). Read until two consecutive owner readings
    // agree, then take the other views inside that quiet window — the
    // contract under test is who can SEE the balance, not the balance itself.
    const settledOwner = async () => {
      let prev = (await owner.getBalance()).satsBalance.available;
      for (let i = 0; i < 20; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const cur = (await owner.getBalance()).satsBalance.available;
        if (cur === prev) return cur;
        prev = cur;
      }
      return prev;
    };
    const snapshot = async () => {
      const own = await settledOwner();
      return {
        owner: own,
        pub: await pub.getAvailableBalance(address),
        viewer: await asViewer.getAvailableBalance(address),
        stranger: await asStranger.getAvailableBalance(address),
        pubTransfers: (await pub.getTransfers({ sparkAddress: address, limit: 5 })).transfers.length,
      };
    };

    try {
      await ensureWalletPrivacy(owner, { enabled: false });
      const open = await snapshot();
      expect(open.owner).toBeGreaterThan(0n); // the funded precondition
      expect(open.pub).toBe(open.owner);
      expect(open.stranger).toBe(open.owner);
      expect(open.pubTransfers).toBeGreaterThan(0);

      await ensureWalletPrivacy(owner);
      const closed = await snapshot();
      expect(closed.owner).toBe(open.owner); // owner unaffected
      expect(closed.pub).toBe(0n);           // hidden, as an EMPTY answer
      expect(closed.viewer).toBe(0n);        // no grant yet
      expect(closed.stranger).toBe(0n);
      expect(closed.pubTransfers).toBe(0);

      await owner.setViewerIdentityPublicKey(await deriveViewerIdentityPublicKey(NET, viewerMn));
      const granted = await snapshot();
      expect(granted.viewer).toBe(granted.owner); // the one granted key reads
      expect(granted.pub).toBe(0n);
      expect(granted.stranger).toBe(0n);

      await owner.clearViewerIdentityPublicKey();
      expect((await snapshot()).viewer).toBe(0n);
    } finally {
      await owner.clearViewerIdentityPublicKey().catch(() => {});
      await ensureWalletPrivacy(owner, { enabled: false }); // leave it public for the other funded tests
    }
    const reopened = await snapshot();
    expect(reopened.pub).toBe(reopened.owner);
  }, 180_000);
});
