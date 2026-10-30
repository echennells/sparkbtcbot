// ToB review fix: the withdrawal fee ceiling must actually BIND the executed exit —
// pass the vetted feeQuote so the operator cannot re-price at broadcast (TOCTOU) —
// and must fail CLOSED when the quote fee is unreadable instead of deferring to an
// SDK cap that does not exist for this path.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SparkValidationError } from "@buildonspark/spark-sdk";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

// A CoopExitFeeQuote-shaped object; MEDIUM fee = userFeeMedium + l1BroadcastFeeMedium.
const quote = (feeSats, id = "q1") => ({ id, userFeeMedium: { originalValue: feeSats }, l1BroadcastFeeMedium: { originalValue: 0 } });

describe("withdraw fee ceiling binds the vetted quote (ToB fix)", () => {
  const orig = process.env.SPARK_LEAF_VAULT;
  beforeEach(() => { process.env.SPARK_LEAF_VAULT = "off"; }); // no leaf-vault side effects
  afterEach(() => { if (orig === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = orig; });

  it("binds the executed withdraw to the vetted quote via feeQuoteId + feeAmountSats", async () => {
    let passed = null;
    const wallet = {
      getWithdrawalFeeQuote: async () => quote(100), // 100 sats on a 100k exit = 0.1% < 10%
      withdraw: async (p) => { passed = p; return { ok: true }; },
      getSparkAddress: async () => "sp1test",
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    await agent.withdraw({ to: "bc1qexampledestination", amount: 100000, speed: "MEDIUM" });
    expect(passed).toBeTruthy();
    // Non-deprecated binding: id + exact vetted fee (the feeQuote object param
    // is @deprecated in the SDK and kept only as a fallback).
    expect(passed.feeQuoteId).toBe("q1");
    expect(passed.feeAmountSats).toBe(100);
    expect(passed.feeQuote).toBeUndefined();
  });

  it("fails CLOSED (does not execute) when the quote fee is unreadable and a cap is set", async () => {
    let executed = false;
    const wallet = {
      getWithdrawalFeeQuote: async () => ({ id: "q-unreadable" }), // no fee fields -> unreadable
      withdraw: async () => { executed = true; return {}; },
      getSparkAddress: async () => "sp1test",
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    await expect(
      agent.withdraw({ to: "bc1qexampledestination", amount: 100000, speed: "MEDIUM" }),
    ).rejects.toThrow(/unreadable|cannot verify/i);
    expect(executed).toBe(false);
  });

  it("blocks (does not execute) a quote whose fee exceeds the ceiling", async () => {
    let executed = false;
    const wallet = {
      getWithdrawalFeeQuote: async () => quote(20000), // 20% of 100k > the 10% default cap
      withdraw: async () => { executed = true; return {}; },
      getSparkAddress: async () => "sp1test",
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    await expect(
      agent.withdraw({ to: "bc1qexampledestination", amount: 100000, speed: "MEDIUM" }),
    ).rejects.toThrow(/blocked|exceeds/i);
    expect(executed).toBe(false);
  });
});

// Review 2026-10-28 (F30): nothing made wallet.withdraw itself throw, so a
// catch that rethrew the SDK's error raw survived the suite. A raw error has
// no code or retryable, and it skips the undo on a pre-send refusal. A real
// ledger is needed: with no budget set, undo() is a no-op and spentSats can't
// tell the two cases apart.
describe("withdraw: the exit call itself fails", () => {
  const KEYS = ["SPARK_LEAF_VAULT", "SPARK_DAILY_BUDGET_SATS", "SPARK_SPEND_LEDGER_PATH", "SPARK_SEED_PATH"];
  const saved = {};
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "withdraw-exit-fail-"));
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.SPARK_LEAF_VAULT = "off";
    process.env.SPARK_DAILY_BUDGET_SATS = "1000000";
    process.env.SPARK_SPEND_LEDGER_PATH = join(dir, "ledger.json");
    process.env.SPARK_SEED_PATH = join(dir, "seed.enc"); // absent: no seed-bound budget
  });
  afterEach(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  const rejection = (p) => p.then(() => { throw new Error("expected a rejection"); }, (e) => e);
  const agentWhoseExitThrows = (err, calls = { n: 0 }) => new SparkAgent({
    getSparkAddress: async () => "sp1test",
    getWithdrawalFeeQuote: async () => quote(100),
    withdraw: async () => { calls.n++; throw err; },
  }, "MAINNET");
  const exit = (agent) => agent.withdraw({ to: "bc1qexampledestination", amount: 100000, speed: "MEDIUM" });

  it("an unknown outcome ('deadline exceeded') is PAYMENT_COMMITTED check-first and the spend stays counted", async () => {
    const calls = { n: 0 };
    const agent = agentWhoseExitThrows(new Error("deadline exceeded"), calls);
    const err = await rejection(exit(agent));
    expect(err).toMatchObject({
      name: "PaymentCommittedError", code: "PAYMENT_COMMITTED", retryable: "check-first", settled: null, op: "l1_withdraw",
    });
    expect(err.cause).toMatchObject({ message: "deadline exceeded" });
    expect(err.nextStep).toMatch(/coop exit status before withdrawing again: a new exit is a second payment/);
    expect(calls.n).toBe(1);
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 100100 }); // amount + the vetted fee
  });

  it("the SDK's pre-send 'fee is greater than the amount' is FEE_OVER_LIMIT 'no' and the spend is undone", async () => {
    const agent = agentWhoseExitThrows(
      new SparkValidationError("The fee for the withdrawal is greater than the target withdrawal amount", { field: "fee" }),
    );
    const err = await rejection(exit(agent));
    expect(err).toMatchObject({ name: "SparkValidationError", code: "FEE_OVER_LIMIT", retryable: "no" });
    expect(err.nextStep).toMatch(/^Nothing was sent\. The exit fee is more than the amount/);
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 0 });
  });

  it("an operator outage (gRPC 14) on the exit stays PAYMENT_COMMITTED, never SPARK_UNAVAILABLE 'yes'", async () => {
    const unavailable = Object.assign(new Error("/spark.SparkService/cooperative_exit UNAVAILABLE: No connection established"), {
      name: "ClientError", code: 14, details: "No connection established",
    });
    const agent = agentWhoseExitThrows(unavailable);
    const err = await rejection(exit(agent));
    expect(err).toMatchObject({ code: "PAYMENT_COMMITTED", retryable: "check-first", settled: null, op: "l1_withdraw" });
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 100100 });
  });
});
