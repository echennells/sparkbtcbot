// The amountless-invoice forwarding contract for SparkAgent.payLightningInvoice:
// the SDK REQUIRES amountSatsToSend for a zero-amount invoice and REJECTS it for
// an invoice that carries one. The wrapper takes `amountSats` for both and must
// forward it as amountSatsToSend ONLY in the amountless case — a bot's real
// payment failed because the wrapper estimated with the amount, then dropped it
// on the actual send.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UUID, SparkWallet, decodeSparkAddress } from "@buildonspark/spark-sdk";
import { decode } from "light-bolt11-decoder";
import { decodeInvoiceSats, invoicePaymentHash, paymentHashMatches } from "../../lib/bolt11.js";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { freshInvoice } from "../helpers/bolt11.js";

// Amount-ful sample (2,000 sats embedded) from light-bolt11-decoder's README.
const INVOICE_2000_SATS =
  freshInvoice("lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpqd4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpyw0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm03c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp54l567");

const AMOUNTLESS = "lnbc1notarealinvoice"; // undecodable => treated as amountless

// A 2,000-sat invoice whose preimage is known (sha256(0x42 × 32) is its payment
// hash; the same sample as spark-agent-l402.test.js), so payAndSettle's proof
// check passes for real.
const KNOWN_INVOICE = freshInvoice("lnbc20u1p4tzwuqpp5gf0dfe9rdvcw5gdepcsuwykxf85zznpfkl40dqyf6ypecmj48pxqsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsdp5wdcxzuntvf6xxcn0wss8getnwsazq6mwdamkugrswfjkjmtpvajsxqrrssfgmzf4e3aygc36mfrkgfj23fs5l3v4a0ztu34u5uu0ws9eycv4psq4msf75685vluz7kg7n3pvvzme375yjx63zjt2nxs9vgspgspvcp45esgz");
const KNOWN_PREIMAGE = "42".repeat(32);

