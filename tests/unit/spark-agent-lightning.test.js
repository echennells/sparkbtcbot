// The amountless-invoice forwarding contract for SparkAgent.payLightningInvoice:
// the SDK REQUIRES amountSatsToSend for a zero-amount invoice and REJECTS it for
// an invoice that carries one. The wrapper takes `amountSats` for both and must
// forward it as amountSatsToSend ONLY in the amountless case — a bot's real
// payment failed because the wrapper estimated with the amount, then dropped it
// on the actual send.
import { describe, it, expect, afterEach } from "vitest";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

// Amount-ful sample (2,000 sats embedded) from light-bolt11-decoder's README.
const INVOICE_2000_SATS =
  "lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpqd4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpyw0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm03c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp54l567";

const AMOUNTLESS = "lnbc1notarealinvoice"; // undecodable => treated as amountless

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
    "TRANSFER_FAILED",
    "USER_TRANSFER_VALIDATION_FAILED",
    "PREIMAGE_PROVIDING_FAILED",
    "USER_SWAP_RETURN_FAILED",
    "USER_SWAP_RETURNED",
  ])("throws on %s instead of reporting a pending timeout", async (status) => {
    const agent = mkStatus(status);
    await expect(agent.payAndSettle(AMOUNTLESS, { amountSats: 500, pollMs: 1 })).rejects.toThrow(/failed/i);
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
