// claimDeposit's fee ceiling used to be a flat 5,000-sat default regardless of
// deposit size — authorizing the SSP to take 83% of a 6,000-sat deposit. The
// default must scale with the quoted credit (maxFeePct, same posture as
// withdraw), an explicit maxFeeSats must still win, and an unreadable quote
// with no explicit cap must fail CLOSED.
import { describe, it, expect, afterEach } from "vitest";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

const orig = process.env.SPARK_LEAF_VAULT;
afterEach(() => { if (orig === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = orig; });

const mkAgent = ({ credit = 6_000 } = {}) => {
  process.env.SPARK_LEAF_VAULT = "off";
  const calls = { claim: null, quotes: 0 };
  const wallet = {
    getClaimStaticDepositQuote: async () => { calls.quotes++; return { creditAmountSats: credit }; },
    claimStaticDepositWithMaxFee: async (params) => { calls.claim = params; return { claimed: true }; },
  };
  return { agent: new SparkAgent(wallet, "MAINNET"), calls };
};

describe("claimDeposit size-aware fee ceiling", () => {
  it("derives the default ceiling from the quoted credit (10%), not a flat 5,000", async () => {
    const { agent, calls } = mkAgent({ credit: 6_000 });
    await agent.claimDeposit({ txid: "t1" });
    expect(calls.claim).toMatchObject({ transactionId: "t1", maxFee: 600, outputIndex: 0 });
  });

  it("honors a caller maxFeePct", async () => {
    const { agent, calls } = mkAgent({ credit: 6_000 });
    await agent.claimDeposit({ txid: "t1", maxFeePct: 5 });
    expect(calls.claim.maxFee).toBe(300);
  });

  it("an explicit maxFeeSats wins and skips the quote fetch", async () => {
    const { agent, calls } = mkAgent();
    await agent.claimDeposit({ txid: "t1", maxFeeSats: 1_234 });
    expect(calls.claim.maxFee).toBe(1_234);
    expect(calls.quotes).toBe(0);
  });

  it("FAILS CLOSED when the quote is unreadable and no explicit cap was given", async () => {
    const { agent, calls } = mkAgent({ credit: null });
    await expect(agent.claimDeposit({ txid: "t1" })).rejects.toThrow(/unreadable.*maxFeeSats/s);
    expect(calls.claim).toBeNull();
  });

  it("dryRun previews the quoted credit and the derived ceiling without claiming", async () => {
    const { agent, calls } = mkAgent({ credit: 6_000 });
    const preview = await agent.claimDeposit({ txid: "t1", dryRun: true });
    expect(preview).toMatchObject({
      dryRun: true,
      operation: "claim_deposit",
      creditSats: "6000",
      maxFeeSats: "600",
    });
    expect(calls.claim).toBeNull();
  });

  it("still rejects unknown options", async () => {
    const { agent, calls } = mkAgent();
    await expect(agent.claimDeposit({ txid: "t1", maxFeeSat: 100 })).rejects.toThrow(/unknown option/i);
    expect(calls.claim).toBeNull();
  });
});