const orig = process.env.SPARK_LEAF_VAULT;
afterEach(() => { if (orig === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = orig; });

const mkAgent = () => {
  process.env.SPARK_LEAF_VAULT = "off";
  const calls = { pay: null };
  const wallet = {
    getSparkAddress: async () => "sp1from",
    getLightningSendFeeEstimate: async () => 5,
    payLightningInvoice: async (params) => { calls.pay = params; return { id: "pay-1" }; },
  };
  return { agent: new SparkAgent(wallet, "MAINNET"), calls };
};

describe("payLightningInvoice amountSatsToSend forwarding", () => {
  it("FORWARDS amountSatsToSend for an amountless invoice when amountSats is given", async () => {
    const { agent, calls } = mkAgent();
    await agent.payLightningInvoice(AMOUNTLESS, { amountSats: 500 });
    expect(calls.pay).toMatchObject({ invoice: AMOUNTLESS, preferSpark: true, amountSatsToSend: 500 });
  });

  it("does NOT forward amountSatsToSend for an invoice that carries an amount (SDK rejects it)", async () => {
    const { agent, calls } = mkAgent();
    // prove the sample decodes (guards against a corrupted constant flipping the test's meaning)
    const preview = await agent.payLightningInvoice(INVOICE_2000_SATS, { dryRun: true });
    expect(preview.amount).toBe("2000");
    await agent.payLightningInvoice(INVOICE_2000_SATS, { amountSats: 2000 });
    expect(calls.pay).not.toBeNull();
    expect("amountSatsToSend" in calls.pay).toBe(false);
  });

  it("still fails CLOSED for an amountless invoice with no amount at all", async () => {
    const { agent, calls } = mkAgent();
    await expect(agent.payLightningInvoice(AMOUNTLESS, {})).rejects.toThrow(/blocked/i);
    expect(calls.pay).toBeNull(); // never reached the SDK
  });
});

// Persisted payment-dedup identity (spark-sdk >=0.10 transferId): the wrapper
// mints ONE id per invoice, write-ahead, and forwards it as the SDK's required
// instanceof-UUID object — so any retry of the same invoice (this process or
// the next) reuses it and the SDK's cross-rail dedup refuses a second payment.
describe("payLightningInvoice transferId dedup", () => {
  const saved = {};
  beforeEach(() => {
    saved.path = process.env.SPARK_LN_DEDUP_PATH;
    saved.flag = process.env.SPARK_LN_DEDUP;
  });
  afterEach(() => {
    if (saved.path === undefined) delete process.env.SPARK_LN_DEDUP_PATH; else process.env.SPARK_LN_DEDUP_PATH = saved.path;
    if (saved.flag === undefined) delete process.env.SPARK_LN_DEDUP; else process.env.SPARK_LN_DEDUP = saved.flag;
  });
  const mkIsolated = async () => {
    process.env.SPARK_LN_DEDUP_PATH = await mkdtemp(join(tmpdir(), "agent-ln-dedup-"));
    return { dir: process.env.SPARK_LN_DEDUP_PATH, ...mkAgent() };
  };

  it("forwards the SDK's UUID object and REUSES it for the same invoice across agents", async () => {
    const { calls } = await mkIsolated();
    const { agent, calls: calls1 } = mkAgent();
    await agent.payLightningInvoice(AMOUNTLESS, { amountSats: 500 });
    expect(calls1.pay.transferId).toBeInstanceOf(UUID); // the SDK rejects plain strings
    const firstId = calls1.pay.transferId.toString();
    // a SECOND agent over the same store (a restarted process) must reuse it
    const { agent: agent2, calls: calls2 } = mkAgent();
    await agent2.payLightningInvoice(AMOUNTLESS, { amountSats: 500 });
    expect(calls2.pay.transferId.toString()).toBe(firstId);
    expect(calls.pay).toBeNull(); // the throwaway from mkIsolated never paid
  });

  it("different invoices get different ids", async () => {
    await mkIsolated();
    const { agent, calls } = mkAgent();
    await agent.payLightningInvoice(AMOUNTLESS, { amountSats: 500 });
    const a = calls.pay.transferId.toString();
    await agent.payLightningInvoice(INVOICE_2000_SATS, {});
    expect(calls.pay.transferId.toString()).not.toBe(a);
  });

  it("SPARK_LN_DEDUP=off restores the SDK's mint-per-call behavior (no transferId sent)", async () => {
    await mkIsolated();
    process.env.SPARK_LN_DEDUP = "off";
    const { agent, calls } = mkAgent();
    await agent.payLightningInvoice(AMOUNTLESS, { amountSats: 500 });
    expect("transferId" in calls.pay).toBe(false);
  });

  it("an explicit transferId is used, persisted, and normalized through UUID.parse", async () => {
    await mkIsolated();
    const explicit = "0198F00D-0000-7000-8000-000000000001"; // uppercase on purpose
    const { agent, calls } = mkAgent();
    await agent.payLightningInvoice(AMOUNTLESS, { amountSats: 500, transferId: explicit });
    expect(calls.pay.transferId).toBeInstanceOf(UUID);
    expect(calls.pay.transferId.toString()).toBe(explicit.toLowerCase());
    // a later DISAGREEING explicit id for the same invoice must refuse
    const { agent: agent2, calls: calls2 } = mkAgent();
    await expect(
      agent2.payLightningInvoice(AMOUNTLESS, { amountSats: 500, transferId: "0198f00d-0000-7000-8000-000000000002" }),
    ).rejects.toThrow(/disagrees with the id already recorded/i);
    expect(calls2.pay).toBeNull();
  });

  it("garbage transferId throws before any I/O", async () => {
    await mkIsolated();
    const { agent, calls } = mkAgent();
    await expect(
      agent.payLightningInvoice(AMOUNTLESS, { amountSats: 500, transferId: "not-a-uuid" }),
    ).rejects.toThrow(/transferId must be a UUID string/i);
    expect(calls.pay).toBeNull();
  });

  it("dryRun neither mints nor persists (the store stays empty)", async () => {
    const { dir } = await mkIsolated();
    const { agent } = mkAgent();
    await agent.payLightningInvoice(INVOICE_2000_SATS, { dryRun: true });
    await expect(readdir(dir)).resolves.toEqual([]);
  });
});

// 2026-08-31 ToB audit fixes at the wrapper: translate the fallback rail's raw
// AlreadyExists into a settled verdict WHEN the store proves the id was reused;
// surface the dedup verdict on success; verify the settlement proof; and reset
// the entry after a terminal failure so the invoice stays payable.
describe("audit hardening (wrapper)", () => {
  const saved = {};
  beforeEach(() => { saved.path = process.env.SPARK_LN_DEDUP_PATH; });
  afterEach(() => {
    if (saved.path === undefined) delete process.env.SPARK_LN_DEDUP_PATH; else process.env.SPARK_LN_DEDUP_PATH = saved.path;
  });
  const mkIsolated = async () => {
    process.env.SPARK_LN_DEDUP_PATH = await mkdtemp(join(tmpdir(), "agent-audit-dedup-"));
    return { dir: process.env.SPARK_LN_DEDUP_PATH };
  };
  const mkThrowing = (err) => {
    process.env.SPARK_LEAF_VAULT = "off";
    const calls = { pay: 0 };
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: async () => { calls.pay++; if (err) throw err; return { id: "pay-1" }; },
    };
    return { agent: new SparkAgent(wallet, "MAINNET"), calls };
  };

  it("translates AlreadyExists into PAYMENT_ALREADY_SETTLED on a KNOWN retry", async () => {
    await mkIsolated();
    const grpcErr = new Error('rpc error: code = AlreadyExists desc = transfer already exists: duplicate key value violates unique constraint "transfers_pkey"');
    // first attempt records the id (succeeds)…
    const { agent: first } = mkThrowing(null);
    await first.payLightningInvoice(AMOUNTLESS, { amountSats: 500 });
    // …the retry hits the server-side dedup and must read as SETTLED
    const { agent: retry } = mkThrowing(grpcErr);
    await expect(retry.payLightningInvoice(AMOUNTLESS, { amountSats: 500 })).rejects.toMatchObject({
      code: "PAYMENT_ALREADY_SETTLED",
    });
  });

  it("passes AlreadyExists through RAW when the id was NOT reused (no proof to vouch)", async () => {
    await mkIsolated();
    const grpcErr = new Error("rpc error: code = AlreadyExists desc = transfer already exists");
    const { agent } = mkThrowing(grpcErr); // first-ever attempt for this store
    await expect(agent.payLightningInvoice(AMOUNTLESS, { amountSats: 500 })).rejects.toThrow(/AlreadyExists/);
    await expect(agent.payLightningInvoice(AMOUNTLESS, { amountSats: 500 })).rejects.toMatchObject({
      code: "PAYMENT_ALREADY_SETTLED", // second call: now reused — translated
    });
  });

  it("surfaces the dedup verdict on success (dedupReused false then true)", async () => {
    await mkIsolated();
    const { agent } = mkThrowing(null);
    const one = await agent.payLightningInvoice(AMOUNTLESS, { amountSats: 500 });
    expect(one.dedupReused).toBe(false);
    const two = await agent.payLightningInvoice(AMOUNTLESS, { amountSats: 500 });
    expect(two.dedupReused).toBe(true); // a replay, not a second debit
  });

  it("payAndSettle REFUSES a preimage that doesn't hash to the invoice's payment hash", async () => {
    await mkIsolated();
    process.env.SPARK_LEAF_VAULT = "off";
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: async () => ({ id: "pay-1", paymentPreimage: "aa".repeat(32) }),
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    await expect(agent.payAndSettle(INVOICE_2000_SATS, { pollMs: 1 })).rejects.toThrow(
      /does NOT hash to this invoice's payment hash/i,
    );
  });

  it("payAndSettle deletes the dedup entry on TERMINAL failure so a re-pay mints fresh", async () => {
    const { dir } = await mkIsolated();
    process.env.SPARK_LEAF_VAULT = "off";
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: async () => ({ id: "pay-1" }),
      getLightningSendRequest: async () => ({ status: "LIGHTNING_PAYMENT_FAILED" }),
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    await expect(agent.payAndSettle(AMOUNTLESS, { amountSats: 500, pollMs: 1 })).rejects.toThrow(/failed/i);
    await expect(readdir(dir)).resolves.toEqual([]); // entry gone — invoice re-payable
  });
});

