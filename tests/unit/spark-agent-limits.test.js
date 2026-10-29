// The user's spending limits (lib/spending-limits.js) through SparkAgent: one
// gate on every money-moving method, before any network call and in dry runs
// too, read fresh on every call; a daily limit counts on the spend ledger.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBech32mTokenIdentifier, encodeSparkAddress } from "@buildonspark/spark-sdk";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { writeLimits } from "../../lib/spending-limits.js";
import { testSparkAddress, testSparkInvoice, TEST_IDENTITY_PUBKEY } from "../helpers/spark-address.js";
import { freshInvoice } from "../helpers/bolt11.js";

const NET = "REGTEST";
const TO = testSparkAddress(NET);
const OTHER = testSparkAddress(NET, "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5");
const L1 = "bcrt1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const TOKEN = encodeBech32mTokenIdentifier({ tokenIdentifier: new Uint8Array(32).fill(7), network: NET });
const TXID = "ab".repeat(32);
// A sats Spark invoice to TO with its own id, so two can share a batch.
const sparkInvoice = (amount, id) => encodeSparkAddress({
  identityPublicKey: TEST_IDENTITY_PUBKEY,
  network: NET,
  sparkInvoiceFields: { version: 1, id: new Uint8Array(16).fill(id), paymentType: { $case: "satsPayment", satsPayment: { amount } } },
});
const invoice2000 = async () => {
  const md = await readFile("node_modules/light-bolt11-decoder/README.md", "utf8");
  return freshInvoice(md.match(/lnbc20u[a-z0-9]+/)[0]);
};

const ENV = ["SPARK_LIMITS_PATH", "SPARK_LEAF_VAULT", "SPARK_DAILY_BUDGET_SATS", "SPARK_SPEND_LEDGER_PATH"];
const saved = {};
let dir;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-limits-"));
  for (const k of ENV) saved[k] = process.env[k];
  delete process.env.SPARK_DAILY_BUDGET_SATS;
  Object.assign(process.env, {
    SPARK_LIMITS_PATH: join(dir, "limits.json"),
    SPARK_LEAF_VAULT: "off",
    SPARK_SPEND_LEDGER_PATH: join(dir, "ledger.json"),
  });
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  await rm(dir, { recursive: true, force: true });
  vi.unstubAllGlobals();
});

// Every wallet method is a spy that succeeds, so a test can say which ran.
const mkWallet = () => {
  const ok = (value) => vi.fn(async () => value);
  return {
    getSparkAddress: ok(TO),
    transfer: ok({ id: "t1" }),
    getLightningSendFeeEstimate: ok(5),
    payLightningInvoice: ok({ id: "ln1", paymentPreimage: "00".repeat(32) }),
    getLightningSendRequest: ok(null),
    fulfillSparkInvoice: ok({ satsTransactionSuccess: [], tokenTransactionSuccess: [], satsTransactionErrors: [], tokenTransactionErrors: [], invalidInvoices: [] }),
    transferTokens: ok("txhash"),
    batchTransferTokens: ok("txhash"),
    getWithdrawalFeeQuote: ok(null),
    withdraw: ok(null),
    queryStaticDepositAddresses: ok([]),
    getUtxosForDepositAddress: ok([]),
    getUnusedDepositAddresses: ok([]),
    getClaimStaticDepositQuote: ok(null),
    claimStaticDepositWithMaxFee: ok(null),
    getBalance: ok({ satsBalance: { available: 10_000n, owned: 10_000n, incoming: 0n }, tokenBalances: new Map() }),
  };
};
const calledNames = (wallet) => Object.entries(wallet).filter(([n, f]) => n !== "getSparkAddress" && f.mock.calls.length).map(([n]) => n);

// One call per gated method, with the operation the limits name it by.
const CALLS = [
  ["transfer", "spark_transfer", (a) => a.transfer({ to: TO, amount: 100 })],
  ["payLightningInvoice", "lightning_pay", async (a) => a.payLightningInvoice(await invoice2000(), { maxAmountSats: 3000 })],
  ["payAndSettle", "lightning_pay", async (a) => a.payAndSettle(await invoice2000(), { maxAmountSats: 3000 })],
  ["fulfillInvoice", "fulfill_spark_invoice", (a) => a.fulfillInvoice([{ invoice: testSparkInvoice(NET, { amount: 100 }) }])],
  ["transferTokens", "token_transfer", (a) => a.transferTokens({ tokenIdentifier: TOKEN, amount: 5n, to: TO })],
  ["batchTransferTokens", "token_transfer", (a) => a.batchTransferTokens([{ tokenIdentifier: TOKEN, tokenAmount: 5n, receiverSparkAddress: TO }])],
  ["withdraw", "l1_withdraw", (a) => a.withdraw({ to: L1, amount: 50_000 })],
  ["claimDeposit", "claim_deposit", (a) => a.claimDeposit({ txid: TXID })],
];
const ALL_OPS = ["spark_transfer", "lightning_pay", "fulfill_spark_invoice", "token_transfer", "l1_withdraw", "claim_deposit"];

