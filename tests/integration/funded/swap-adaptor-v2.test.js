// SDK 0.15 moved leaf swaps to version 2 adaptor signing: `transfer.ts` sets
// adaptorV2 on the operator call, and the signing binaries changed. The notes
// don't say how long the operators keep version 1, and a payment that doesn't
// match the wallet's leaves swaps first, so this is on every money path. This
// proves the path runs against the hosted operators: a wrapped signer counts
// the version 2 adaptor signatures, so a send that never swapped can't pass.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DefaultSparkSigner } from "@buildonspark/spark-sdk";
import { SparkAgent } from "../../../skills/sparkbtcbot/scripts/spark-agent.js";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic, waitForSettled, returnSats, waitForClaimed } from "../../helpers/wallet.js";

const fundedMnemonic = getFundedMnemonic();
const describeFunded = fundedMnemonic ? describe : describe.skip;
const FUNDING = 4_000n;

class CountingSigner extends DefaultSparkSigner {
  v2 = 0;
  async signFrost(params) {
    if (params.adaptorV2) this.v2++;
    return super.signFrost(params);
  }
}

describeFunded("leaf swaps on version 2 adaptor signing (REGTEST)", () => {
  const savedVault = process.env.SPARK_LEAF_VAULT;
  const payers = [];
  let funded;
  let fundedAddress;

  // The optimizer off: left on, it swaps as the funding arrives, and the send
  // then finds exact leaves and never swaps.
  const fundPayer = async () => {
    const signer = new CountingSigner();
    const { wallet } = await createTestWallet({ signer, walletOptions: { optimizationOptions: { auto: false } } });
    payers.push(wallet);
    await funded.transfer({ receiverSparkAddress: await wallet.getSparkAddress(), amountSats: Number(FUNDING) });
    expect(await waitForSettled(wallet, FUNDING, { timeoutMs: 60_000 })).toEqual({ available: FUNDING, incoming: 0n });
    return { signer, agent: new SparkAgent(wallet, "REGTEST") };
  };

  beforeAll(async () => {
    process.env.SPARK_LEAF_VAULT = "off";
    ({ wallet: funded } = await createTestWallet({ mnemonic: fundedMnemonic }));
    fundedAddress = await funded.getSparkAddress();
  }, 120_000);

  afterAll(async () => {
    try {
      const readAvailable = async () => (await funded.getBalance()).satsBalance.available;
      const before = await readAvailable();
      let returned = 0n;
      for (const wallet of payers) returned += await returnSats(wallet, fundedAddress);
      if (returned > 0n) await waitForClaimed(readAvailable, before + returned);
    } finally {
      await cleanupAllWallets();
      if (savedVault === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = savedVault;
    }
  }, 180_000);

  it("a Spark transfer that doesn't match the leaves swaps, and arrives", async () => {
    const { signer, agent } = await fundPayer();
    expect(signer.v2).toBe(0);
    const { wallet: receiver } = await createTestWallet();
    await agent.transfer({ to: await receiver.getSparkAddress(), amount: 777 });
    expect(signer.v2).toBeGreaterThan(0);
    expect(await waitForSettled(receiver, 777n, { timeoutMs: 60_000 })).toEqual({ available: 777n, incoming: 0n });
    await returnSats(receiver, fundedAddress);
  }, 180_000);

  it("a Lightning send that doesn't match the leaves swaps, and settles with its proof", async () => {
    const { signer, agent } = await fundPayer();
    expect(signer.v2).toBe(0);
    const { wallet: receiver } = await createTestWallet();
    const req = await receiver.createLightningInvoice({ amountSats: 333, memo: "swap test", expirySeconds: 600 });
    const paid = await agent.payAndSettle(req.invoice.encodedInvoice, { preferSpark: false, maxAmountSats: 333, maxFeeSats: 50 });
    expect(paid).toMatchObject({ settled: true });
    expect(paid.paymentPreimage).toBeTruthy();
    expect(signer.v2).toBeGreaterThan(0);
    expect(await waitForSettled(receiver, 333n, { timeoutMs: 60_000 })).toEqual({ available: 333n, incoming: 0n });
    await returnSats(receiver, fundedAddress);
  }, 180_000);
});