// The raw SDK and the wrapper take DIFFERENT shapes (raw: one { invoice }
// object; wrapper: bare string + options). The raw layer crashes opaquely on a
// bare string ("reading 'toLowerCase'") — a real mainnet payment failed this
// way — so the wrapper direction must fail loud, name both shapes, and throw
// before any I/O.
describe("payLightningInvoice signature guard", () => {
  it("throws a shape-naming TypeError when given the raw-SDK object form", async () => {
    const { agent, calls } = mkAgent();
    await expect(
      agent.payLightningInvoice({ invoice: INVOICE_2000_SATS, maxFeeSats: 30 }),
    ).rejects.toThrow(/bare BOLT11 string.*not interchangeable/s);
    expect(calls.pay).toBeNull(); // never reached the SDK
  });

  it("covers payAndSettle too (it delegates the pay call)", async () => {
    const { agent, calls } = mkAgent();
    await expect(
      agent.payAndSettle({ invoice: INVOICE_2000_SATS }, { pollMs: 1 }),
    ).rejects.toThrow(TypeError);
    expect(calls.pay).toBeNull();
  });
});

// payLightningInvoice can return LIGHTNING_PAYMENT_INITIATED with no preimage;
// callers poll getLightningSendRequest(id) until it appears. The wrapper keeps
// the wallet private, so it must expose the passthrough itself — a live
// Bitrefill purchase had to drop to the raw SDK because it was missing.
describe("getLightningSendRequest passthrough", () => {
  it("forwards the send-request id to the wallet and returns its answer", async () => {
    process.env.SPARK_LEAF_VAULT = "off";
    let asked = null;
    const wallet = {
      getLightningSendRequest: async (id) => { asked = id; return { id, paymentPreimage: "aa".repeat(32) }; },
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    const status = await agent.getLightningSendRequest("pay-1");
    expect(asked).toBe("pay-1");
    expect(status.paymentPreimage).toBe("aa".repeat(32));
  });
});

// payAndSettle wraps the initiated->preimage poll loop; its timeout contract is
// "report unsettled, never retry-pay" (hold invoices stay pending legitimately).
describe("payAndSettle", () => {
  const mk = (sendRequestScript) => {
    process.env.SPARK_LEAF_VAULT = "off";
    let polls = 0;
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: async () => ({ id: "pay-1" }),
      getLightningSendRequest: async () => sendRequestScript(polls++),
    };
    return { agent: new SparkAgent(wallet, "MAINNET"), pollCount: () => polls };
  };

  it("polls until the preimage appears and reports settled", async () => {
    const { agent } = mk((n) => (n < 2 ? { status: "LIGHTNING_PAYMENT_INITIATED" } : { paymentPreimage: "aa".repeat(32) }));
    const r = await agent.payAndSettle(AMOUNTLESS, { amountSats: 500, pollMs: 1 });
    expect(r.settled).toBe(true);
    expect(r.paymentPreimage).toBe("aa".repeat(32));
  });

  it("returns a Spark-direct payment at once as settled, with no preimage and no polling", async () => {
    // The SDK paid the invoice's Spark fallback: a WalletTransfer comes back,
    // not a LightningSendRequest. Before, the loop polled Lightning status with
    // the transfer id for ~60 s and then reported settled: false.
    process.env.SPARK_LEAF_VAULT = "off";
    let polls = 0;
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 0,
      payLightningInvoice: async () => ({ id: "xfer-1", status: "TRANSFER_STATUS_SENDER_KEY_TWEAKED", transferDirection: "OUTGOING", totalValue: 500 }),
      getLightningSendRequest: async () => { polls++; return null; },
    };
    const r = await new SparkAgent(wallet, "MAINNET").payAndSettle(AMOUNTLESS, { amountSats: 500, pollMs: 1 });
    expect(r).toMatchObject({ id: "xfer-1", settled: true, sparkDirect: true, paymentPreimage: null });
    expect(polls).toBe(0);
  });

  it("a status read that throws is no news: polling goes on and the payment still settles", async () => {
    const { agent } = mk((n) => {
      if (n === 0) throw new Error("UNAVAILABLE: try again");
      return n < 2 ? { status: "LIGHTNING_PAYMENT_INITIATED" } : { paymentPreimage: "aa".repeat(32) };
    });
    const r = await agent.payAndSettle(AMOUNTLESS, { amountSats: 500, pollMs: 1 });
    expect(r).toMatchObject({ settled: true, paymentPreimage: "aa".repeat(32) });
  });

  it("throws on LIGHTNING_PAYMENT_FAILED", async () => {
    const { agent } = mk(() => ({ status: "LIGHTNING_PAYMENT_FAILED" }));
    await expect(agent.payAndSettle(AMOUNTLESS, { amountSats: 500, pollMs: 1 })).rejects.toThrow(/failed/i);
  });

  it("reports settled:false on poll exhaustion instead of throwing (never retry-pay)", async () => {
    const { agent, pollCount } = mk(() => ({ status: "LIGHTNING_PAYMENT_INITIATED" }));
    const r = await agent.payAndSettle(AMOUNTLESS, { amountSats: 500, pollMs: 1, maxPolls: 3 });
    expect(r.settled).toBe(false);
    expect(r.paymentPreimage).toBe(null);
    expect(pollCount()).toBe(3);
  });
});

// --- Audit regressions (2026-07-29 Trail of Bits pass) ---------------------
// Each test below fails against the code as it shipped that morning.

describe("amount-ceiling precedence (the guarded number must be the paid number)", () => {
  const mk = () => {
    process.env.SPARK_LEAF_VAULT = "off";
    const calls = { pay: null };
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: async (p) => { calls.pay = p; return { id: "pay-1" }; },
    };
    return { agent: new SparkAgent(wallet, "MAINNET"), calls };
  };

  it("BLOCKS an over-ceiling invoice even when the caller passes a small amountSats", async () => {
    // The bypass: caller says 100, the SDK pays the invoice's 2,000. Guarding
    // the caller's number would let an induced/injected parameter walk past the
    // ceiling; the invoice amount is authoritative.
    const { agent, calls } = mk();
    await expect(
      agent.payLightningInvoice(INVOICE_2000_SATS, { amountSats: 100, maxAmountSats: 500 }),
    ).rejects.toThrow(/disagrees with the invoice/i);
    expect(calls.pay).toBeNull(); // never reached the SDK
  });

  it("previews the INVOICE amount, not the caller's (the human gate must see the truth)", async () => {
    const { agent } = mk();
    const preview = await agent.payLightningInvoice(INVOICE_2000_SATS, { dryRun: true, maxAmountSats: 5_000 });
    expect(preview.amount).toBe("2000");
  });

  it("still accepts a matching amountSats and amountless invoices", async () => {
    const { agent } = mk();
    await agent.payLightningInvoice(INVOICE_2000_SATS, { amountSats: 2000, maxAmountSats: 5_000 });
    const { agent: a2, calls } = mk();
    await a2.payLightningInvoice(AMOUNTLESS, { amountSats: 500 });
    expect(calls.pay).toMatchObject({ amountSatsToSend: 500 });
  });
});