describe("spending limits: allowedOps gates every money-moving method", () => {
  for (const [method, op, call] of CALLS) {
    it(`${method} (${op}) is refused before any wallet call`, async () => {
      await writeLimits({ allowedOps: ALL_OPS.filter((o) => o !== op) });
      const wallet = mkWallet();
      const err = await Promise.resolve().then(() => call(new SparkAgent(wallet, NET))).catch((e) => e);
      expect(err).toMatchObject({ code: "LIMIT_DENIED", retryable: "no", rule: "allowedOps", op });
      const via = method === "payAndSettle" ? "payLightningInvoice" : method; // payAndSettle pays through it
      expect(err.message).toMatch(new RegExp(`SparkAgent\\.${via}: refused by the user's spending limits.*Nothing was sent`));
      expect(err.nextStep).toMatch(/Only the user changes their limits, in their own message/);
      expect(calledNames(wallet)).toEqual([]);
    });
  }

  it("a dry run is refused too", async () => {
    await writeLimits({ allowedOps: ["lightning_pay"] });
    await expect(new SparkAgent(mkWallet(), NET).transfer({ to: TO, amount: 100, dryRun: true }))
      .rejects.toMatchObject({ code: "LIMIT_DENIED", rule: "allowedOps" });
  });

  it("fetchL402 meets the gate at its payment: one challenge fetched, nothing paid", async () => {
    await writeLimits({ allowedOps: ["spark_transfer"] });
    const inv = await invoice2000();
    const fetches = [];
    vi.stubGlobal("fetch", async (url) => {
      fetches.push(url);
      return { status: 402, headers: { get: () => "application/json" }, json: async () => ({ invoice: inv, macaroon: "mac1" }), text: async () => "" };
    });
    const wallet = mkWallet();
    await expect(new SparkAgent(wallet, NET).fetchL402("https://api.example/paid", { maxAmountSats: 3000 }))
      .rejects.toMatchObject({ code: "LIMIT_DENIED", op: "lightning_pay" });
    expect(fetches).toHaveLength(1);
    expect(calledNames(wallet)).toEqual([]);
  });

  it("reads and receiving are never gated", async () => {
    await writeLimits({ allowedOps: ["spark_transfer"] });
    const agent = new SparkAgent(mkWallet(), NET);
    await expect(agent.getBalance()).resolves.toMatchObject({ sats: "10000" });
  });
});

describe("spending limits: maxPaymentSats", () => {
  it("caps each sats payment, at the cap allowed", async () => {
    await writeLimits({ maxPaymentSats: 200 });
    const wallet = mkWallet();
    const agent = new SparkAgent(wallet, NET);
    await expect(agent.transfer({ to: TO, amount: 201 })).rejects.toMatchObject({ code: "LIMIT_DENIED", rule: "maxPaymentSats" });
    await agent.transfer({ to: TO, amount: 200 });
    expect(wallet.transfer).toHaveBeenCalledTimes(1);
  });

  it("uses the invoice's own amount for Lightning, and each invoice of a batch", async () => {
    await writeLimits({ maxPaymentSats: 1500 });
    const wallet = mkWallet();
    const agent = new SparkAgent(wallet, NET);
    await expect(agent.payLightningInvoice(await invoice2000(), { maxAmountSats: 3000 }))
      .rejects.toMatchObject({ code: "LIMIT_DENIED", rule: "maxPaymentSats" });
    await expect(agent.fulfillInvoice([{ invoice: sparkInvoice(1000, 1) }, { invoice: sparkInvoice(2000, 2) }]))
      .rejects.toMatchObject({ code: "LIMIT_DENIED", rule: "maxPaymentSats" });
    expect(calledNames(wallet)).toEqual([]);
  });

  it("doesn't apply to token transfers", async () => {
    await writeLimits({ maxPaymentSats: 1 });
    const wallet = mkWallet();
    await new SparkAgent(wallet, NET).transferTokens({ tokenIdentifier: TOKEN, amount: 1_000_000n, to: TO });
    expect(wallet.transferTokens).toHaveBeenCalledTimes(1);
  });
});

