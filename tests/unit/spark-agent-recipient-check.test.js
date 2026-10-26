// A dry run must refuse what the send would refuse. The SDK decodes a
// transfer's recipient only at send time, so a typo, an address for the other
// network, a silent payment address or a Spark invoice used to preview fine
// and then fail (ToB sharp-edges SE-6). And a withdraw whose SSP record comes
// back empty has already moved the leaves, so it must not look retryable.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { encodeBech32mTokenIdentifier } from "@buildonspark/spark-sdk";
import { testSparkAddress, testSparkInvoice } from "../helpers/spark-address.js";
import { createSilentPaymentReceiver } from "../helpers/silent-payment.js";

const orig = process.env.SPARK_LEAF_VAULT;
beforeEach(() => { process.env.SPARK_LEAF_VAULT = "off"; });
afterEach(() => { if (orig === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = orig; });

const noSend = () => { throw new Error("a dry run must not reach the SDK send"); };
const agentOn = (network) =>
  new SparkAgent({ getSparkAddress: async () => testSparkAddress(network), transfer: noSend, transferTokens: noSend }, network);

describe("transfer({ dryRun }) checks the recipient like the send does", () => {
  it("previews a valid address for the wallet's network", async () => {
    const to = testSparkAddress("MAINNET");
    const preview = await agentOn("MAINNET").transfer({ to, amount: 1000, dryRun: true });
    expect(preview).toMatchObject({ dryRun: true, to, amount: "1000", network: "MAINNET" });
  });

  it("refuses a malformed address", async () => {
    await expect(agentOn("MAINNET").transfer({ to: "sp1x", amount: 1000, dryRun: true }))
      .rejects.toThrow(/is not a MAINNET Spark address/);
  });

  it("refuses an address for the other network", async () => {
    await expect(agentOn("MAINNET").transfer({ to: testSparkAddress("REGTEST"), amount: 1000, dryRun: true }))
      .rejects.toThrow(/is not a MAINNET Spark address/);
  });

  it("refuses a silent payment address and points to withdraw", async () => {
    const { address } = createSilentPaymentReceiver("MAINNET");
    expect(address).toMatch(/^sp1q/);
    await expect(agentOn("MAINNET").transfer({ to: address, amount: 1000, dryRun: true }))
      .rejects.toThrow(/silent payment address.*withdraw/);
  });

  it("refuses a Spark invoice and points to fulfillInvoice", async () => {
    await expect(agentOn("MAINNET").transfer({ to: testSparkInvoice("MAINNET"), amount: 1000, dryRun: true }))
      .rejects.toThrow(/Spark invoice.*fulfillInvoice/);
  });

  it("refuses an empty recipient", async () => {
    await expect(agentOn("MAINNET").transfer({ to: "", amount: 1000, dryRun: true }))
      .rejects.toThrow(/is not a MAINNET Spark address/);
  });
});

describe("transferTokens({ dryRun }) checks the recipient too", () => {
  const TOKEN = encodeBech32mTokenIdentifier({ tokenIdentifier: new Uint8Array(32).fill(7), network: "REGTEST" });
  it("previews a valid address", async () => {
    const preview = await agentOn("REGTEST").transferTokens({ tokenIdentifier: TOKEN, amount: 5n, to: testSparkAddress("REGTEST"), dryRun: true });
    expect(preview).toMatchObject({ dryRun: true, operation: "token_transfer" });
  });

  it("refuses a malformed or wrong-network address", async () => {
    for (const to of ["sprt1nope", testSparkAddress("MAINNET")]) {
      await expect(agentOn("REGTEST").transferTokens({ tokenIdentifier: TOKEN, amount: 5n, to, dryRun: true }))
        .rejects.toThrow(/is not a REGTEST Spark address/);
    }
  });
});

describe("withdraw with no SSP record", () => {
  it("throws a do-not-retry error marked paid, instead of returning null", async () => {
    const wallet = {
      getWithdrawalFeeQuote: async () => ({ id: "q1", userFeeMedium: { originalValue: 100 }, l1BroadcastFeeMedium: { originalValue: 0 } }),
      withdraw: async () => null,
      getSparkAddress: async () => testSparkAddress("MAINNET"),
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    const err = await agent.withdraw({ to: "bc1qexampledestination", amount: 100000 }).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/exit was sent.*Do NOT retry/);
    expect(err.paid).toBe(true);
  });
});
