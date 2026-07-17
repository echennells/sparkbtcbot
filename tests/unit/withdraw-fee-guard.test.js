// ToB review fix: the withdrawal fee ceiling must actually BIND the executed exit —
// pass the vetted feeQuote so the operator cannot re-price at broadcast (TOCTOU) —
// and must fail CLOSED when the quote fee is unreadable instead of deferring to an
// SDK cap that does not exist for this path.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

// A CoopExitFeeQuote-shaped object; MEDIUM fee = userFeeMedium + l1BroadcastFeeMedium.
const quote = (feeSats, id = "q1") => ({ id, userFeeMedium: { originalValue: feeSats }, l1BroadcastFeeMedium: { originalValue: 0 } });

describe("withdraw fee ceiling binds the vetted quote (ToB fix)", () => {
  const orig = process.env.SPARK_LEAF_VAULT;
  beforeEach(() => { process.env.SPARK_LEAF_VAULT = "off"; }); // no leaf-vault side effects
  afterEach(() => { if (orig === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = orig; });

  it("passes the vetted feeQuote into wallet.withdraw so the operator cannot re-price", async () => {
    let passed = null;
    const wallet = {
      getWithdrawalFeeQuote: async () => quote(100), // 100 sats on a 100k exit = 0.1% < 10%
      withdraw: async (p) => { passed = p; return { ok: true }; },
      getSparkAddress: async () => "sp1test",
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    await agent.withdraw({ to: "bc1qexampledestination", amount: 100000, speed: "MEDIUM" });
    expect(passed).toBeTruthy();
    expect(passed.feeQuote).toBeTruthy();
    expect(passed.feeQuote.id).toBe("q1"); // execution bound to the exact quote we checked
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
