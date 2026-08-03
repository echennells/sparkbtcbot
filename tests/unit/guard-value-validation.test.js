// Regression tests for the guard-VALUE validation (2026-08 adversarial review,
// 0.4.0 round): the release rejected misspelled option KEYS but not garbage
// numeric VALUES — `maxFeePct: "10%"` produced NaN, and NaN/Infinity silently
// disables the ceiling (the SDK's `feeCharged > maxFee` is false for NaN; the
// lib guards treat a non-finite cap as "no cap set"). Every money method must
// now throw on an unreadable numeric guard option BEFORE any I/O. Also covers
// batchTransferTokens failing closed on an entry whose receiver can't be read.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

const origVault = process.env.SPARK_LEAF_VAULT;
beforeEach(() => { process.env.SPARK_LEAF_VAULT = "off"; });
afterEach(() => { if (origVault === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = origVault; });

const mkAgent = (wallet) => new SparkAgent(wallet, "MAINNET");

describe("claimDeposit guard-value validation", () => {
  const wallet = () => ({
    getClaimStaticDepositQuote: async () => { throw new Error("I/O must not happen"); },
    claimStaticDepositWithMaxFee: async () => { throw new Error("I/O must not happen"); },
  });

  it("throws on garbage maxFeePct (was: NaN cap -> SDK never trips -> unlimited haircut)", async () => {
    await expect(mkAgent(wallet()).claimDeposit({ txid: "t1", maxFeePct: "10%" }))
      .rejects.toThrow(/maxFeePct must be a number/);
  });

  it("throws on garbage maxFeeSats", async () => {
    await expect(mkAgent(wallet()).claimDeposit({ txid: "t1", maxFeeSats: "lots" }))
      .rejects.toThrow(/maxFeeSats must be a number/);
  });

  it("throws on NaN maxFeePct", async () => {
    await expect(mkAgent(wallet()).claimDeposit({ txid: "t1", maxFeePct: NaN }))
      .rejects.toThrow(/maxFeePct must be a number/);
  });

  it("still accepts a valid explicit maxFeeSats (and a numeric string)", async () => {
    const calls = { claim: null };
    const w = {
      getClaimStaticDepositQuote: async () => { throw new Error("quote must be skipped for explicit cap"); },
      claimStaticDepositWithMaxFee: async (p) => { calls.claim = p; return { claimed: true }; },
    };
    await mkAgent(w).claimDeposit({ txid: "t1", maxFeeSats: "500" });
    expect(calls.claim.maxFee).toBe(500);
  });
});

describe("withdraw guard-value validation", () => {
  const wallet = () => ({
    getWithdrawalFeeQuote: async () => { throw new Error("I/O must not happen"); },
    withdraw: async () => { throw new Error("I/O must not happen"); },
    getSparkAddress: async () => "sp1test",
  });

  it("throws on garbage maxFeePct BEFORE the quote fetch (was: Infinity cap -> 50%-fee exit passes)", async () => {
    await expect(mkAgent(wallet()).withdraw({ to: "bc1qdest", amount: 100000, maxFeePct: "ten" }))
      .rejects.toThrow(/maxFeePct must be a number/);
  });

  it("throws on garbage maxFeeSats", async () => {
    await expect(mkAgent(wallet()).withdraw({ to: "bc1qdest", amount: 100000, maxFeeSats: {} }))
      .rejects.toThrow(/maxFeeSats must be a number/);
  });
});

describe("payLightningInvoice guard-value validation", () => {
  const wallet = () => ({
    getSparkAddress: async () => "sp1from",
    getLightningSendFeeEstimate: async () => { throw new Error("I/O must not happen"); },
    payLightningInvoice: async () => { throw new Error("I/O must not happen"); },
  });

  it('throws on garbage maxAmountSats (was: "no amount cap set" -> pays any invoice)', async () => {
    await expect(mkAgent(wallet()).payLightningInvoice("lnbc1whatever", { maxAmountSats: "lots" }))
      .rejects.toThrow(/maxAmountSats must be a number/);
  });

  it("throws on garbage maxFeeSats", async () => {
    await expect(mkAgent(wallet()).payLightningInvoice("lnbc1whatever", { maxFeeSats: "ten" }))
      .rejects.toThrow(/maxFeeSats must be a number/);
  });
});

describe("fetchL402 guard-value validation", () => {
  it("throws on garbage maxAmountSats BEFORE any fetch", async () => {
    let fetched = 0;
    const origFetch = globalThis.fetch;
    globalThis.fetch = async () => { fetched++; throw new Error("fetch must not happen"); };
    try {
      const agent = mkAgent({});
      await expect(agent.fetchL402("https://paywall.example.com/data", { maxAmountSats: "lots" }))
        .rejects.toThrow(/maxAmountSats must be a number/);
      expect(fetched).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

describe("batchTransferTokens fails closed on unreadable receiver", () => {
  it("throws when an entry has neither receiverSparkAddress nor to (was: silently skipped the allowlist)", async () => {
    let sent = null;
    const w = { batchTransferTokens: async (t) => { sent = t; return ["tx"]; } };
    const agent = mkAgent(w);
    await expect(
      agent.batchTransferTokens([{ tokenIdentifier: "btkn1x", tokenAmount: 50n, recieverSparkAddress: "sp1typo" }]),
    ).rejects.toThrow(/receiver cannot be checked/);
    expect(sent).toBeNull();
  });

  it("still accepts well-formed entries (receiverSparkAddress and the `to` alias)", async () => {
    let sent = null;
    const w = { batchTransferTokens: async (t) => { sent = t; return ["tx"]; } };
    const agent = mkAgent(w);
    await agent.batchTransferTokens([
      { tokenIdentifier: "btkn1x", tokenAmount: 50n, receiverSparkAddress: "sp1a" },
      { tokenIdentifier: "btkn1x", tokenAmount: 50n, to: "sp1b" },
    ]);
    expect(sent).toHaveLength(2);
  });
});