describe("payAndSettle terminal statuses", () => {
  const mkStatus = (status) => {
    process.env.SPARK_LEAF_VAULT = "off";
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: async () => ({ id: "pay-1" }),
      getLightningSendRequest: async () => ({ status }),
    };
    return new SparkAgent(wallet, "MAINNET");
  };

  // A refunded/failed payment that merely "times out" collides with the
  // never-retry-on-timeout rule and deadlocks the caller forever.
  it.each([
    "USER_TRANSFER_VALIDATION_FAILED",
    "USER_SWAP_RETURN_FAILED",
    "USER_SWAP_RETURNED",
  ])("throws on %s instead of reporting a pending timeout", async (status) => {
    const agent = mkStatus(status);
    await expect(agent.payAndSettle(AMOUNTLESS, { amountSats: 500, pollMs: 1 })).rejects.toThrow(/Lightning payment failed/);
  });

  // These come AFTER the Lightning payment succeeded (enum order): the payee
  // may have the money, so they throw PAYMENT_COMMITTED at once, not "failed".
  it.each(["TRANSFER_FAILED", "PREIMAGE_PROVIDING_FAILED"])("throws PAYMENT_COMMITTED on %s, promptly", async (status) => {
    const agent = mkStatus(status);
    await expect(agent.payAndSettle(AMOUNTLESS, { amountSats: 500, pollMs: 1 }))
      .rejects.toMatchObject({ code: "PAYMENT_COMMITTED", settled: null, op: "lightning_pay", message: expect.stringMatching(new RegExp(status)) });
  });

  it("reports lastStatus so a genuine pending is legible", async () => {
    const agent = mkStatus("LIGHTNING_PAYMENT_INITIATED");
    const r = await agent.payAndSettle(AMOUNTLESS, { amountSats: 500, pollMs: 1, maxPolls: 2 });
    expect(r).toMatchObject({ settled: false, lastStatus: "LIGHTNING_PAYMENT_INITIATED" });
  });
});

describe("fetchL402 strictness", () => {
  const agent = () => {
    process.env.SPARK_LEAF_VAULT = "off";
    return new SparkAgent({ getSparkAddress: async () => "sp1from" }, "MAINNET");
  };

  it("REFUSES an unknown option instead of silently ignoring it (dryRun used to pay)", async () => {
    await expect(agent().fetchL402("https://example.com/x", { dryRun: true })).rejects.toThrow(/unknown option/i);
  });

  it("refuses plaintext http (bearer credential + invoice over the wire)", async () => {
    await expect(agent().fetchL402("http://example.com/x")).rejects.toThrow(/https/i);
    await expect(agent().previewL402("http://example.com/x")).rejects.toThrow(/https/i);
  });

  it("allows localhost for testing", async () => {
    // Reaches the network layer (fetch fails), proving the scheme gate passed.
    await expect(agent().fetchL402("http://localhost:9/x")).rejects.not.toThrow(/https/i);
  });
});

// Spark-direct pays an invoice's Spark fallback as a plain transfer to the
// fallback key: the payment hash plays no part and no preimage comes back. A
// payment pinned to a hash (a merchant checkout's) must go over Lightning, or
// the pin checks nothing. Everything else keeps Spark-direct.
describe("Spark-direct and hash-bound payments", () => {
  const HASH = invoicePaymentHash(INVOICE_2000_SATS);
  const mk = () => {
    process.env.SPARK_LEAF_VAULT = "off";
    const calls = { pay: null, estimates: 0 };
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => { calls.estimates++; return 5; },
      payLightningInvoice: async (params) => { calls.pay = params; return { id: "pay-1" }; },
    };
    return { agent: new SparkAgent(wallet, "MAINNET"), calls };
  };

  it("pays Spark-direct by default, and when expectedPaymentHash is null (no binding)", async () => {
    for (const opts of [{}, { expectedPaymentHash: null }]) {
      const { agent, calls } = mk();
      await agent.payLightningInvoice(INVOICE_2000_SATS, opts);
      expect(calls.pay.preferSpark).toBe(true);
    }
  });

  it("pays over Lightning when expectedPaymentHash matches, or with preferSpark: false", async () => {
    for (const opts of [{ expectedPaymentHash: HASH }, { expectedPaymentHash: HASH.toUpperCase() }, { preferSpark: false }]) {
      const { agent, calls } = mk();
      await agent.payLightningInvoice(INVOICE_2000_SATS, opts);
      expect(calls.pay.preferSpark).toBe(false);
    }
  });

  it("refuses a hash mismatch before any I/O, dry run included", async () => {
    for (const dryRun of [false, true]) {
      const { agent, calls } = mk();
      await expect(agent.payLightningInvoice(INVOICE_2000_SATS, { expectedPaymentHash: "bb".repeat(32), dryRun }))
        .rejects.toThrow(/Payment blocked: .*is not expectedPaymentHash/);
      expect(calls.estimates).toBe(0);
      expect(calls.pay).toBeNull();
    }
  });

  it("refuses preferSpark: true with a hash, and malformed values", async () => {
    const { agent, calls } = mk();
    await expect(agent.payLightningInvoice(INVOICE_2000_SATS, { expectedPaymentHash: HASH, preferSpark: true }))
      .rejects.toThrow(/ignores the payment hash/);
    await expect(agent.payLightningInvoice(INVOICE_2000_SATS, { expectedPaymentHash: "abc" })).rejects.toThrow(TypeError);
    await expect(agent.payLightningInvoice(INVOICE_2000_SATS, { expectedPaymentHash: 42 })).rejects.toThrow(TypeError);
    await expect(agent.payLightningInvoice(INVOICE_2000_SATS, { preferSpark: "no" })).rejects.toThrow(TypeError);
    expect(calls.pay).toBeNull();
  });

  it("the dry-run preview says whether Spark-direct is allowed", async () => {
    const { agent } = mk();
    expect((await agent.payLightningInvoice(INVOICE_2000_SATS, { dryRun: true })).preferSpark).toBe(true);
    expect((await agent.payLightningInvoice(INVOICE_2000_SATS, { dryRun: true, expectedPaymentHash: HASH })).preferSpark).toBe(false);
  });

  it("payAndSettle passes the binding through", async () => {
    const { agent, calls } = mk();
    await expect(agent.payAndSettle(INVOICE_2000_SATS, { expectedPaymentHash: "bb".repeat(32) })).rejects.toThrow(/Payment blocked/);
    expect(calls.pay).toBeNull();
    await agent.payAndSettle(INVOICE_2000_SATS, { expectedPaymentHash: HASH, maxPolls: 0 });
    expect(calls.pay.preferSpark).toBe(false);
  });
});

