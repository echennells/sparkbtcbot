// The audit's headline gap: per-call ceilings can't bound a LOOP — an agent
// paying N individually-valid sends drains the wallet while every guard
// passes. With SPARK_DAILY_BUDGET_SATS set, SparkAgent must stop the loop at
// the budget, across ALL sats paths sharing one ledger, and a malformed
// budget must refuse to boot rather than be silently ignored.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

let dir;
const ENV_KEYS = ["SPARK_LEAF_VAULT", "SPARK_DAILY_BUDGET_SATS", "SPARK_SPEND_LEDGER_PATH"];
const saved = {};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-budget-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.SPARK_LEAF_VAULT = "off";
  process.env.SPARK_DAILY_BUDGET_SATS = "1000";
  process.env.SPARK_SPEND_LEDGER_PATH = join(dir, "ledger.json");
});
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(dir, { recursive: true, force: true });
});

const mkWallet = () => {
  const calls = { transfers: 0, pays: 0 };
  return {
    calls,
    getSparkAddress: async () => "sp1from",
    transfer: async () => { calls.transfers++; return { id: `t${calls.transfers}` }; },
    getLightningSendFeeEstimate: async () => 5,
    payLightningInvoice: async () => { calls.pays++; return { id: `p${calls.pays}` }; },
  };
};

// Amount-ful sample (2,000 sats embedded) from light-bolt11-decoder's README.
const INVOICE_2000_SATS =
  "lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpqd4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpyw0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm03c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp54l567";

describe("SparkAgent spend budget (SPARK_DAILY_BUDGET_SATS)", () => {
  it("stops a transfer loop at the budget — the drain per-call caps can't see", async () => {
    const wallet = mkWallet();
    const agent = new SparkAgent(wallet, "MAINNET");
    await agent.transfer({ to: "sp1x", amount: 400 });
    await agent.transfer({ to: "sp1x", amount: 400 });
    await expect(agent.transfer({ to: "sp1x", amount: 400 }))
      .rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
    expect(wallet.calls.transfers).toBe(2); // third send never reached the SDK
  });

  it("all sats paths share ONE budget (a lightning pay eats transfer budget)", async () => {
    const wallet = mkWallet();
    const agent = new SparkAgent(wallet, "MAINNET");
    // dryRun proves the sample invoice still decodes to 2,000 sats — guards
    // the constant so the budget assertion below can't silently weaken
    const preview = await agent.payLightningInvoice(INVOICE_2000_SATS, { dryRun: true, maxAmountSats: 900 });
    expect(preview.amount).toBe("2000");
    process.env.SPARK_DAILY_BUDGET_SATS = "2500";
    const agent2 = new SparkAgent(wallet, "MAINNET");
    await agent2.payLightningInvoice(INVOICE_2000_SATS, { maxAmountSats: 2000 });
    await expect(agent2.transfer({ to: "sp1x", amount: 501 }))
      .rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
    await agent2.transfer({ to: "sp1x", amount: 500 }); // the remainder fits
  });

  it("refunds a spend when the SDK call throws (no money moved, budget intact)", async () => {
    const wallet = mkWallet();
    wallet.transfer = async () => { throw new Error("operator offline"); };
    const agent = new SparkAgent(wallet, "MAINNET");
    await expect(agent.transfer({ to: "sp1x", amount: 900 })).rejects.toThrow(/operator offline/);
    // full budget still available
    const ok = new SparkAgent(mkWallet(), "MAINNET");
    await ok.transfer({ to: "sp1x", amount: 1000 });
  });

  it("dryRun spends nothing", async () => {
    const wallet = mkWallet();
    const agent = new SparkAgent(wallet, "MAINNET");
    await agent.transfer({ to: "sp1x", amount: 1000, dryRun: true });
    const status = await agent.spendStatus();
    expect(status.spentSats).toBe(0);
  });

  it("spendStatus reports the window; { disabled: true } without a budget", async () => {
    const agent = new SparkAgent(mkWallet(), "MAINNET");
    await agent.transfer({ to: "sp1x", amount: 250 });
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 250, budgetSats: 1000, remainingSats: 750 });
    delete process.env.SPARK_DAILY_BUDGET_SATS;
    const unbudgeted = new SparkAgent(mkWallet(), "MAINNET");
    expect(await unbudgeted.spendStatus()).toEqual({ disabled: true });
  });

  it("without the env var, nothing is enforced and no ledger file appears", async () => {
    delete process.env.SPARK_DAILY_BUDGET_SATS;
    const wallet = mkWallet();
    const agent = new SparkAgent(wallet, "MAINNET");
    await agent.transfer({ to: "sp1x", amount: 10 ** 9 });
    await expect(readFile(join(dir, "ledger.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("a malformed budget refuses to construct instead of being silently ignored", () => {
    process.env.SPARK_DAILY_BUDGET_SATS = "lots";
    expect(() => new SparkAgent(mkWallet(), "MAINNET")).toThrow(/positive number of sats/);
    process.env.SPARK_DAILY_BUDGET_SATS = "-100";
    expect(() => new SparkAgent(mkWallet(), "MAINNET")).toThrow(/positive number of sats/);
  });

  // ToB audit F2: the ledger's check-then-record was two unlocked awaits, so a
  // PARALLEL burst (Promise.all) passed every budget check against the same
  // pre-burst ledger and clobbered each other's append — defeating the exact
  // "prompt-injected spree" the budget exists to stop. #recordSpend now
  // serializes the critical section per instance.
  it("bounds a PARALLEL send burst to the budget (not just a serial loop)", async () => {
    process.env.SPARK_DAILY_BUDGET_SATS = "1000";
    const wallet = mkWallet();
    const agent = new SparkAgent(wallet, "MAINNET");
    // Fire five 300-sat transfers at once: 3 fit (900), the rest must be refused.
    const results = await Promise.allSettled(
      Array.from({ length: 5 }, () => agent.transfer({ to: "sp1x", amount: 300 })),
    );
    const ok = results.filter((r) => r.status === "fulfilled").length;
    const blocked = results.filter(
      (r) => r.status === "rejected" && /SPEND_BUDGET_EXCEEDED/.test(r.reason?.code ?? r.reason?.message ?? ""),
    ).length;
    expect(ok).toBe(3);              // exactly floor(1000/300) fit
    expect(blocked).toBe(2);
    expect(wallet.calls.transfers).toBe(3); // only the funded sends reached the SDK
    const status = await agent.spendStatus();
    expect(status.spentSats).toBe(900);     // ledger did not undercount
    expect(status.spentSats).toBeLessThanOrEqual(1000);
  });
});
