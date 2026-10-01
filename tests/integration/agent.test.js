// SparkAgent against REGTEST with an UNFUNDED wallet: everything the wrapper
// does before money moves. Real SDK errors, not mocks — the refund rules in
// lib/payment-outcome.js are only as good as the messages the SDK really
// raises, and the unit tests can only fake those.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { decodeSparkAddress, encodeSparkAddress } from "@buildonspark/spark-sdk";
import { createTestAgent, cleanupAllAgents } from "../helpers/agent.js";
import { createTestWallet, cleanupAllWallets } from "../helpers/wallet.js";
import { decodeInvoiceSats } from "../../lib/bolt11.js";

describe("SparkAgent on REGTEST, unfunded", () => {
  let agent;
  let auditLines;
  let other; // a second wallet to address sends and invoices to
  let otherAddress;

  beforeAll(async () => {
    // a budget, so every send goes through the spend ledger and a refund is visible
    ({ agent, auditLines } = await createTestAgent({ env: { SPARK_DAILY_BUDGET_SATS: "100000" } }));
    ({ wallet: other } = await createTestWallet());
    otherAddress = await other.getSparkAddress();
  }, 90_000);

  afterAll(async () => {
    await cleanupAllAgents();
    await cleanupAllWallets();
  });

  describe("reads", () => {
    it("identity and a normalized, empty balance", async () => {
      const { address, publicKey } = await agent.getIdentity();
      expect(address).toMatch(/^sparkrt1/);
      expect(publicKey).toMatch(/^[0-9a-f]{66}$/);
      expect(decodeSparkAddress(address, "REGTEST").identityPublicKey).toBe(publicKey);
      expect(await agent.getBalance()).toEqual({ sats: "0", tokens: {} });
    });

    it("policy() and spendStatus() report the env budget and uncapped tokens", async () => {
      const p = await agent.policy();
      expect(p.sealed).toBeNull();
      expect(p.budget).toMatchObject({ spentSats: 0, budgetSats: 100000, remainingSats: 100000 });
      expect(p.tokens).toMatchObject({ limited: false });
    });

    it("a deposit address and no pending deposits", async () => {
      expect(await agent.getDepositAddress()).toMatch(/^bcrt1/);
      expect(await agent.listPendingDeposits()).toEqual([]);
    });

    it("invoices it creates decode to itself", async () => {
      const { publicKey } = await agent.getIdentity();
      const invoice = await agent.createSatsInvoice(1234, "agent invoice");
      expect(decodeSparkAddress(invoice, "REGTEST")).toMatchObject({
        identityPublicKey: publicKey,
        sparkInvoiceFields: { paymentType: { type: "sats", amount: 1234 }, memo: "agent invoice" },
      });
      const bolt11 = await agent.createLightningInvoice(2345, "agent ln");
      expect(bolt11).toMatch(/^lnbcrt/);
      expect(decodeInvoiceSats(bolt11)).toBe(2345);
    });
  });

  describe("dry runs: a real preview, nothing recorded", () => {
    it("transfer", async () => {
      const preview = await agent.transfer({ to: otherAddress, amount: 100, dryRun: true });
      expect(preview).toMatchObject({ dryRun: true, operation: "spark_transfer", to: otherAddress, amount: "100", estimatedFee: "0" });
    });

    it("fulfillInvoice decodes who gets paid and how much", async () => {
      const invoice = await other.createSatsInvoice({ amount: 777 });
      const preview = await agent.fulfillInvoice([{ invoice }], { dryRun: true });
      expect(preview.entries).toEqual([{ invoice, to: otherAddress, amount: "777", type: "sats" }]);
    });

    it("payLightningInvoice gets a real fee estimate and states the caps", async () => {
      const { invoice } = await other.createLightningInvoice({ amountSats: 1000, memo: "dry", expirySeconds: 600 });
      const preview = await agent.payLightningInvoice(invoice.encodedInvoice, { dryRun: true });
      expect(preview).toMatchObject({ dryRun: true, operation: "lightning_pay", withinCap: true, maxAmountSats: "10000" });
      expect(Number(preview.estimatedFee)).toBeGreaterThanOrEqual(0);
    });

    it("left the ledger and the audit log empty", async () => {
      expect((await agent.spendStatus()).spentSats).toBe(0);
      expect(await auditLines()).toEqual([]);
    });
  });

  // Each of these is recorded against the budget, then the real SDK refuses it
  // before sending. The error must be on the pre-send list, so the spend is
  // refunded and audited "error" — not left counted as PAYMENT_COMMITTED.
  describe("real SDK refusals refund the spend", () => {
    const refunded = async (send, message) => {
      const before = (await auditLines()).length;
      await expect(send()).rejects.toMatchObject({ name: "SparkValidationError", message: expect.stringMatching(message) });
      expect((await agent.spendStatus()).spentSats).toBe(0);
      const lines = (await auditLines()).slice(before);
      expect(lines.at(-1)).toMatchObject({ verdict: "allow", result: "error" });
    };

    it("not enough balance", () =>
      refunded(() => agent.transfer({ to: otherAddress, amount: 100 }), /^Total target amount exceeds available balance/));

    it("a Spark invoice passed to transfer()", async () => {
      const invoice = await other.createSatsInvoice({ amount: 100 });
      await refunded(() => agent.transfer({ to: invoice, amount: 100 }), /^Spark address is a Spark invoice/);
    });

    it("a malformed address", () =>
      refunded(() => agent.transfer({ to: "sparkrt1notanaddress", amount: 100 }), /^Failed to decode Spark address/));

    it("another network's address", () => {
      const mainnet = encodeSparkAddress({ identityPublicKey: decodeSparkAddress(otherAddress, "REGTEST").identityPublicKey, network: "MAINNET" });
      return refunded(() => agent.transfer({ to: mainnet, amount: 100 }), /^Invalid Spark address prefix/);
    });
  });

  // The SDK does not throw for an invalid invoice: it returns { invalidInvoices }
  // before sending anything. fulfillInvoice used to treat that as success,
  // leaving the spend counted and the audit "ok".
  it("an expired Spark invoice is refused and refunded (the SDK returns it, it doesn't throw)", async () => {
    const invoice = await other.createSatsInvoice({ amount: 300, expiryTime: new Date(Date.now() + 2_000) });
    await new Promise((r) => setTimeout(r, 4_000));
    const spentBefore = (await agent.spendStatus()).spentSats;
    await expect(agent.fulfillInvoice([{ invoice }])).rejects.toMatchObject({
      code: "INVOICE_REFUSED",
      invalidInvoices: [{ invoice, reason: expect.stringMatching(/expired/i) }],
    });
    expect((await agent.spendStatus()).spentSats).toBe(spentBefore);
    expect((await auditLines()).at(-1)).toMatchObject({ op: "fulfill_spark_invoice", result: "error" });
  });

  it("an amountless Spark invoice with no amount is refused up front, with a message that says what to pass", async () => {
    const invoice = await other.createSatsInvoice({ memo: "no amount" });
    const { agent: noBudget } = await createTestAgent();
    await expect(noBudget.fulfillInvoice([{ invoice }])).rejects.toThrow(/has no amount — pass \{ invoice, amount \}/);
  });
});
