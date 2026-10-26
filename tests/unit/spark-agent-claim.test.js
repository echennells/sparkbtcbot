// claimDeposit's fee ceiling used to be a flat 5,000-sat default regardless of
// deposit size — authorizing the SSP to take 83% of a 6,000-sat deposit. The
// default must scale with the quoted credit (maxFeePct, same posture as
// withdraw), an explicit maxFeeSats must still win, and an unreadable quote
// with no explicit cap must fail CLOSED.
import { describe, it, expect, afterEach } from "vitest";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

const orig = process.env.SPARK_LEAF_VAULT;
afterEach(() => { if (orig === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = orig; });

const TX = "c1".repeat(32);

const mkAgent = ({ credit = 6_000 } = {}) => {
  process.env.SPARK_LEAF_VAULT = "off";
  const calls = { claim: null, quotes: 0 };
  const wallet = {
    // claimDeposit first asks the operators where the deposit sits: here, the static address.
    queryStaticDepositAddresses: async () => ["bc1pSTATIC"],
    getUnusedDepositAddresses: async () => [],
    getUtxosForDepositAddress: async () => [{ txid: TX, vout: 0 }],
    getClaimStaticDepositQuote: async () => { calls.quotes++; return { creditAmountSats: credit }; },
    claimStaticDepositWithMaxFee: async (params) => { calls.claim = params; return { claimed: true }; },
  };
  return { agent: new SparkAgent(wallet, "MAINNET"), calls };
};

describe("claimDeposit size-aware fee ceiling", () => {
  it("derives the default ceiling from the quoted credit (10%), not a flat 5,000", async () => {
    const { agent, calls } = mkAgent({ credit: 6_000 });
    await agent.claimDeposit({ txid: TX });
    expect(calls.claim).toMatchObject({ transactionId: TX, maxFee: 600, outputIndex: 0 });
  });

  it("honors a caller maxFeePct", async () => {
    const { agent, calls } = mkAgent({ credit: 6_000 });
    await agent.claimDeposit({ txid: TX, maxFeePct: 5 });
    expect(calls.claim.maxFee).toBe(300);
  });

  it("an explicit maxFeeSats wins and skips the quote fetch", async () => {
    const { agent, calls } = mkAgent();
    await agent.claimDeposit({ txid: TX, maxFeeSats: 1_234 });
    expect(calls.claim.maxFee).toBe(1_234);
    expect(calls.quotes).toBe(0);
  });

  it("FAILS CLOSED when the quote is unreadable and no explicit cap was given", async () => {
    const { agent, calls } = mkAgent({ credit: null });
    await expect(agent.claimDeposit({ txid: TX })).rejects.toThrow(/unreadable.*maxFeeSats/s);
    expect(calls.claim).toBeNull();
  });

  it("dryRun previews the quoted credit and the derived ceiling without claiming", async () => {
    const { agent, calls } = mkAgent({ credit: 6_000 });
    const preview = await agent.claimDeposit({ txid: TX, dryRun: true });
    expect(preview).toMatchObject({
      dryRun: true,
      operation: "claim_deposit",
      creditSats: "6000",
      maxFeeSats: "600",
    });
    expect(calls.claim).toBeNull();
  });

  // ToB review of 375e6fb..HEAD: 10% of a 0.49 BTC deposit allowed a
  // 4,900,000-sat fee against a few-hundred-sat spread, and maxFeePct: 1000
  // was accepted.
  it("caps the default ceiling at 25,000 sats; an explicit maxFeeSats goes past it", async () => {
    const big = mkAgent({ credit: 49_000_000 });
    await big.agent.claimDeposit({ txid: TX });
    expect(big.calls.claim.maxFee).toBe(25_000);
    const explicit = mkAgent({ credit: 49_000_000 });
    await explicit.agent.claimDeposit({ txid: TX, maxFeeSats: 40_000 });
    expect(explicit.calls.claim.maxFee).toBe(40_000);
  });

  it("refuses a maxFeePct outside 0–100 and a negative maxFeeSats, before any I/O", async () => {
    const { agent, calls } = mkAgent();
    await expect(agent.claimDeposit({ txid: TX, maxFeePct: 1000 })).rejects.toThrow(/between 0 and 100/);
    await expect(agent.claimDeposit({ txid: TX, maxFeePct: -1 })).rejects.toThrow(/between 0 and 100/);
    await expect(agent.claimDeposit({ txid: TX, maxFeeSats: -5 })).rejects.toThrow(/must not be negative/);
    expect(calls.quotes).toBe(0);
    await expect(new SparkAgent({}, "MAINNET").withdraw({ to: "bc1qx", amount: 30_000, maxFeePct: 500 })).rejects.toThrow(/between 0 and 100/);
  });

  it("still rejects unknown options", async () => {
    const { agent, calls } = mkAgent();
    await expect(agent.claimDeposit({ txid: TX, maxFeeSat: 100 })).rejects.toThrow(/unknown option/i);
    expect(calls.claim).toBeNull();
  });
});
