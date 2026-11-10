// The daily budget against real sats on hosted REGTEST. The unit tier proves
// the gate with mock wallets; this proves that a refusal means nothing left a
// real wallet, that a parallel burst is held to the budget on the real
// network, and that the user's chat limit and a second agent on the same
// ledger see the same total.
//
// A throwaway payer gets 2,000 sats from the funded wallet and spends under a
// 1,000-sat budget; everything is returned at the end. Spark transfers are
// free, so the run costs nothing.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SparkAgent } from "../../../skills/sparkbtcbot/scripts/spark-agent.js";
import { writeLimits } from "../../../lib/spending-limits.js";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic, returnSats, waitForSettled, waitForClaimed } from "../../helpers/wallet.js";

const fundedMnemonic = getFundedMnemonic();
const describeFunded = fundedMnemonic ? describe : describe.skip;
const FLOAT = 2_000;
const BUDGET = 1_000;
const ENV = ["SPARK_SEED_PATH", "SPARK_LEAF_VAULT", "SPARK_PRIVACY", "SPARK_DAILY_BUDGET_SATS", "SPARK_SPEND_LEDGER_PATH", "SPARK_LIMITS_PATH"];

describeFunded("the daily budget with real sats (REGTEST)", () => {
  const saved = {};
  let dir, funder, funderAddress, payer, receiver, receiverAddress, agent;
  const owned = async (w) => (await w.getBalance()).satsBalance.owned;
  const ledgerSats = async () => JSON.parse(await readFile(process.env.SPARK_SPEND_LEDGER_PATH, "utf8")).entries.reduce((s, e) => s + e.sats, 0);

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "funded-budget-"));
    for (const k of ENV) saved[k] = process.env[k];
    Object.assign(process.env, {
      SPARK_SEED_PATH: join(dir, "no-seed.enc"),
      SPARK_LEAF_VAULT: "off",
      SPARK_PRIVACY: "off",
      SPARK_DAILY_BUDGET_SATS: String(BUDGET),
      SPARK_SPEND_LEDGER_PATH: join(dir, "spend-ledger.json"),
      SPARK_LIMITS_PATH: join(dir, "limits.json"),
    });
    ({ wallet: funder } = await createTestWallet({ mnemonic: fundedMnemonic }));
    funderAddress = await funder.getSparkAddress();
    ({ wallet: payer } = await createTestWallet());
    ({ wallet: receiver } = await createTestWallet());
    receiverAddress = await receiver.getSparkAddress();
    await funder.transfer({ receiverSparkAddress: await payer.getSparkAddress(), amountSats: FLOAT });
    const got = await waitForSettled(payer, BigInt(FLOAT));
    expect(got.available, "the payer's float from the funded wallet (top the funded wallet up if this is 0)").toBe(BigInt(FLOAT));
    agent = new SparkAgent(payer, "REGTEST");
  }, 150_000);

  afterAll(async () => {
    if (funder) {
      const readAvailable = async () => (await funder.getBalance()).satsBalance.available;
      const before = await readAvailable();
      let returned = 0n;
      for (const w of [receiver, payer]) if (w) returned += await returnSats(w, funderAddress);
      if (returned > 0n) await waitForClaimed(readAvailable, before + returned);
      if (returned !== BigInt(FLOAT)) console.warn(`funded budget test: returned ${returned} of ${FLOAT} sats to the funded wallet`);
    }
    await cleanupAllWallets();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  }, 240_000);

  it("a payment inside the budget goes through and is counted", async () => {
    await agent.transfer({ to: receiverAddress, amount: 300 });
    expect((await waitForSettled(receiver, 300n)).available).toBe(300n);
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 300, budgetSats: BUDGET, remainingSats: 700 });
  }, 90_000);

  it("a payment past the budget is refused, dry run and live, and no sat leaves the wallet", async () => {
    const before = { payer: await owned(payer), receiver: await owned(receiver) };
    await expect(agent.transfer({ to: receiverAddress, amount: 800, dryRun: true })).rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED", retryable: "no" });
    await expect(agent.transfer({ to: receiverAddress, amount: 800 })).rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED", retryable: "no" });
    await new Promise((r) => setTimeout(r, 6_000)); // time for a transfer to show, had one been sent
    expect({ payer: await owned(payer), receiver: await owned(receiver) }).toEqual(before);
    expect(await ledgerSats()).toBe(300);
  }, 60_000);

  it("two payments at once that only fit once: one is sent, one refused", async () => {
    const results = await Promise.allSettled([
      agent.transfer({ to: receiverAddress, amount: 400 }),
      agent.transfer({ to: receiverAddress, amount: 400 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected").reason).toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
    expect((await waitForSettled(receiver, 700n)).available).toBe(700n);
    expect(await ledgerSats()).toBe(700);
  }, 90_000);

  it("the user's chat limit tightens the budget in force, from the next call", async () => {
    await writeLimits({ dailyBudgetSats: 750 }, process.env.SPARK_LIMITS_PATH);
    const refused = await agent.transfer({ to: receiverAddress, amount: 100 }).catch((e) => e);
    expect(refused).toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
    expect(refused.message).toMatch(/the user's own daily limit/);
    await agent.transfer({ to: receiverAddress, amount: 50 });
    expect((await waitForSettled(receiver, 750n)).available).toBe(750n);
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 750, budgetSats: 750, remainingSats: 0 });
  }, 90_000);

  it("another agent on the same ledger starts from what was already spent", async () => {
    const second = new SparkAgent(payer, "REGTEST");
    expect((await second.spendStatus()).spentSats).toBe(750);
    await expect(second.transfer({ to: receiverAddress, amount: 1 })).rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
    expect(await owned(receiver)).toBe(750n);
    expect(await owned(payer)).toBe(BigInt(FLOAT - 750));
  }, 60_000);
});