// The attack the binding exists for, through the REAL SDK payLightningInvoice
// (network edges stubbed). A Spark fallback spliced into a signed invoice
// keeps its hash, amount and description: nothing checks the signature
// without an `n` tag. (An attacker can also get a properly SSP-signed invoice
// with the merchant's hash and their own fallback, via
// createLightningHodlInvoice; the wrapper sees the same thing.)
describe("a spliced Spark fallback, through the real SDK", () => {
  // The secp256k1 generator: a valid key nobody was shown.
  const ATTACKER = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
  // Minimal BIP-173 bech32 (BOLT11's encoding), so the test needs no
  // transitive dependency.
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  const polymod = (values) => {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
    }
    return chk;
  };
  const hrpExpand = (hrp) => [...[...hrp].map((c) => c.charCodeAt(0) >> 5), 0, ...[...hrp].map((c) => c.charCodeAt(0) & 31)];
  const toWords = (bytes) => {
    const out = [];
    let acc = 0, bits = 0;
    for (const b of bytes) {
      acc = (acc << 8) | b; bits += 8;
      while (bits >= 5) { bits -= 5; out.push((acc >> bits) & 31); }
    }
    if (bits > 0) out.push((acc << (5 - bits)) & 31);
    return out;
  };
  // Appends one route hint (pubkey, Spark's short channel id) and keeps the
  // ORIGINAL signature.
  const spliceSparkHint = (invoice, pubkeyHex) => {
    const sep = invoice.lastIndexOf("1");
    const hrp = invoice.slice(0, sep);
    const words = [...invoice.slice(sep + 1, -6)].map((c) => CHARSET.indexOf(c));
    const hop = new Uint8Array(51);
    hop.set(Buffer.from(pubkeyHex, "hex"), 0);
    hop.set(Buffer.from("f42400f424000001", "hex"), 33);
    const hopWords = toWords(hop);
    const r = [3, hopWords.length >> 5, hopWords.length & 31, ...hopWords];
    const data = [...words.slice(0, -104), ...r, ...words.slice(-104)];
    const mod = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
    const checksum = [0, 1, 2, 3, 4, 5].map((i) => (mod >> (5 * (5 - i))) & 31);
    return `${hrp}1${[...data, ...checksum].map((w) => CHARSET[w]).join("")}`;
  };
  const MERCHANT_HASH = invoicePaymentHash(INVOICE_2000_SATS);
  const TAMPERED = spliceSparkHint(INVOICE_2000_SATS, ATTACKER);

  const mkSdkAgent = () => {
    process.env.SPARK_LEAF_VAULT = "off";
    const rails = [];
    const wallet = Object.create(SparkWallet.prototype);
    Object.assign(wallet, {
      logger: { warn() {}, info() {}, debug() {}, error() {}, trace() {} },
      assertInvoiceNetworkMatchesWallet: () => 0, // Network.MAINNET
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      getSspClient: () => ({}),
      transferInternal: async ({ receiverSparkAddress }) => { rails.push(["spark", receiverSparkAddress]); return { id: "xfer-1" }; },
      leafManager: { selectLeavesAndExecute: async () => { rails.push(["lightning"]); return { id: "ln-1", encodedInvoice: TAMPERED, status: "LIGHTNING_PAYMENT_INITIATED" }; } },
    });
    return { agent: new SparkAgent(wallet, "MAINNET"), rails };
  };

  it("keeps the merchant's hash and amount, so the checkout checks pass (the premise)", () => {
    expect(paymentHashMatches(TAMPERED, MERCHANT_HASH)).toBe(true);
    expect(decodeInvoiceSats(TAMPERED)).toBe(2000);
    expect(decode(TAMPERED).sections.some((s) => s.name === "payee")).toBe(false);
    expect(decode(TAMPERED).route_hints.flat().some((h) => h.short_channel_id === "f42400f424000001" && h.pubkey === ATTACKER)).toBe(true);
  });

  it("bound to the merchant's hash, it goes over Lightning, never to the spliced key", async () => {
    const { agent, rails } = mkSdkAgent();
    const r = await agent.payLightningInvoice(TAMPERED, { maxAmountSats: 5000, expectedPaymentHash: MERCHANT_HASH });
    expect(rails).toEqual([["lightning"]]);
    expect("encodedInvoice" in r).toBe(true);
  });

  it("unbound, it goes Spark-direct to the spliced key: no worse than a swapped invoice", async () => {
    const { agent, rails } = mkSdkAgent();
    await agent.payLightningInvoice(TAMPERED, { maxAmountSats: 5000 });
    expect(rails.map(([rail]) => rail)).toEqual(["spark"]);
    expect(decodeSparkAddress(rails[0][1], "MAINNET").identityPublicKey).toBe(ATTACKER);
  });
});

