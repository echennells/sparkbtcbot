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
const FUNDING = 2_000n;

// An amount these leaves can't make, with up to `slack` sats of fee on top: a
// fixed amount only swaps if the leaves happen not to fit it.
const amountNeedingSwap = async (wallet, slack) => {
  const values = (await wallet.getLeaves()).map((l) => Number(l.value));
  const sums = values.reduce((all, v) => new Set([...all, ...[...all].map((s) => s + v)]), new Set([0]));
  for (let amount = 300; amount < Number(FUNDING); amount++) {
    if (!Array.from({ length: slack + 1 }, (_, fee) => amount + fee).some((total) => sums.has(total))) return amount;
  }
  throw new Error(`no amount needs a swap with leaves ${values}`);
};

class CountingSigner extends DefaultSparkSigner {
  v2 = 0;
  async signFrost(params) {
    if (params.adaptorV2) this.v2++;
    return super.signFrost(params);
  }
}

describeFunded("leaf swaps on version 2 adaptor signing (REGTEST)", () => {
  const savedVault = process.env.SPARK_LEAF_VAULT;
  const wallets = []; // everything that may hold sats: returned in afterAll, whatever failed
  let funded;
  let fundedAddress;

  // The optimizer off: left on, it swaps as the funding arrives, and the send
  // then finds exact leaves and never swaps.
  const fundPayer = async () => {
    const signer = new CountingSigner();
    const { wallet } = await createTestWallet({ signer, walletOptions: { optimizationOptions: { auto: false } } });
    wallets.push(wallet);
    await funded.transfer({ receiverSparkAddress: await wallet.getSparkAddress(), amountSats: Number(FUNDING) });
    expect(await waitForSettled(wallet, FUNDING, { timeoutMs: 60_000 })).toEqual({ available: FUNDING, incoming: 0n });
    return { wallet, signer, agent: new SparkAgent(wallet, "REGTEST") };
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
      for (const wallet of wallets) returned += await returnSats(wallet, fundedAddress);
      if (returned > 0n) await waitForClaimed(readAvailable, before + returned);
    } finally {
      await cleanupAllWallets();
      if (savedVault === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = savedVault;
    }
  }, 180_000);

  it("a Spark transfer that doesn't match the leaves swaps, and arrives", async () => {
    const { wallet, signer, agent } = await fundPayer();
    expect(signer.v2).toBe(0);
    const amount = await amountNeedingSwap(wallet, 0);
    const { wallet: receiver } = await createTestWallet();
    wallets.push(receiver);
    await agent.transfer({ to: await receiver.getSparkAddress(), amount });
    expect(signer.v2).toBeGreaterThan(0);
    expect(await waitForSettled(receiver, BigInt(amount), { timeoutMs: 60_000 })).toEqual({ available: BigInt(amount), incoming: 0n });
  }, 180_000);

  it("a Lightning send that doesn't match the leaves swaps, and settles with its proof", async () => {
    const { wallet, signer, agent } = await fundPayer();
    expect(signer.v2).toBe(0);
    const amount = await amountNeedingSwap(wallet, 8); // the fee on a few hundred sats is a few sats
    const { wallet: receiver } = await createTestWallet();
    wallets.push(receiver);
    const req = await receiver.createLightningInvoice({ amountSats: amount, memo: "swap test", expirySeconds: 600 });
    const paid = await agent.payAndSettle(req.invoice.encodedInvoice, { preferSpark: false, maxAmountSats: amount, maxFeeSats: 50 });
    expect(paid).toMatchObject({ settled: true });
    expect(paid.paymentPreimage).toBeTruthy();
    expect(signer.v2).toBeGreaterThan(0);
    expect(await waitForSettled(receiver, BigInt(amount), { timeoutMs: 60_000 })).toEqual({ available: BigInt(amount), incoming: 0n });
  }, 180_000);
});
