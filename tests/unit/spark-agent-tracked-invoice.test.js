// "One Lightning invoice per order" needs an invoice the shop can check. The
// wrapper's createLightningInvoice returns only the BOLT11, and its default
// Spark fallback lets a Spark wallet pay with a plain transfer that never marks
// the invoice paid (hosted REGTEST, 2026-10-26). createTrackedInvoice turns the
// fallback off and returns the id; getInvoiceStatus reads it. getTokenTransactions
// is where to look after a token send threw PAYMENT_COMMITTED: getTransfers()
// lists sats only. (ToB review of 375e6fb..HEAD.)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encodeBech32mTokenIdentifier } from "@buildonspark/spark-sdk";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

const orig = process.env.SPARK_LEAF_VAULT;
beforeEach(() => { process.env.SPARK_LEAF_VAULT = "off"; });
afterEach(() => { if (orig === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = orig; });

const HASH = "ab".repeat(32);
const mk = (overrides = {}) => {
  const calls = {};
  const wallet = {
    getSparkAddress: async () => "sparkrt1me",
    createLightningInvoice: async (p) => {
      calls.create = p;
      return { id: "rr-1", status: "INVOICE_CREATED", invoice: { encodedInvoice: "lnbcrt1…", paymentHash: HASH, expiresAt: "2026-10-26T21:00:00Z", amount: { originalValue: 1000, originalUnit: "SATOSHI" } } };
    },
    getLightningReceiveRequest: async (id) => (id === "rr-1"
      ? { id, status: calls.status ?? "INVOICE_CREATED", invoice: { paymentHash: HASH, expiresAt: "2026-10-26T21:00:00Z", amount: { originalValue: 1000, originalUnit: "SATOSHI" } } }
      : null),
    queryTokenTransactionsWithFilters: async (p) => { calls.tokens = p; return { tokenTransactionsWithStatus: [] }; },
    ...overrides,
  };
  return { agent: new SparkAgent(wallet, "REGTEST"), calls };
};

describe("createTrackedInvoice + getInvoiceStatus", () => {
  it("creates the invoice without the Spark fallback and returns what the shop keeps", async () => {
    const { agent, calls } = mk();
    const order = await agent.createTrackedInvoice(1000, "Order A1042", { expirySeconds: 600 });
    expect(calls.create).toEqual({ amountSats: 1000, memo: "Order A1042", expirySeconds: 600, includeSparkAddress: false });
    expect(order).toEqual({ id: "rr-1", invoice: "lnbcrt1…", paymentHash: HASH, expiresAt: "2026-10-26T21:00:00Z" });
    await expect(agent.createTrackedInvoice(1000, "x", { includeSparkAddress: true })).rejects.toThrow(/unknown option/i);
  });

  it("paid only once the sats are in the wallet; null for an id it doesn't know", async () => {
    const { agent, calls } = mk();
    expect(await agent.getInvoiceStatus("rr-1")).toMatchObject({ status: "INVOICE_CREATED", paid: false, amountSats: 1000, paymentHash: HASH });
    calls.status = "LIGHTNING_PAYMENT_RECEIVED";
    expect(await agent.getInvoiceStatus("rr-1")).toMatchObject({ paid: false });
    calls.status = "TRANSFER_COMPLETED";
    expect(await agent.getInvoiceStatus("rr-1")).toMatchObject({ paid: true });
    expect(await agent.getInvoiceStatus("rr-2")).toBeNull();
    await expect(agent.getInvoiceStatus()).rejects.toThrow(/pass the id/);
  });
});

describe("getTokenTransactions", () => {
  it("asks for this wallet's transactions, one token's when given (canonical id)", async () => {
    const { agent, calls } = mk();
    await agent.getTokenTransactions();
    expect(calls.tokens).toEqual({ sparkAddresses: ["sparkrt1me"], pageSize: 20 });
    const id = encodeBech32mTokenIdentifier({ tokenIdentifier: new Uint8Array(32).fill(3), network: "REGTEST" });
    await agent.getTokenTransactions({ tokenIdentifier: ` ${id} `, limit: 5 });
    expect(calls.tokens).toEqual({ sparkAddresses: ["sparkrt1me"], tokenIdentifiers: [id], pageSize: 5 });
    const mainnet = encodeBech32mTokenIdentifier({ tokenIdentifier: new Uint8Array(32).fill(3), network: "MAINNET" });
    await expect(agent.getTokenTransactions({ tokenIdentifier: mainnet })).rejects.toThrow(/not a REGTEST token identifier/);
  });
});