// What hosted REGTEST did (2026-10-02): the SDK's
// payLightningInvoice answered TRANSFER_COMPLETED with the preimage and a fee
// of 0 msat before the SSP had priced the payment; a status read right after
// said 5,000 msat, and 1,005 sats had left for a 1,000-sat invoice. The
// wrapper passed that 0 on, and the funded test's fee check passed vacuously.
// The fee now comes from status reads, a 0 counts only when the transfer
// confirms it, and an unknown fee is reported as the cap with a note.
describe("the reported Lightning fee", () => {
  const msat = (v) => ({ originalValue: v, originalUnit: "MILLISATOSHI" });
  const sats = (v) => ({ originalValue: v, originalUnit: "SATOSHI" });
  // `reads`: what each status read adds to a settled send request, the last
  // repeating. `answer`: "completed" (preimage at once, fee 0), "initiated"
  // (no preimage yet) or "spark" (paid over Spark: a transfer, not a send request).
  // `frozen`: the SDK's answer comes back frozen. `onRead`: runs at the start
  // of each status read, with the number of that read.
  const mk = ({ answer = "completed", reads = [{ fee: msat(0) }], readThrows = null, frozen = false, onRead = null } = {}) => {
    process.env.SPARK_LEAF_VAULT = "off";
    const asked = [];
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: async (p) => {
        if (answer === "spark") return { id: "0199c0de-0000-7000-8000-00000000bbbb", status: "TRANSFER_STATUS_COMPLETED", leaves: [] };
        const base = { id: "ls-1", encodedInvoice: p.invoice, fee: msat(0) };
        const r = answer === "completed" ? { ...base, status: "TRANSFER_COMPLETED", paymentPreimage: KNOWN_PREIMAGE } : { ...base, status: "LIGHTNING_PAYMENT_INITIATED" };
        return frozen ? Object.freeze(r) : r;
      },
      getLightningSendRequest: async (id) => {
        asked.push(id);
        await onRead?.(asked.length);
        if (readThrows) throw readThrows;
        const extra = reads[Math.min(asked.length, reads.length) - 1];
        return { id, encodedInvoice: KNOWN_INVOICE, status: "TRANSFER_COMPLETED", paymentPreimage: KNOWN_PREIMAGE, ...extra };
      },
    };
    return { agent: new SparkAgent(wallet, "MAINNET"), asked };
  };
  // payLightningInvoice waits 2 s between reads: record the waits, skip them.
  let waits;
  const KEYS = ["SPARK_LN_DEDUP_PATH"];
  const saved = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    waits = [];
    const real = globalThis.setTimeout;
    vi.stubGlobal("setTimeout", (fn, ms, ...args) => (waits.push(ms), real(fn, 0, ...args)));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
    }
  });

  it("a completed answer with fee 0: the fee comes from the status read that follows", async () => {
    const { agent, asked } = mk({ reads: [{ fee: msat(5_000) }] });
    const r = await agent.payLightningInvoice(KNOWN_INVOICE, { maxFeeSats: 30 });
    expect(r).toMatchObject({ id: "ls-1", status: "TRANSFER_COMPLETED", feeSats: 5 });
    expect(r.feeNote).toBeUndefined();
    expect(r.fee).toEqual(msat(0)); // the SDK's own first answer, left as it came
    expect(asked).toEqual(["ls-1"]);
    expect(waits).toEqual([]);
  });

  it("the fee is what the transfer took beyond the amount when the SSP reports less; a 0 counts when the transfer confirms it", async () => {
    let { agent } = mk({ reads: [{ fee: msat(0), transfer: { totalAmount: sats(2_007) } }] });
    expect((await agent.payLightningInvoice(KNOWN_INVOICE, { maxFeeSats: 30 })).feeSats).toBe(7);
    ({ agent } = mk({ reads: [{ fee: msat(0), transfer: { totalAmount: sats(2_000) } }] }));
    const zero = await agent.payLightningInvoice(KNOWN_INVOICE, { maxFeeSats: 30 });
    expect(zero.feeSats).toBe(0);
    expect(zero.feeNote).toBeUndefined();
    ({ agent } = mk({ reads: [{ fee: msat(5_001) }] }));
    expect((await agent.payLightningInvoice(KNOWN_INVOICE, { maxFeeSats: 30 })).feeSats).toBe(6); // whole sats, rounded up
  });

  it("priced on a later read: reads go on, 2 s apart, until one says", async () => {
    const { agent, asked } = mk({ reads: [{ fee: msat(0) }, { fee: msat(0) }, { fee: msat(6_000) }] });
    const r = await agent.payLightningInvoice(KNOWN_INVOICE, { maxFeeSats: 30 });
    expect(r.feeSats).toBe(6);
    expect(asked).toHaveLength(3);
    expect(waits).toEqual([2_000, 2_000]);
  });

  it("a fee of 0 with no transfer to check it against, on every read: the cap, with a note", async () => {
    const { agent, asked } = mk();
    const r = await agent.payLightningInvoice(KNOWN_INVOICE, { maxFeeSats: 30 });
    expect(r.feeSats).toBe(30);
    expect(r.feeNote).toMatch(/fee cap: the wallet hasn't reported what this payment cost\. It was at most 30 sats/);
    expect(asked).toHaveLength(5);
    expect(waits).toEqual([2_000, 2_000, 2_000, 2_000]);
  });

  it("status reads that fail: the payment still succeeds, its fee reported as the cap", async () => {
    const { agent, asked } = mk({ readThrows: new Error("unavailable") });
    const r = await agent.payLightningInvoice(KNOWN_INVOICE, { maxFeeSats: 30 });
    expect(r).toMatchObject({ status: "TRANSFER_COMPLETED", paymentPreimage: KNOWN_PREIMAGE, feeSats: 30 });
    expect(r.feeNote).toMatch(/at most 30 sats/);
    expect(asked).toHaveLength(5);
  });

  it("a frozen SDK answer: the result is a copy, so it keeps dedupReused and gains feeSats without throwing", async () => {
    // Writing the fields onto a frozen answer would throw a TypeError after
    // the money has left, and a paid payment would come back as an error.
    process.env.SPARK_LN_DEDUP_PATH = await mkdtemp(join(tmpdir(), "agent-ln-fee-dedup-"));
    const { agent } = mk({ frozen: true, reads: [{ fee: msat(5_000) }] });
    const r = await agent.payLightningInvoice(KNOWN_INVOICE, { maxFeeSats: 30 });
    expect(r).toMatchObject({ status: "TRANSFER_COMPLETED", paymentPreimage: KNOWN_PREIMAGE, dedupReused: false, feeSats: 5 });
    expect(Object.isFrozen(r)).toBe(false);
  });

  it("the default cap stands in when no maxFeeSats is passed", async () => {
    const { agent } = mk();
    expect((await agent.payLightningInvoice(KNOWN_INVOICE)).feeSats).toBe(25); // lightningFeeCap: max(25, 0.5% of 2,000)
  });

  it("not settled yet: no reads, the cap with a note", async () => {
    const { agent, asked } = mk({ answer: "initiated" });
    const r = await agent.payLightningInvoice(KNOWN_INVOICE, { maxFeeSats: 30 });
    expect(r).toMatchObject({ status: "LIGHTNING_PAYMENT_INITIATED", feeSats: 30 });
    expect(r.feeNote).toMatch(/hasn't settled/);
    expect(asked).toEqual([]);
  });

  it("paid over Spark (the invoice's fallback): no Lightning fee, no reads", async () => {
    const { agent, asked } = mk({ answer: "spark" });
    const r = await agent.payLightningInvoice(KNOWN_INVOICE, { maxFeeSats: 30 });
    expect(r.feeSats).toBe(0);
    expect(r.feeNote).toBeUndefined();
    expect(asked).toEqual([]);
  });

  it("payAndSettle: the read that brings the preimage counts as the first fee read; the next prices it", async () => {
    const { agent, asked } = mk({ answer: "initiated", reads: [{ fee: msat(0) }, { fee: msat(6_000) }] });
    const r = await agent.payAndSettle(KNOWN_INVOICE, { maxFeeSats: 30, pollMs: 7 });
    expect(r).toMatchObject({ settled: true, paymentPreimage: KNOWN_PREIMAGE, feeSats: 6 });
    expect(r.feeNote).toBeUndefined();
    expect(asked).toHaveLength(2);
    expect(waits).toEqual([7, 7]); // one poll, then one fee read at payAndSettle's pace
  });

  it("payAndSettle on a completed answer reads the fee once (not twice through payLightningInvoice)", async () => {
    const { agent, asked } = mk({ reads: [{ fee: msat(5_000) }] });
    const r = await agent.payAndSettle(KNOWN_INVOICE, { maxFeeSats: 30, pollMs: 7 });
    expect(r).toMatchObject({ settled: true, feeSats: 5, fee: msat(0) });
    expect(asked).toEqual(["ls-1"]);
  });

  it("payAndSettle: unpriced after every read, or never settled: the cap, with a note saying which", async () => {
    let { agent } = mk({ answer: "completed" });
    const unpriced = await agent.payAndSettle(KNOWN_INVOICE, { maxFeeSats: 30, pollMs: 1 });
    expect(unpriced).toMatchObject({ settled: true, feeSats: 30 });
    expect(unpriced.feeNote).toMatch(/hasn't reported/);
    const pending = { status: "LIGHTNING_PAYMENT_INITIATED", paymentPreimage: undefined };
    ({ agent } = mk({ answer: "initiated", reads: [pending] }));
    const open = await agent.payAndSettle(KNOWN_INVOICE, { maxFeeSats: 30, pollMs: 1, maxPolls: 3 });
    expect(open).toMatchObject({ settled: false, feeSats: 30 });
    expect(open.feeNote).toMatch(/hasn't settled/);
  });

  it("fetchL402 doesn't read the fee: it reports none, and its paid pass is waiting to be presented", async () => {
    const { agent, asked } = mk();
    let n = 0;
    const res = (status, body) => ({ status, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) });
    vi.stubGlobal("fetch", async () => (++n === 1 ? res(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" }) : res(200, { ok: true })));
    const r = await agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 });
    expect(r).toMatchObject({ paid: true, preimage: KNOWN_PREIMAGE, data: { ok: true } });
    expect(asked).toEqual([]);
    expect(waits).toEqual([]);
  });

  it("a dry run reports no fee fields", async () => {
    const { agent } = mk();
    const preview = await agent.payLightningInvoice(KNOWN_INVOICE, { dryRun: true, maxFeeSats: 30 });
    expect(preview).not.toHaveProperty("feeSats");
    expect(await agent.payAndSettle(KNOWN_INVOICE, { dryRun: true, maxFeeSats: 30 })).not.toHaveProperty("feeSats");
  });
});

// ToB review 2026-10-26.
describe("payment-safety edges", () => {
  const TWO_HASHES = "lnbc10u1p54twgqpp5424242424242424242424242424242424242424242424242424qpp5hwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwamhwassp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsctsqx6xtn594jaehtkrgmjfzdaymv0tn5punzgw907zta6k5p8l8apveqx3q5uj58avd8xnnjylgndlk9sk36ar3e4j769aghj6cm4cppd49ag";

  it("refuses to pay an invoice with two payment hashes, before the SDK", async () => {
    const { agent, calls } = mkAgent();
    await expect(agent.payLightningInvoice(TWO_HASHES, { maxAmountSats: 5000 })).rejects.toThrow(/carries 2 payment hashes/);
    expect(calls.pay).toBeNull();
  });

  // Hosted REGTEST, 2026-10-26: paying an expired tracked invoice locked 303
  // sats in a PREIMAGE_SWAP transfer stuck at SENDER_KEY_TWEAK_PENDING, which
  // expires 16 days later; the SDK checks nothing before locking the coins.
  // Each expiry test gets its own empty dedup store: the store is keyed by
  // payment hash, and other tests here have attempted KNOWN_INVOICE's.
  const withFreshDedup = async (fn) => {
    const prev = process.env.SPARK_LN_DEDUP_PATH;
    process.env.SPARK_LN_DEDUP_PATH = mkdtempSync(join(tmpdir(), "ln-dedup-expiry-"));
    try {
      await fn();
    } finally {
      if (prev === undefined) delete process.env.SPARK_LN_DEDUP_PATH;
      else process.env.SPARK_LN_DEDUP_PATH = prev;
    }
  };

  it("refuses an invoice that expired or has under 30 s left, before any I/O", () => withFreshDedup(async () => {
    const now = Math.floor(Date.now() / 1000);
    const at = (secondsLeft) => freshInvoice(KNOWN_INVOICE, now - 3600 + secondsLeft); // KNOWN_INVOICE: expiry 3600
    const { agent, calls } = mkAgent();
    for (const left of [-600, -1, 0, 29]) {
      for (const dryRun of [true, false]) {
        await expect(agent.payLightningInvoice(at(left), { maxAmountSats: 5000, dryRun }), `${left}s`).rejects.toMatchObject({ code: "INVOICE_EXPIRED", message: expect.stringMatching(/unclear outcome.*getTransfers/s) });
      }
    }
    expect(calls.pay).toBeNull();
    await expect(agent.payLightningInvoice(at(90), { maxAmountSats: 5000, dryRun: true })).resolves.toMatchObject({ dryRun: true });
  }));

  // The retry an unclear outcome invites ("retrying THIS invoice is safe")
  // can come after the invoice expired. "Nothing was sent" is then true of the
  // retry only: the first attempt may have paid, and the payee's new invoice
  // would be a second payment.
  it("an expired invoice with an earlier attempt on record is PAYMENT_COMMITTED, not 'ask for a new one'", () => withFreshDedup(async () => {
    const now = Math.floor(Date.now() / 1000);
    const inv = freshInvoice(KNOWN_INVOICE, now - 3600 + 90); // 90 s left
    let attempts = 0;
    process.env.SPARK_LEAF_VAULT = "off";
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: async () => { attempts++; throw new Error("deadline exceeded"); }, // proves nothing
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    await expect(agent.payLightningInvoice(inv, { maxAmountSats: 5000 })).rejects.toMatchObject({ code: "PAYMENT_COMMITTED" });
    const clock = vi.spyOn(Date, "now").mockReturnValue((now + 180) * 1000); // the invoice has expired
    try {
      await expect(agent.payLightningInvoice(inv, { maxAmountSats: 5000 })).rejects.toMatchObject({
        code: "PAYMENT_COMMITTED", reason: "INVOICE_EXPIRED_AFTER_ATTEMPT", settled: null, message: expect.stringMatching(/earlier attempt.*getTransfers/s),
      });
    } finally {
      clock.mockRestore();
    }
    expect(attempts).toBe(1);
  }));

  // ToB review of 9bc0f22..f88fbec (F2): the dedup id was minted before the
  // budget check, so an attempt the budget refused (or the SDK refused before
  // sending) left an entry that, once the invoice expired, read as "an earlier
  // attempt may have paid". An attempt that provably sent nothing forgets the
  // id it minted.
  it("an attempt that provably sent nothing leaves no 'earlier attempt' behind", () => withFreshDedup(async () => {
    const { SparkValidationError } = await import("@buildonspark/spark-sdk");
    const now = Math.floor(Date.now() / 1000);
    process.env.SPARK_LEAF_VAULT = "off";
    const expired = () => vi.spyOn(Date, "now").mockReturnValue((now + 180) * 1000);

    // Refused by the SDK before sending.
    const inv = freshInvoice(KNOWN_INVOICE, now - 3600 + 90);
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: async () => { throw new SparkValidationError("Total target amount exceeds available balance", { field: "amount" }); },
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    await expect(agent.payLightningInvoice(inv, { maxAmountSats: 5000 })).rejects.toMatchObject({ name: "SparkValidationError" });
    let clock = expired();
    try {
      await expect(agent.payLightningInvoice(inv, { maxAmountSats: 5000 })).rejects.toMatchObject({ code: "INVOICE_EXPIRED" });
    } finally {
      clock.mockRestore();
    }

    // Refused by the spend budget before the SDK was called.
    const dir = mkdtempSync(join(tmpdir(), "budget-"));
    const saved = { b: process.env.SPARK_DAILY_BUDGET_SATS, p: process.env.SPARK_SPEND_LEDGER_PATH };
    process.env.SPARK_DAILY_BUDGET_SATS = "100";
    process.env.SPARK_SPEND_LEDGER_PATH = join(dir, "ledger.json");
    try {
      const inv2 = freshInvoice(KNOWN_INVOICE, now - 3600 + 91);
      const capped = new SparkAgent(wallet, "MAINNET");
      await expect(capped.payLightningInvoice(inv2, { maxAmountSats: 5000 })).rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
      clock = expired();
      try {
        await expect(capped.payLightningInvoice(inv2, { maxAmountSats: 5000 })).rejects.toMatchObject({ code: "INVOICE_EXPIRED" });
      } finally {
        clock.mockRestore();
      }
    } finally {
      for (const [k, v] of [["SPARK_DAILY_BUDGET_SATS", saved.b], ["SPARK_SPEND_LEDGER_PATH", saved.p]]) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }));

  // ToB review of 375e6fb..HEAD: ONE payment hash of the wrong length passed
  // the count check, read as no hash, and the preimage check then passed any
  // preimage. Built from KNOWN_INVOICE by padding its p field to 35 bytes (the
  // decoder checks neither the length nor the signature).
  it("refuses to pay an invoice whose one payment hash is not 32 bytes, before the SDK", async () => {
    const { bech32 } = await import("@scure/base");
    const { prefix, words } = bech32.decode(KNOWN_INVOICE, 10_000);
    const out = words.slice(0, 7);
    const sigStart = words.length - 104;
    for (let i = 7; i < sigStart; ) {
      const type = words[i], len = words[i + 1] * 32 + words[i + 2];
      const data = type === 1 ? [...words.slice(i + 3, i + 3 + len), 0, 0, 0, 0] : words.slice(i + 3, i + 3 + len);
      out.push(type, data.length >> 5, data.length & 31, ...data);
      i += 3 + len;
    }
    const SHORT = bech32.encode(prefix, [...out, ...words.slice(sigStart)], 10_000);
    const { agent, calls } = mkAgent();
    for (const dryRun of [true, false]) {
      await expect(agent.payLightningInvoice(SHORT, { maxAmountSats: 5000, dryRun })).rejects.toThrow(/not a 32-byte hash/);
    }
    expect(calls.pay).toBeNull();
  });

  it("a status after the Lightning payment succeeded is not a failure: the payee has the money", async () => {
    const { isTerminalLightningFailure } = await import("../../skills/sparkbtcbot/scripts/spark-agent.js");
    for (const s of ["PREIMAGE_PROVIDING_FAILED", "TRANSFER_FAILED", "LIGHTNING_PAYMENT_SUCCEEDED", "SOMETHING_NEW_FAILED", undefined]) {
      expect(isTerminalLightningFailure(s), String(s)).toBe(false);
    }
    for (const s of ["USER_TRANSFER_VALIDATION_FAILED", "LIGHTNING_PAYMENT_FAILED", "PENDING_USER_SWAP_RETURN", "USER_SWAP_RETURNED", "USER_SWAP_RETURN_FAILED"]) {
      expect(isTerminalLightningFailure(s), s).toBe(true);
    }
  });

  it("payAndSettle on PREIMAGE_PROVIDING_FAILED throws PAYMENT_COMMITTED instead of 'failed'", async () => {
    process.env.SPARK_LEAF_VAULT = "off";
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: async () => ({ id: "pay-1", encodedInvoice: AMOUNTLESS }),
      getLightningSendRequest: async () => ({ status: "PREIMAGE_PROVIDING_FAILED" }),
    };
    await expect(new SparkAgent(wallet, "MAINNET").payAndSettle(AMOUNTLESS, { amountSats: 500, pollMs: 1, maxPolls: 3 }))
      .rejects.toMatchObject({ code: "PAYMENT_COMMITTED", sendId: "pay-1" });
  });
});

