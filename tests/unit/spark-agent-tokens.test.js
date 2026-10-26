// Token sends get the same input checks and failure rule as sats sends. Before,
// a float or negative amount went straight to the SDK, another network's token
// id reached it unchecked, a batch entry written with the `to` alias went out
// with no receiverSparkAddress, and any SDK error came back raw, inviting a
// retry after a broadcast that may have gone through.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SparkValidationError, encodeBech32mTokenIdentifier } from "@buildonspark/spark-sdk";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { testSparkAddress } from "../helpers/spark-address.js";

const orig = process.env.SPARK_LEAF_VAULT;
beforeEach(() => { process.env.SPARK_LEAF_VAULT = "off"; });
afterEach(() => { if (orig === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = orig; });

const tokenOn = (network, fill = 7) => encodeBech32mTokenIdentifier({ tokenIdentifier: new Uint8Array(32).fill(fill), network });
const TO = testSparkAddress("MAINNET");

const mk = (overrides = {}) => {
  const calls = { transferTokens: [], batchTransferTokens: [] };
  const wallet = {
    getSparkAddress: async () => testSparkAddress("MAINNET"),
    transferTokens: async (p) => { calls.transferTokens.push(p); return "txid-1"; },
    batchTransferTokens: async (o) => { calls.batchTransferTokens.push(o); return "txid-2"; },
    ...overrides,
  };
  return { agent: new SparkAgent(wallet, "MAINNET"), calls };
};

describe("transferTokens input checks", () => {
  it("refuses a float, a negative, zero, or a string amount before the SDK", async () => {
    const { agent, calls } = mk();
    for (const amount of [1.5, -1, 0, 0n, "10"]) {
      await expect(agent.transferTokens({ tokenIdentifier: tokenOn("MAINNET"), amount, to: TO }))
        .rejects.toThrow(/positive integer of the token's base units/);
    }
    expect(calls.transferTokens).toHaveLength(0);
  });

  it("refuses another network's token id before the SDK", async () => {
    const { agent, calls } = mk();
    await expect(agent.transferTokens({ tokenIdentifier: tokenOn("REGTEST"), amount: 5n, to: TO }))
      .rejects.toThrow(/is not a MAINNET token identifier/);
    expect(calls.transferTokens).toHaveLength(0);
  });

  it("sends the canonical id and a bigint amount", async () => {
    const { agent, calls } = mk();
    await agent.transferTokens({ tokenIdentifier: tokenOn("MAINNET"), amount: 5, to: TO });
    expect(calls.transferTokens[0]).toEqual({ tokenIdentifier: tokenOn("MAINNET"), tokenAmount: 5n, receiverSparkAddress: TO });
  });
});

describe("token sends follow the failed-payment rule", () => {
  it("a pre-send SDK error is rethrown as is", async () => {
    const { agent } = mk({ transferTokens: async () => { throw new SparkValidationError("Insufficient token amount", { field: "tokenAmount" }); } });
    await expect(agent.transferTokens({ tokenIdentifier: tokenOn("MAINNET"), amount: 5n, to: TO }))
      .rejects.toMatchObject({ name: "SparkValidationError" });
  });

  it("any other error throws PAYMENT_COMMITTED: the transaction may have gone out", async () => {
    const { agent } = mk({ batchTransferTokens: async () => { throw new Error("deadline exceeded"); } });
    await expect(agent.batchTransferTokens([{ tokenIdentifier: tokenOn("MAINNET"), tokenAmount: 5n, receiverSparkAddress: TO }]))
      .rejects.toMatchObject({ code: "PAYMENT_COMMITTED", settled: null, op: "token_transfer" });
  });
});

describe("batchTransferTokens", () => {
  it("normalizes entries for the SDK, the `to` alias included", async () => {
    const { agent, calls } = mk();
    await agent.batchTransferTokens([
      { tokenIdentifier: tokenOn("MAINNET"), tokenAmount: 5n, receiverSparkAddress: TO },
      { tokenIdentifier: tokenOn("MAINNET"), amount: 7, to: TO },
    ]);
    expect(calls.batchTransferTokens[0]).toEqual([
      { tokenIdentifier: tokenOn("MAINNET"), tokenAmount: 5n, receiverSparkAddress: TO },
      { tokenIdentifier: tokenOn("MAINNET"), tokenAmount: 7n, receiverSparkAddress: TO },
    ]);
  });

  it("refuses unknown entry keys, both amount spellings, and an empty batch", async () => {
    const { agent, calls } = mk();
    await expect(agent.batchTransferTokens([{ tokenIdentifier: tokenOn("MAINNET"), tokenAmount: 5n, to: TO, memo: "x" }]))
      .rejects.toThrow(/unknown option/i);
    await expect(agent.batchTransferTokens([{ tokenIdentifier: tokenOn("MAINNET"), tokenAmount: 5n, amount: 5n, to: TO }]))
      .rejects.toThrow(/sets both tokenAmount and amount/);
    await expect(agent.batchTransferTokens([])).rejects.toThrow(/non-empty array/);
    expect(calls.batchTransferTokens).toHaveLength(0);
  });

  it("dryRun previews each entry and each token's total without sending", async () => {
    const { agent, calls } = mk();
    const preview = await agent.batchTransferTokens([
      { tokenIdentifier: tokenOn("MAINNET", 1), tokenAmount: 5n, to: TO },
      { tokenIdentifier: tokenOn("MAINNET", 1), tokenAmount: 6n, to: TO },
      { tokenIdentifier: tokenOn("MAINNET", 2), tokenAmount: 1n, to: TO },
    ], { dryRun: true });
    expect(preview).toMatchObject({
      dryRun: true,
      totals: [
        { tokenIdentifier: tokenOn("MAINNET", 1), amount: "11" },
        { tokenIdentifier: tokenOn("MAINNET", 2), amount: "1" },
      ],
    });
    expect(preview.entries).toHaveLength(3);
    expect(calls.batchTransferTokens).toHaveLength(0);
  });
});

describe("token dry runs refuse what the send refuses (ToB review 2026-10-26)", () => {
  it("transferTokens({ dryRun }) refuses a Spark invoice: the SDK's send does", async () => {
    const { testSparkInvoice } = await import("../helpers/spark-address.js");
    const { agent, calls } = mk();
    await expect(agent.transferTokens({ tokenIdentifier: tokenOn("MAINNET"), amount: 5n, to: testSparkInvoice("MAINNET"), dryRun: true }))
      .rejects.toThrow(/Spark invoice.*fulfillInvoice/);
    expect(calls.transferTokens).toHaveLength(0);
  });

  it("a batch entry naming two different recipients is refused, not silently resolved", async () => {
    const { agent } = mk();
    await expect(agent.batchTransferTokens([{ tokenIdentifier: tokenOn("MAINNET"), tokenAmount: 5n, receiverSparkAddress: TO, to: testSparkAddress("MAINNET", "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5") }]))
      .rejects.toThrow(/two different recipients/);
  });
});

