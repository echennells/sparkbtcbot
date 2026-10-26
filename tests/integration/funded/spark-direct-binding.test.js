// Spark-direct vs a payment-hash binding, through SparkAgent, on REGTEST. An
// invoice from a Spark wallet carries a Spark fallback. Unbound, the agent
// pays it Spark-direct: a plain transfer, free. Bound to its payment hash
// (expectedPaymentHash, as a merchant checkout does), the same kind of
// invoice must go over Lightning and settle with a preimage that hashes to
// that hash, because a Spark-direct payment ignores the hash entirely.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { SparkAgent } from "../../../skills/sparkbtcbot/scripts/spark-agent.js";
import { invoicePaymentHash } from "../../../lib/bolt11.js";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic, waitForSettled, returnSats, waitForClaimed } from "../../helpers/wallet.js";

const fundedMnemonic = getFundedMnemonic();
const describeFunded = fundedMnemonic ? describe : describe.skip;
const AMOUNT = 1_000;

describeFunded("Spark-direct and the payment-hash binding (REGTEST)", () => {
  const origVault = process.env.SPARK_LEAF_VAULT;
  let payer;
  let payerAddress;
  let agent;
  const receivers = [];

  const sparkBackedInvoice = async () => {
    const { wallet } = await createTestWallet();
    receivers.push(wallet);
    const req = await wallet.createLightningInvoice({
      amountSats: AMOUNT,
      memo: "spark-direct binding test",
      expirySeconds: 600,
      includeSparkAddress: true,
    });
    return { wallet, invoice: req.invoice.encodedInvoice };
  };

  beforeAll(async () => {
    process.env.SPARK_LEAF_VAULT = "off"; // no backup files from this test
    ({ wallet: payer } = await createTestWallet({ mnemonic: fundedMnemonic }));
    payerAddress = await payer.getSparkAddress();
    agent = new SparkAgent(payer, "REGTEST");
  }, 60_000);

  afterAll(async () => {
    if (origVault === undefined) delete process.env.SPARK_LEAF_VAULT;
    else process.env.SPARK_LEAF_VAULT = origVault;
    const readAvailable = async () => (await payer.getBalance()).satsBalance.available;
    const before = await readAvailable();
    let returned = 0n;
    for (const w of receivers) returned += await returnSats(w, payerAddress);
    if (returned > 0n) await waitForClaimed(readAvailable, before + returned);
    await cleanupAllWallets();
  }, 180_000);

  it("unbound, a Spark wallet's invoice settles Spark-direct", async () => {
    const { wallet, invoice } = await sparkBackedInvoice();
    const preview = await agent.payLightningInvoice(invoice, { dryRun: true });
    expect(preview.preferSpark).toBe(true);
    const r = await agent.payLightningInvoice(invoice);
    // A WalletTransfer, not a LightningSendRequest: no invoice, no preimage.
    expect("encodedInvoice" in r).toBe(false);
    expect(r.paymentPreimage).toBeUndefined();
    expect(await waitForSettled(wallet, BigInt(AMOUNT), { timeoutMs: 60_000 })).toEqual({ available: BigInt(AMOUNT), incoming: 0n });
  }, 120_000);

  it("payAndSettle returns a Spark-direct payment at once, settled, with no preimage", async () => {
    // It used to poll Lightning status with the transfer id for the whole
    // maxPolls window (90 s here) and then report settled: false.
    const { wallet, invoice } = await sparkBackedInvoice();
    const t0 = Date.now();
    const r = await agent.payAndSettle(invoice, { pollMs: 2_000, maxPolls: 45 });
    expect(r).toMatchObject({ settled: true, sparkDirect: true, paymentPreimage: null });
    expect(Date.now() - t0).toBeLessThan(30_000);
    expect(await waitForSettled(wallet, BigInt(AMOUNT), { timeoutMs: 60_000 })).toEqual({ available: BigInt(AMOUNT), incoming: 0n });
  }, 120_000);

  it("bound to its payment hash, the same kind of invoice goes over Lightning and settles", async () => {
    const { wallet, invoice } = await sparkBackedInvoice();
    const hash = invoicePaymentHash(invoice);
    const preview = await agent.payLightningInvoice(invoice, { dryRun: true, expectedPaymentHash: hash });
    expect(preview.preferSpark).toBe(false);
    const r = await agent.payAndSettle(invoice, { expectedPaymentHash: hash, pollMs: 2_000, maxPolls: 45 });
    expect(r.encodedInvoice?.toLowerCase()).toBe(invoice.toLowerCase());
    expect(r.settled).toBe(true);
    expect(createHash("sha256").update(Buffer.from(r.paymentPreimage, "hex")).digest("hex")).toBe(hash);
    expect(await waitForSettled(wallet, BigInt(AMOUNT), { timeoutMs: 90_000 })).toEqual({ available: BigInt(AMOUNT), incoming: 0n });
  }, 180_000);

  it("refuses a checkout hash the invoice doesn't carry, before paying", async () => {
    const { wallet, invoice } = await sparkBackedInvoice();
    await expect(agent.payAndSettle(invoice, { expectedPaymentHash: "bb".repeat(32) })).rejects.toThrow(/Payment blocked/);
    expect((await wallet.getBalance()).satsBalance).toMatchObject({ available: 0n, incoming: 0n });
  }, 60_000);
});
