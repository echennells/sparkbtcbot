import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic, waitForSettled, returnSats, waitForClaimed } from "../../helpers/wallet.js";

const fundedMnemonic = getFundedMnemonic();
const itFunded = fundedMnemonic ? it : it.skip;

describe("funded lightning (REGTEST)", () => {
  let funded;
  let receiver;

  beforeAll(async () => {
    if (!fundedMnemonic) return;
    ({ wallet: funded } = await createTestWallet({ mnemonic: fundedMnemonic }));
    ({ wallet: receiver } = await createTestWallet());
  });

  // Send the receiver's sats back: without this, every funded run stranded
  // the 1,000 sats in a throwaway wallet that never claimed them.
  afterAll(async () => {
    if (funded && receiver) {
      const readAvailable = async () => (await funded.getBalance()).satsBalance.available;
      const before = await readAvailable();
      const returned = await returnSats(receiver, await funded.getSparkAddress());
      if (returned > 0n) await waitForClaimed(readAvailable, before + returned);
    }
    await cleanupAllWallets();
  }, 120_000);

  itFunded("estimates a Lightning send fee", async () => {
    const inv = await receiver.createLightningInvoice({
      amountSats: 1000,
      memo: "fee estimate target",
      expirySeconds: 600,
    });
    const fee = await funded.getLightningSendFeeEstimate({
      encodedInvoice: inv.invoice.encodedInvoice,
    });
    expect(fee).toBeDefined();
  });

  itFunded("pays a Lightning invoice (Spark-preferred routing)", async () => {
    const inv = await receiver.createLightningInvoice({
      amountSats: 1000,
      memo: "funded payment test",
      expirySeconds: 600,
      includeSparkAddress: true,
    });
    const payment = await funded.payLightningInvoice({
      invoice: inv.invoice.encodedInvoice,
      maxFeeSats: 10,
      preferSpark: true,
    });
    expect(payment).toBeDefined();
    expect(await waitForSettled(receiver, 1000n, { timeoutMs: 60_000 })).toEqual({ available: 1000n, incoming: 0n });
  }, 90_000);
});
