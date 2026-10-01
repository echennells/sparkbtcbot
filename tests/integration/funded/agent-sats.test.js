// Money actually moving through SparkAgent on REGTEST, checked on BOTH sides:
// a fresh receiver per payment ends up holding exactly the amount, once; the
// payer's transfer record, ledger and audit log say what happened. The older
// funded tests drove the raw SDK and mostly asserted `toBeDefined()`.
//
// Two REGTEST facts shape these assertions (seen 2026-09-30):
//   - the payer's own balance moves on its own: SparkAgent claims pending
//     inbound transfers in the background at boot, including the sats earlier
//     runs returned, so payer-side checks use the transfer record and the
//     ledger, never a before/after balance;
//   - a receiver mid-claim can read low or high, so each payment gets a fresh
//     receiver and is checked once it has fully settled (waitForSettled).
// Receivers' funds are returned in afterAll so runs don't bleed the float.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic } from "../../helpers/wallet.js";
import { createTestAgent, cleanupAllAgents, waitForSettled, returnSats, waitForClaimed } from "../../helpers/agent.js";

const fundedMnemonic = getFundedMnemonic();
const describeFunded = fundedMnemonic ? describe : describe.skip;
const settled = (sats) => ({ available: BigInt(sats), incoming: 0n });

describeFunded("funded SparkAgent sats flows (REGTEST)", () => {
  let payer; // SparkAgent on the funded wallet
  let auditLines;
  let payerAddress;
  const receivers = [];
  const freshReceiver = async () => {
    const { wallet } = await createTestWallet();
    receivers.push(wallet);
    return wallet;
  };

  beforeAll(async () => {
    ({ agent: payer, auditLines } = await createTestAgent({ mnemonic: fundedMnemonic, env: { SPARK_DAILY_BUDGET_SATS: "1000000" } }));
    payerAddress = (await payer.getIdentity()).address;
    expect(Number((await payer.getBalance()).sats), "the funded REGTEST wallet needs at least 20,000 sats").toBeGreaterThanOrEqual(20_000);
  }, 90_000);

  afterAll(async () => {
    const readAvailable = async () => BigInt((await payer.getBalance()).sats);
    const before = await readAvailable();
    let sent = 0n;
    for (const r of receivers) sent += await returnSats(r, payerAddress);
    await waitForClaimed(readAvailable, before + sent);
    await cleanupAllAgents();
    await cleanupAllWallets();
  }, 180_000);

  it("transfer: the receiver gets exactly the amount; the payer's record, ledger and audit agree", async () => {
    const receiver = await freshReceiver();
    const spentBefore = (await payer.spendStatus()).spentSats;
    const result = await payer.transfer({ to: await receiver.getSparkAddress(), amount: 1_000 });
    expect(result.valueSentByWallet).toBe(1_000); // no fee on a Spark transfer
    expect(await waitForSettled(receiver, 1_000n)).toEqual(settled(1_000));
    expect((await payer.getTransfers(10, 0)).transfers.map((t) => t.id)).toContain(result.id);
    expect((await payer.spendStatus()).spentSats).toBe(spentBefore + 1_000);
    expect((await auditLines()).at(-1)).toMatchObject({ op: "spark_transfer", amountSats: 1_000, result: "ok", id: result.id });
  });

  it("fulfillInvoice pays a Spark sats invoice once, for its embedded amount", async () => {
    const receiver = await freshReceiver();
    const invoice = await receiver.createSatsInvoice({ amount: 1_500, memo: "funded invoice" });
    const result = await payer.fulfillInvoice([{ invoice }]);
    expect(result.satsTransactionErrors.map((e) => e.error?.message)).toEqual([]);
    expect(result.satsTransactionSuccess).toHaveLength(1);
    expect(await waitForSettled(receiver, 1_500n)).toEqual(settled(1_500));
  });

  it("fulfillInvoice pays an amountless invoice the amount the caller supplies", async () => {
    const receiver = await freshReceiver();
    const invoice = await receiver.createSatsInvoice({ memo: "you choose" });
    const result = await payer.fulfillInvoice([{ invoice, amount: 400n }]);
    expect(result.satsTransactionErrors.map((e) => e.error?.message)).toEqual([]);
    expect(result.satsTransactionSuccess).toHaveLength(1);
    expect(await waitForSettled(receiver, 400n)).toEqual(settled(400));
  });

  describe("paying the same Spark invoice twice", () => {
    let receiver;
    let second;
    let spentBeforeSecond;

    beforeAll(async () => {
      receiver = await freshReceiver();
      const invoice = await receiver.createSatsInvoice({ amount: 600, memo: "pay once" });
      await payer.fulfillInvoice([{ invoice }]);
      await waitForSettled(receiver, 600n);
      spentBeforeSecond = (await payer.spendStatus()).spentSats;
      second = await payer.fulfillInvoice([{ invoice }]).catch((err) => err);
    }, 90_000);

    it("the operators refuse the second payment: the receiver is credited once", async () => {
      await new Promise((r) => setTimeout(r, 4_000));
      expect(await waitForSettled(receiver, 600n)).toEqual(settled(600));
    });

    // The SDK reports the refusal in satsTransactionErrors instead of throwing.
    // fulfillInvoice used to return that as success (counted, audited "ok").
    // Now it throws PAYMENT_COMMITTED: sending had begun, and a transaction
    // error doesn't prove nothing moved, so the spend stays counted and the
    // audit says "unknown" (the safe direction, as for every other send).
    it("fulfillInvoice throws PAYMENT_COMMITTED naming the failed invoice; the spend stays counted, audited 'unknown'", async () => {
      expect(second).toMatchObject({
        code: "PAYMENT_COMMITTED",
        paid: [],
        failed: [{ reason: expect.stringMatching(/FAILED_PRECONDITION/) }],
      });
      expect((await payer.spendStatus()).spentSats).toBe(spentBeforeSecond + 600);
      expect((await auditLines()).at(-1)).toMatchObject({ op: "fulfill_spark_invoice", result: "unknown" });
    });
  });

  describe("Lightning", () => {
    let receiver;
    let bolt11;

    beforeAll(async () => {
      receiver = await freshReceiver();
      ({ invoice: { encodedInvoice: bolt11 } } = await receiver.createLightningInvoice({ amountSats: 1_000, memo: "funded ln", expirySeconds: 600 }));
    });

    it("pays a BOLT11 invoice: the receiver gets exactly the amount; the fee is under the cap", async () => {
      const result = await payer.payLightningInvoice(bolt11, { maxFeeSats: 50 });
      expect(result.status).toBe("TRANSFER_COMPLETED");
      expect(result.fee?.originalValue ?? 0).toBeLessThanOrEqual(50);
      expect(await waitForSettled(receiver, 1_000n)).toEqual(settled(1_000));
    });

    // The persisted transferId (lib/transfer-ids.js) makes a retry of the same
    // invoice the SAME payment. The ledger counts the retry again — documented
    // in payLightningInvoice as the safe direction for a loop guard — so this
    // pins both halves: no second payment, and a deliberate double count.
    it("a retry of the same invoice is deduped: the receiver is credited once; the ledger counts it twice (by design)", async () => {
      const spentBefore = (await payer.spendStatus()).spentSats;
      const retry = await payer.payLightningInvoice(bolt11, { maxFeeSats: 50 });
      expect(retry.status).toBe("TRANSFER_COMPLETED");
      await new Promise((r) => setTimeout(r, 4_000));
      expect(await waitForSettled(receiver, 1_000n)).toEqual(settled(1_000));
      expect((await payer.spendStatus()).spentSats).toBe(spentBefore + 1_000);
    });
  });

  it("a daily budget stops the second send before it reaches the network", async () => {
    const receiver = await freshReceiver();
    const { agent: budgeted } = await createTestAgent({ mnemonic: fundedMnemonic, env: { SPARK_DAILY_BUDGET_SATS: "1500" } });
    const to = await receiver.getSparkAddress();
    await budgeted.transfer({ to, amount: 1_000 });
    await expect(budgeted.transfer({ to, amount: 1_000 })).rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
    await new Promise((r) => setTimeout(r, 3_000));
    expect(await waitForSettled(receiver, 1_000n)).toEqual(settled(1_000));
    expect(await budgeted.spendStatus()).toMatchObject({ spentSats: 1_000, remainingSats: 500 });
  });

  // REGTEST's SSP quotes a flat ~2,190-sat cooperative-exit fee (2026-09-30),
  // and withdraw()'s default ceiling is 10% of the amount, so the guard has a
  // real quote to refuse on either side of the line.
  it("withdraw prices a cooperative exit from a real SSP quote and refuses a fee over 10% before sending", async () => {
    const { wallet: l1 } = await createTestWallet();
    const to = await l1.getStaticDepositAddress();
    const big = await payer.withdraw({ to, amount: 50_000, dryRun: true });
    expect(big).toMatchObject({ dryRun: true, operation: "l1_withdraw", to, amount: "50000", maxFeeSats: "5000", withinCap: true });
    const fee = Number(big.estimatedFee);
    expect(fee).toBeGreaterThan(0);
    // the largest round amount whose 10% cap is below the quoted fee
    const small = Math.floor(((fee - 1) * 10) / 1000) * 1000;
    const preview = await payer.withdraw({ to, amount: small, dryRun: true });
    expect(preview).toMatchObject({ withinCap: false, capReason: expect.stringMatching(/exceeds cap/) });
    const spentBefore = (await payer.spendStatus()).spentSats;
    await expect(payer.withdraw({ to, amount: small })).rejects.toThrow(/exceeds|cap/i);
    // withdraw records the spend only after the fee guard passes: nothing was sent
    expect((await payer.spendStatus()).spentSats).toBe(spentBefore);
  });
});
