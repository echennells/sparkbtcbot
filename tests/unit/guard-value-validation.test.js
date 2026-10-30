// Regression tests for the guard-VALUE validation (2026-08 adversarial review,
// 0.4.0 round): the release rejected misspelled option KEYS but not garbage
// numeric VALUES — `maxFeePct: "10%"` produced NaN, and NaN/Infinity silently
// disables the ceiling (the SDK's `feeCharged > maxFee` is false for NaN; the
// lib guards treat a non-finite cap as "no cap set"). Every money method must
// now throw on an unreadable numeric guard option BEFORE any I/O. Also covers
// batchTransferTokens failing closed on an entry whose receiver can't be read.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { freshInvoice } from "../helpers/bolt11.js";

// A decodable invoice: the option checks come after the invoice is read.
const INVOICE = freshInvoice("lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpqd4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpyw0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm03c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp54l567");

const origVault = process.env.SPARK_LEAF_VAULT;
beforeEach(() => { process.env.SPARK_LEAF_VAULT = "off"; });
afterEach(() => { if (origVault === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = origVault; });

const mkAgent = (wallet) => new SparkAgent(wallet, "MAINNET");

describe("claimDeposit guard-value validation", () => {
  const TX = "c1".repeat(32);
  const atStatic = {
    queryStaticDepositAddresses: async () => ["bc1pSTATIC"],
    getUnusedDepositAddresses: async () => [],
    getUtxosForDepositAddress: async () => [{ txid: TX, vout: 0 }],
  };
  const wallet = () => ({
    queryStaticDepositAddresses: async () => { throw new Error("I/O must not happen"); },
    getUnusedDepositAddresses: async () => { throw new Error("I/O must not happen"); },
    getClaimStaticDepositQuote: async () => { throw new Error("I/O must not happen"); },
    claimStaticDepositWithMaxFee: async () => { throw new Error("I/O must not happen"); },
  });

  it("throws on garbage maxFeePct (was: NaN cap -> SDK never trips -> unlimited haircut)", async () => {
    await expect(mkAgent(wallet()).claimDeposit({ txid: TX, maxFeePct: "10%" }))
      .rejects.toThrow(/maxFeePct must be a number/);
  });

  it("throws on garbage maxFeeSats", async () => {
    await expect(mkAgent(wallet()).claimDeposit({ txid: TX, maxFeeSats: "lots" }))
      .rejects.toThrow(/maxFeeSats must be a number/);
  });

  it("throws on NaN maxFeePct", async () => {
    await expect(mkAgent(wallet()).claimDeposit({ txid: TX, maxFeePct: NaN }))
      .rejects.toThrow(/maxFeePct must be a number/);
  });

  it("still accepts a valid explicit maxFeeSats (and a numeric string)", async () => {
    const calls = { claim: null };
    const w = {
      ...atStatic,
      getClaimStaticDepositQuote: async () => { throw new Error("quote must be skipped for explicit cap"); },
      claimStaticDepositWithMaxFee: async (p) => { calls.claim = p; return { claimed: true }; },
    };
    await mkAgent(w).claimDeposit({ txid: TX, maxFeeSats: "500" });
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
    await expect(mkAgent(wallet()).payLightningInvoice(INVOICE, { maxAmountSats: "lots" }))
      .rejects.toThrow(/maxAmountSats must be a number/);
  });

  it("throws on garbage maxFeeSats", async () => {
    await expect(mkAgent(wallet()).payLightningInvoice(INVOICE, { maxFeeSats: "ten" }))
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
    const token = "btkn1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqst3p42v";
    await agent.batchTransferTokens([
      { tokenIdentifier: token, tokenAmount: 50n, receiverSparkAddress: "sp1a" },
      { tokenIdentifier: token, tokenAmount: 50n, to: "sp1b" },
    ]);
    expect(sent).toHaveLength(2);
    // The `to` alias reaches the SDK as receiverSparkAddress (it used to be
    // checked against the allowlist, then forwarded raw — the SDK never saw it).
    expect(sent[1]).toEqual({ tokenIdentifier: token, tokenAmount: 50n, receiverSparkAddress: "sp1b" });
  });
});
