// Tracked invoices on hosted REGTEST, with real Lightning payments from the
// funded wallet: what getInvoiceStatus reports before, during and after a
// payment, for an invoice that expired, for a shop wallet that was offline
// while it was paid, and, for contrast, why createLightningInvoice's default
// Spark fallback can't be tracked. The receive statuses' meanings are inferred
// (references/wallet.md); these runs are what was actually observed.
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { SparkAgent } from "../../../skills/sparkbtcbot/scripts/spark-agent.js";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic, returnSats, waitForClaimed } from "../../helpers/wallet.js";

const fundedMnemonic = getFundedMnemonic();
const describeFunded = fundedMnemonic ? describe : describe.skip;
const PRICE = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Poll an invoice until `done(status)` or the deadline; returns every distinct
// state/status pair seen, in order, and the last status.
const watch = async (agent, id, done, { timeoutMs = 60_000, everyMs = 150 } = {}) => {
  const seen = [];
  const end = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < end) {
    last = await agent.getInvoiceStatus(id);
    const tag = `${last?.state}:${last?.status}`;
    if (seen.at(-1) !== tag) seen.push(tag);
    if (done(last)) break;
    await sleep(everyMs);
  }
  return { seen, last };
};

describeFunded("tracked invoices (REGTEST, real Lightning payments)", () => {
  const origVault = process.env.SPARK_LEAF_VAULT;
  let payerWallet, payer, payerAddress, shopWallets = [];

  beforeAll(async () => {
    process.env.SPARK_LEAF_VAULT = "off";
    ({ wallet: payerWallet } = await createTestWallet({ mnemonic: fundedMnemonic }));
    payer = new SparkAgent(payerWallet, "REGTEST");
    payerAddress = await payerWallet.getSparkAddress();
  }, 60_000);

  afterAll(async () => {
    if (origVault === undefined) delete process.env.SPARK_LEAF_VAULT;
    else process.env.SPARK_LEAF_VAULT = origVault;
    const readAvailable = async () => (await payerWallet.getBalance()).satsBalance.available;
    const before = await readAvailable();
    let returned = 0n;
    for (const w of shopWallets) returned += await returnSats(w, payerAddress);
    if (returned > 0n) await waitForClaimed(readAvailable, before + returned);
    await cleanupAllWallets();
  }, 180_000);

  const newShop = async (mnemonic) => {
    const { wallet, mnemonic: m } = await createTestWallet(mnemonic ? { mnemonic } : {});
    shopWallets.push(wallet);
    return { wallet, agent: new SparkAgent(wallet, "REGTEST"), mnemonic: m ?? mnemonic };
  };

  it("unpaid, then paid, when a SparkAgent pays it on its defaults; the states in between are recorded", async () => {
    const shop = await newShop();
    const order = await shop.agent.createTrackedInvoice(PRICE, "order-1", { expirySeconds: 600 });
    expect(await shop.agent.getInvoiceStatus(order.id)).toMatchObject({
      state: "unpaid", paid: false, customerCharged: false, expired: false, canReinvoice: false, amountSats: PRICE, paymentHash: order.paymentHash,
    });
    const watching = watch(shop.agent, order.id, (s) => s?.state === "paid");
    const paid = await payer.payAndSettle(order.invoice, { maxAmountSats: PRICE + 10 });
    expect(paid).toMatchObject({ settled: true });
    expect(paid.sparkDirect).toBeFalsy(); // no fallback in a tracked invoice: Lightning, even from a Spark wallet
    const { seen, last } = await watching;
    console.log("observed while paying:", seen.join(" → "));
    expect(last).toMatchObject({ state: "paid", paid: true, customerCharged: true, canReinvoice: false });
    expect(seen.every((t) => !t.startsWith("failed"))).toBe(true);
  }, 120_000);

  it("an expired one reads unpaid + expired, re-invoicing waits out the grace, and paying it charges nothing", async () => {
    const shop = await newShop();
    const order = await shop.agent.createTrackedInvoice(PRICE, "order-expired", { expirySeconds: 5 });
    await sleep(8_000);
    const now = await shop.agent.getInvoiceStatus(order.id);
    expect(now).toMatchObject({ state: "unpaid", expired: true, canReinvoice: false }); // inside the 2-minute grace
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.parse(order.expiresAt) + 3 * 60_000);
    try {
      expect(await shop.agent.getInvoiceStatus(order.id)).toMatchObject({ canReinvoice: true });
    } finally {
      clock.mockRestore();
    }
    // The first run of this test, before payLightningInvoice checked expiry:
    // the SDK locked 303 sats in a PREIMAGE_SWAP transfer stuck at
    // SENDER_KEY_TWEAK_PENDING (expiry 16 days out), then the SSP refused the
    // send ("RequestLightningSend failed"). Now nothing is sent.
    const before = (await payerWallet.getBalance()).satsBalance;
    await expect(payer.payAndSettle(order.invoice, { maxAmountSats: PRICE + 10 })).rejects.toMatchObject({ code: "INVOICE_EXPIRED" });
    await sleep(3_000);
    const after = (await payerWallet.getBalance()).satsBalance;
    expect({ available: after.available, owned: after.owned }, "an expired invoice locked or spent the payer's sats").toEqual({ available: before.available, owned: before.owned });
    expect(await shop.agent.getInvoiceStatus(order.id)).toMatchObject({ state: "unpaid", paid: false });
  }, 120_000);

  it("paid while the shop wallet was closed: reopened, it reads received or paid, then paid", async () => {
    const shop = await newShop();
    const order = await shop.agent.createTrackedInvoice(PRICE, "order-offline", { expirySeconds: 600 });
    await shop.wallet.cleanup(); // the shop goes offline
    const paid = await payer.payAndSettle(order.invoice, { maxAmountSats: PRICE + 10 });
    expect(paid).toMatchObject({ settled: true });
    const reopened = await newShop(shop.mnemonic);
    const first = await reopened.agent.getInvoiceStatus(order.id);
    console.log("first status after reopening:", `${first?.state}:${first?.status}`);
    expect(["received", "paid", "in_progress"]).toContain(first?.state);
    const { seen, last } = await watch(reopened.agent, order.id, (s) => s?.state === "paid");
    console.log("then:", seen.join(" → "));
    expect(last).toMatchObject({ state: "paid", customerCharged: true });
  }, 150_000);

  it("for contrast: createLightningInvoice's Spark fallback, paid Spark-direct, never reads paid though the sats arrive", async () => {
    const shop = await newShop();
    const raw = await shop.wallet.createLightningInvoice({ amountSats: PRICE, memo: "fallback", expirySeconds: 600, includeSparkAddress: true });
    const paid = await payer.payAndSettle(raw.invoice.encodedInvoice, { maxAmountSats: PRICE + 10 });
    expect(paid).toMatchObject({ settled: true, sparkDirect: true });
    const { last } = await watch(shop.agent, raw.id, (s) => s?.state === "paid", { timeoutMs: 20_000, everyMs: 1_000 });
    expect(last).toMatchObject({ state: "unpaid", paid: false });
    const end = Date.now() + 30_000;
    let balance = 0n;
    while (Date.now() < end && balance < BigInt(PRICE)) {
      balance = (await shop.wallet.getBalance()).satsBalance.available;
      await sleep(1_000);
    }
    expect(balance).toBe(BigInt(PRICE));
  }, 120_000);
});
