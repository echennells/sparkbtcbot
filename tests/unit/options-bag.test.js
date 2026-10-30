// Missing or null options, a non-object, and a BigInt where a number goes
// threw raw TypeErrors with no code: destructuring null, and JSON.stringify of
// a BigInt inside the message builder (ToB review 2026-10-28, F29). Each now
// gives a coded error, before any wallet or network call.
import { describe, it, expect, afterEach, vi } from "vitest";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { freshInvoice } from "../helpers/bolt11.js";
import { testSparkAddress } from "../helpers/spark-address.js";

const INVOICE = freshInvoice("lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpqd4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpyw0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm03c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp54l567");
const TO = testSparkAddress("MAINNET");
const RETRYABLE = ["yes", "no", "check-first"];

const orig = process.env.SPARK_LEAF_VAULT;
afterEach(() => {
  vi.unstubAllGlobals();
  if (orig === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = orig;
});
const mk = () => {
  process.env.SPARK_LEAF_VAULT = "off";
  const calls = [];
  const wallet = new Proxy({}, { get: (_, name) => (name === "then" ? undefined : async () => { calls.push(String(name)); return name === "getSparkAddress" ? TO : {}; }) });
  return { agent: new SparkAgent(wallet, "MAINNET"), calls };
};

describe("option bags and BigInts never throw an uncoded TypeError", () => {
  const cases = [
    ["transfer()", (a) => a.transfer(), "options"],
    ["transfer(null)", (a) => a.transfer(null), "options"],
    ["transfer('x')", (a) => a.transfer("x"), "options"],
    ["transfer({}) (no recipient)", (a) => a.transfer({}), "to"],
    ["transfer({ to }) (no amount)", (a) => a.transfer({ to: TO }), "amount"],
    ["transferTokens(null)", (a) => a.transferTokens(null), "options"],
    ["claimDeposit()", (a) => a.claimDeposit(), "options"],
    ["withdraw(null)", (a) => a.withdraw(null), "options"],
    ["withdraw({ to }) (no amount)", (a) => a.withdraw({ to: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" }), "amount"],
    ["payLightningInvoice(inv, [])", (a) => a.payLightningInvoice(INVOICE, []), "options"],
    ["claimDeposit vout 0n", (a) => a.claimDeposit({ txid: "ab".repeat(32), vout: 0n }), "vout"],
    ["payLightningInvoice transferId 5n", (a) => a.payLightningInvoice(INVOICE, { transferId: 5n }), "transferId"],
    ["getTokenTransactions limit 5n", (a) => a.getTokenTransactions({ limit: 5n }), "limit"],
    ["createTrackedInvoice(0n, 'm')", (a) => a.createTrackedInvoice(0n, "m"), undefined],
  ];
  for (const [label, call, field] of cases) {
    it(label, async () => {
      const { agent, calls } = mk();
      const err = await Promise.resolve().then(() => call(agent)).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.code, `${label}: ${err.message}`).toBeTypeOf("string");
      expect(RETRYABLE).toContain(err.retryable);
      if (field) expect(err.field).toBe(field);
      expect(calls.filter((n) => n !== "getSparkAddress")).toEqual([]);
    });
  }

  it("a fetchL402 body with a BigInt is BAD_INPUT (field body) before any fetch", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const err = await mk().agent.fetchL402("https://api.example/x", { method: "POST", body: { amount: 100n } }).catch((e) => e);
    expect(err).toMatchObject({ code: "BAD_INPUT", field: "body", retryable: "no" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("null where the bag is optional reads as no options", async () => {
    const { agent } = mk();
    expect(agent.forgetL402("https://api.example/x", null)).toBe(false);
    const err = await agent.payLightningInvoice(INVOICE, null).catch((e) => e);
    expect(err?.code).not.toBe("BAD_INPUT"); // it went on to the payment checks
  });
});