describe("spending limits: allowedRecipients", () => {
  it("refuses an address not on the list; the same identity in another form matches", async () => {
    await writeLimits({ allowedRecipients: [testSparkInvoice(NET)] }); // an invoice for TO's identity
    const wallet = mkWallet();
    const agent = new SparkAgent(wallet, NET);
    await expect(agent.transfer({ to: OTHER, amount: 100 })).rejects.toMatchObject({ code: "LIMIT_DENIED", rule: "allowedRecipients" });
    await agent.transfer({ to: TO, amount: 100 });
    expect(wallet.transfer).toHaveBeenCalledTimes(1);
  });

  it("matches an L1 address in either letter case, and leaves Lightning to allowedOps", async () => {
    await writeLimits({ allowedRecipients: [L1.toUpperCase()] });
    const wallet = mkWallet();
    const agent = new SparkAgent(wallet, NET);
    await expect(agent.withdraw({ to: L1, amount: 50_000 })).rejects.not.toMatchObject({ code: "LIMIT_DENIED" });
    expect(wallet.getWithdrawalFeeQuote).toHaveBeenCalledTimes(1);
    await agent.payLightningInvoice(await invoice2000(), { maxAmountSats: 3000 });
    expect(wallet.payLightningInvoice).toHaveBeenCalledTimes(1);
  });
});

describe("spending limits: dailyBudgetSats", () => {
  it("counts on the spend ledger with no other budget set, and says it is the user's own limit", async () => {
    await writeLimits({ dailyBudgetSats: 1000 });
    const wallet = mkWallet();
    const agent = new SparkAgent(wallet, NET);
    await agent.transfer({ to: TO, amount: 600 });
    const err = await agent.transfer({ to: TO, amount: 600 }).catch((e) => e);
    expect(err).toMatchObject({ code: "SPEND_BUDGET_EXCEEDED", retryable: "no" });
    expect(err.message).toMatch(/the user's own daily limit \(sparkbtcbot limits\)/);
    expect(err.message).not.toMatch(/SPARK_DAILY_BUDGET_SATS/);
    expect(wallet.transfer).toHaveBeenCalledTimes(1);
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 600, budgetSats: 1000, remainingSats: 400 });
  });

  it("the tighter of it and SPARK_DAILY_BUDGET_SATS applies", async () => {
    process.env.SPARK_DAILY_BUDGET_SATS = "5000";
    await writeLimits({ dailyBudgetSats: 1000 });
    const agent = new SparkAgent(mkWallet(), NET);
    await expect(agent.transfer({ to: TO, amount: 1500 })).rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
    await writeLimits({ dailyBudgetSats: 9000 });
    await expect(agent.transfer({ to: TO, amount: 6000 })).rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
    await agent.transfer({ to: TO, amount: 1500 });
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 1500, budgetSats: 5000 });
  });
});

describe("spending limits: read on every call, fail closed", () => {
  it("a change applies to the next call without a new agent", async () => {
    const wallet = mkWallet();
    const agent = new SparkAgent(wallet, NET);
    await agent.transfer({ to: TO, amount: 100 });
    await writeLimits({ allowedOps: ["lightning_pay"] });
    await expect(agent.transfer({ to: TO, amount: 100 })).rejects.toMatchObject({ code: "LIMIT_DENIED" });
    await writeLimits(null);
    await agent.transfer({ to: TO, amount: 100 });
    expect(wallet.transfer).toHaveBeenCalledTimes(2);
  });

  it("an unreadable file refuses every send (LIMITS_UNREADABLE) before any wallet call", async () => {
    await writeFile(process.env.SPARK_LIMITS_PATH, "{ not json");
    for (const [, , call] of CALLS) {
      const wallet = mkWallet();
      const err = await Promise.resolve().then(() => call(new SparkAgent(wallet, NET))).catch((e) => e);
      expect(err).toMatchObject({ code: "LIMITS_UNREADABLE", retryable: "no" });
      expect(calledNames(wallet)).toEqual([]);
    }
  });

  it("a misspelled rule is unreadable, never \"no limit\"", async () => {
    await writeFile(process.env.SPARK_LIMITS_PATH, JSON.stringify({ maxPaymentsSats: 100 }));
    await expect(new SparkAgent(mkWallet(), NET).transfer({ to: TO, amount: 100_000 }))
      .rejects.toMatchObject({ code: "LIMITS_UNREADABLE" });
  });
});
