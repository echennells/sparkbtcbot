// What a failed payment means (lib/payment-outcome.js). A spend is recorded
// before the SDK call; when the call throws, only an error that PROVES no
// funds left may undo it. Before 2026-09-26 every SDK error undid the spend,
// so a loop of ambiguous failures — each of which may have paid — was never
// counted, and the daily budget could not stop it.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SparkValidationError, SparkRequestError, decodeSparkAddress, encodeSparkAddress } from "@buildonspark/spark-sdk";
import { PRE_SEND_VALIDATION_MESSAGES, provesNothingSent, PaymentCommittedError } from "../../lib/payment-outcome.js";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

// Raised AFTER a request has gone out, while reading an operator's reply.
const POST_SEND_VALIDATION_MESSAGES = [
  "No transfer response from operator",
  "SSP coop exit response missing L1 transaction fields",
];

const sdkSource = async () => {
  const dist = join("node_modules", "@buildonspark", "spark-sdk", "dist");
  const files = (await readdir(dist)).filter((f) => f.endsWith(".js"));
  return (await Promise.all(files.map((f) => readFile(join(dist, f), "utf8")))).join("\n");
};

describe("provesNothingSent", () => {
  it("is true only for an allowlisted pre-send SparkValidationError", () => {
    expect(provesNothingSent(new SparkValidationError("Total target amount exceeds available balance", { field: "targetAmounts" }))).toBe(true);
    expect(provesNothingSent(new SparkValidationError("Invoice network: REGTEST does not match wallet network: MAINNET"))).toBe(true);
    expect(provesNothingSent(new SparkValidationError("maxFeeSats does not cover fee estimate"))).toBe(true);
  });

  it("is false for anything that may have sent: post-send validation, request and plain errors", () => {
    for (const m of POST_SEND_VALIDATION_MESSAGES) expect(provesNothingSent(new SparkValidationError(m))).toBe(false);
    expect(provesNothingSent(new SparkRequestError("Failed to initiate preimage swap", {}))).toBe(false);
    expect(provesNothingSent(new Error("Total target amount exceeds available balance"))).toBe(false); // right words, wrong type
    expect(provesNothingSent(new Error("deadline exceeded"))).toBe(false);
    expect(provesNothingSent(undefined)).toBe(false);
  });

  it("every allowlisted message is still raised by the installed SDK (re-audit on a mismatch)", async () => {
    const src = await sdkSource();
    for (const m of PRE_SEND_VALIDATION_MESSAGES) {
      const raised = src.includes(`new SparkValidationError("${m}`) || src.includes(`new SparkValidationError(\`${m}`);
      expect(raised, `"${m}" is no longer raised by spark-sdk — re-audit lib/payment-outcome.js`).toBe(true);
    }
    for (const m of POST_SEND_VALIDATION_MESSAGES) expect(src.includes(`new SparkValidationError("${m}`)).toBe(true);
  });
});

describe("PaymentCommittedError", () => {
  it("carries the rule-relevant facts and no secret", () => {
    const cause = new Error("deadline exceeded");
    const err = new PaymentCommittedError("may have paid", { settled: null, op: "lightning_pay", invoiceHash: "ab".repeat(32), cause });
    expect(err).toMatchObject({ name: "PaymentCommittedError", code: "PAYMENT_COMMITTED", settled: null, op: "lightning_pay", cause });
    expect(err).toBeInstanceOf(Error);
    expect(Object.keys(err)).not.toContain("preimage");
  });
});

describe("an unknown payment outcome stays counted against the budget", () => {
  const KEYS = ["SPARK_LEAF_VAULT", "SPARK_DAILY_BUDGET_SATS", "SPARK_SPEND_LEDGER_PATH", "SPARK_LN_DEDUP_PATH", "SPARK_SEED_PATH"];
  const saved = {};
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "payment-outcome-"));
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.SPARK_LEAF_VAULT = "off";
    process.env.SPARK_DAILY_BUDGET_SATS = "5000";
    process.env.SPARK_SPEND_LEDGER_PATH = join(dir, "ledger.json");
    process.env.SPARK_LN_DEDUP_PATH = join(dir, "ln-dedup");
    process.env.SPARK_SEED_PATH = join(dir, "seed.enc"); // absent → not sealed
  });
  afterEach(async () => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  const invoice2000 = async () =>
    (await readFile("node_modules/light-bolt11-decoder/README.md", "utf8")).match(/lnbc20u[a-z0-9]+/)[0];

  it("a loop of ambiguous Lightning failures is stopped by the daily budget", async () => {
    const inv = await invoice2000();
    let sdkCalls = 0;
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: async () => { sdkCalls++; throw new Error("deadline exceeded"); },
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    for (let i = 0; i < 2; i++) {
      await expect(agent.payLightningInvoice(inv, { maxAmountSats: 3000 })).rejects.toMatchObject({
        code: "PAYMENT_COMMITTED", settled: null, op: "lightning_pay",
        message: expect.stringMatching(/Retrying THIS invoice through payLightningInvoice is safe/),
      });
    }
    // 2 × 2,000 counted; a third 2,000 would pass 5,000 — refused before the SDK
    await expect(agent.payLightningInvoice(inv, { maxAmountSats: 3000 })).rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
    expect(sdkCalls).toBe(2);
  });

  it("a proven pre-send failure refunds the spend and is rethrown unchanged", async () => {
    const inv = await invoice2000();
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: async () => { throw new SparkValidationError("maxFeeSats does not cover fee estimate", { field: "maxFeeSats" }); },
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    await expect(agent.payLightningInvoice(inv, { maxAmountSats: 3000 })).rejects.toMatchObject({ name: "SparkValidationError" });
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 0 });
  });

  // A typo'd address used to come back as PAYMENT_COMMITTED with the amount
  // still counted: the SDK's decode error was not on the list. The mock runs
  // the SDK's real decoder, as transferInternal does before any request.
  it("a malformed or wrong-network address refunds instead of PAYMENT_COMMITTED", async () => {
    const G = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const wallet = {
      getSparkAddress: async () => "sp1from",
      transfer: async ({ receiverSparkAddress }) => {
        decodeSparkAddress(receiverSparkAddress, "MAINNET");
        throw new Error("unreachable: the decode must throw first");
      },
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    for (const to of ["sp1garbage", encodeSparkAddress({ identityPublicKey: G, network: "REGTEST" })]) {
      await expect(agent.transfer({ to, amount: 3000 })).rejects.toMatchObject({
        name: "SparkValidationError",
        message: expect.stringMatching(/^(Failed to decode Spark address|Invalid Spark address prefix)/),
      });
    }
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 0 });
  });
});
