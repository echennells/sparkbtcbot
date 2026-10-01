import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic } from "../../helpers/wallet.js";
import { waitForSats, returnSats, waitForClaimed } from "../../helpers/agent.js";

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

  afterAll(async () => {
    if (funded) {
      const readAvailable = async () => (await funded.getBalance()).satsBalance.available;
      const before = await readAvailable();
      await waitForClaimed(readAvailable, before + (await returnSats(receiver, await funded.getSparkAddress())));
    }
    await cleanupAllWallets();
  }, 90_000);

  itFunded("estimates a Lightning send fee", async () => {
    const inv = await receiver.createLightningInvoice({
      amountSats: 1000,
      memo: "fee estimate target",
      expirySeconds: 600,
    });
    const fee = await funded.getLightningSendFeeEstimate({
      encodedInvoice: inv.invoice.encodedInvoice,
    });
    expect(typeof fee).toBe("number");
    expect(fee).toBeGreaterThanOrEqual(0);
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
    // the receiver actually got it — exactly the amount
    const b = await waitForSats(receiver, 1000n);
    expect(b.available + b.incoming).toBe(1000n);
  });
});
