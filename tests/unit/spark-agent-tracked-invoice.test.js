// "One Lightning invoice per order" needs an invoice the shop can check. The
// wrapper's createLightningInvoice returns only the BOLT11, and its default
// Spark fallback lets a Spark wallet pay with a plain transfer that never marks
// the invoice paid (hosted REGTEST, 2026-10-26). createTrackedInvoice turns the
// fallback off and returns the id; getInvoiceStatus reads it as a state a shop
// can act on. getTokenTransactions is where to look after a token send threw
// PAYMENT_COMMITTED: getTransfers() lists sats only. (ToB reviews of
// 375e6fb..HEAD and of 7ec89b9.)
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { encodeBech32mTokenIdentifier, encodeSparkAddress } from "@buildonspark/spark-sdk";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

const orig = process.env.SPARK_LEAF_VAULT;
beforeEach(() => { process.env.SPARK_LEAF_VAULT = "off"; });
afterEach(() => { if (orig === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = orig; });

const HASH = "ab".repeat(32);
const ME = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798"; // G
const THEM = "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5"; // 2G
const iso = (ms) => new Date(ms).toISOString();

const mk = (overrides = {}) => {
  const calls = {};
  const wallet = {
    getSparkAddress: async () => encodeSparkAddress({ identityPublicKey: ME, network: "REGTEST" }),
    getIdentityPublicKey: async () => ME,
    createLightningInvoice: async (p) => {
      calls.create = p;
      return { id: "rr-1", status: "INVOICE_CREATED", invoice: { encodedInvoice: "lnbcrt1…", paymentHash: HASH, expiresAt: "2026-10-26T21:00:00Z", amount: { originalValue: 1000, originalUnit: "SATOSHI" } } };
    },
    getLightningReceiveRequest: async (id) => (id === "rr-1"
      ? { id, status: calls.status ?? "INVOICE_CREATED", invoice: { paymentHash: HASH, expiresAt: calls.expiresAt ?? iso(Date.now() + 3_600_000), amount: { originalValue: 1000, originalUnit: "SATOSHI" } } }
      : null),
    queryTokenTransactionsWithFilters: async (p) => { calls.tokens = p; return { tokenTransactionsWithStatus: calls.txs ?? [] }; },
    queryTokenTransactionsByTxHashes: async (h) => { calls.byHash = h; return { tokenTransactionsWithStatus: calls.txs ?? [] }; },
    ...overrides,
  };
  return { agent: new SparkAgent(wallet, "REGTEST"), calls };
};

describe("createTrackedInvoice", () => {
  it("creates the invoice without the Spark fallback and returns what the shop keeps", async () => {
    const { agent, calls } = mk();
    const order = await agent.createTrackedInvoice(1000, "Order A1042", { expirySeconds: 600 });
    expect(calls.create).toEqual({ amountSats: 1000, memo: "Order A1042", expirySeconds: 600, includeSparkAddress: false });
    expect(order).toEqual({ id: "rr-1", invoice: "lnbcrt1…", paymentHash: HASH, expiresAt: "2026-10-26T21:00:00Z" });
    await expect(agent.createTrackedInvoice(1000, "x", { includeSparkAddress: true })).rejects.toThrow(/unknown option/i);
  });

  // An amountless invoice lets the payer choose: a 1-sat payment would mark a
  // priced order paid.
  it("refuses an amountless invoice", async () => {
    const { agent, calls } = mk();
    await expect(agent.createTrackedInvoice(0, "Order A1042")).rejects.toThrow(/at least 1/);
    expect(calls.create).toBeUndefined();
  });
});

describe("getInvoiceStatus states", () => {
  const status = async (s, { expiresAt } = {}) => {
    const { agent, calls } = mk();
    calls.status = s;
    if (expiresAt) calls.expiresAt = expiresAt;
    return agent.getInvoiceStatus("rr-1");
  };

  it("maps each SSP status to a state a shop can act on", async () => {
    const table = {
      INVOICE_CREATED: ["unpaid", false],
      TRANSFER_CREATED: ["in_progress", null],
      PAYMENT_PREIMAGE_RECOVERED: ["in_progress", null],
      LIGHTNING_PAYMENT_RECEIVED: ["received", true],
      TRANSFER_COMPLETED: ["paid", true],
      TRANSFER_CREATION_FAILED: ["failed", false],
      REFUND_SIGNING_COMMITMENTS_QUERYING_FAILED: ["failed", false],
      REFUND_SIGNING_FAILED: ["failed", false],
      PAYMENT_PREIMAGE_RECOVERING_FAILED: ["failed", false],
      TRANSFER_FAILED: ["failed_after_payment", true],
      FUTURE_VALUE: ["unknown", null], // SDK 0.14's word for HTLC_RECEIVED, HTLC_FAILED and the SSP's other new statuses
      SOMETHING_NEW: ["unknown", null],
    };
    for (const [s, [state, charged]] of Object.entries(table)) {
      const r = await status(s);
      expect([s, r.state, r.customerCharged, r.paid]).toEqual([s, state, charged, state === "paid"]);
    }
  });

  it("allows a new invoice only after expiry plus a grace period, and only while unpaid or failed", async () => {
    const now = Date.now();
    expect(await status("INVOICE_CREATED")).toMatchObject({ expired: false, canReinvoice: false });
    expect(await status("INVOICE_CREATED", { expiresAt: iso(now - 30_000) })).toMatchObject({ expired: true, canReinvoice: false }); // inside the grace
    expect(await status("INVOICE_CREATED", { expiresAt: iso(now - 5 * 60_000) })).toMatchObject({ expired: true, canReinvoice: true });
    expect(await status("REFUND_SIGNING_FAILED")).toMatchObject({ canReinvoice: false }); // a failure before expiry may not be final
    expect(await status("REFUND_SIGNING_FAILED", { expiresAt: iso(now - 5 * 60_000) })).toMatchObject({ canReinvoice: true });
    for (const s of ["LIGHTNING_PAYMENT_RECEIVED", "TRANSFER_COMPLETED", "TRANSFER_FAILED", "TRANSFER_CREATED", "FUTURE_VALUE"]) {
      expect(await status(s, { expiresAt: iso(now - 60 * 60_000) }), s).toMatchObject({ canReinvoice: false });
    }
  });

  it("null for an id it doesn't know; an id is required", async () => {
    const { agent } = mk();
    expect(await agent.getInvoiceStatus("rr-2")).toBeNull();
    await expect(agent.getInvoiceStatus()).rejects.toThrow(/pass the id/);
  });
});

describe("getTokenTransactions / getTokenTransaction", () => {
  const TOKEN = new Uint8Array(32).fill(3);
  const TOKEN_ID = encodeBech32mTokenIdentifier({ tokenIdentifier: TOKEN, network: "REGTEST" });
  const be = (n) => { const b = new Uint8Array(16); let v = BigInt(n); for (let i = 15; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; } return b; };
  const tx = (hashByte, status, outputs, at) => ({
    tokenTransactionHash: new Uint8Array(32).fill(hashByte),
    status,
    tokenTransaction: {
      tokenInputs: { $case: "transferInput", transferInput: { outputsToSpend: [] } },
      tokenOutputs: outputs.map(([owner, amount]) => ({ ownerPublicKey: Buffer.from(owner, "hex"), tokenIdentifier: TOKEN, tokenAmount: be(amount) })),
      clientCreatedTimestamp: new Date(at),
    },
  });

  it("asks for the newest page and returns readable entries, newest first", async () => {
    const { agent, calls } = mk();
    // The operators return a page oldest-first.
    calls.txs = [tx(1, 2, [[THEM, 100], [ME, 900]], "2026-10-26T19:00:00Z"), tx(2, 1, [[THEM, 5], [ME, 895]], "2026-10-26T20:00:00Z")];
    const list = await agent.getTokenTransactions({ tokenIdentifier: ` ${TOKEN_ID} `, limit: 5 });
    expect(calls.tokens).toMatchObject({ tokenIdentifiers: [TOKEN_ID], pageSize: 5, direction: "PREVIOUS" });
    expect(list.map((t) => t.hash)).toEqual(["02".repeat(32), "01".repeat(32)]);
    expect(list[0]).toEqual({
      hash: "02".repeat(32),
      status: "pending",
      statusCode: "TOKEN_TRANSACTION_SIGNED",
      type: "transfer",
      createdAt: "2026-10-26T20:00:00.000Z",
      outputs: [
        { to: encodeSparkAddress({ identityPublicKey: THEM, network: "REGTEST" }), mine: false, tokenIdentifier: TOKEN_ID, amount: "5" },
        { to: encodeSparkAddress({ identityPublicKey: ME, network: "REGTEST" }), mine: true, tokenIdentifier: TOKEN_ID, amount: "895" },
      ],
    });
    expect(list[1]).toMatchObject({ status: "finalized", statusCode: "TOKEN_TRANSACTION_FINALIZED" });
  });

  it("reads cancelled and unknown statuses, amounts past 2^53, and survives an owner key that won't encode", async () => {
    const { agent, calls } = mk();
    calls.txs = [tx(3, 4, [[THEM, 2n ** 70n], ["02" + "11".repeat(32), 1]], "2026-10-26T19:00:00Z"), tx(4, 10, [], "2026-10-26T19:01:00Z")];
    const [unknown, cancelled] = await agent.getTokenTransactions();
    expect(cancelled).toMatchObject({ status: "cancelled", outputs: [{ amount: String(2n ** 70n) }, { to: null, mine: false, amount: "1" }] });
    expect(unknown).toMatchObject({ status: "unknown", statusCode: "10", outputs: [] });
  });

  it("refuses unknown options, a bad limit, and another network's token id", async () => {
    const { agent } = mk();
    await expect(agent.getTokenTransactions({ pageSize: 5 })).rejects.toThrow(/unknown option/i);
    for (const limit of [0, 101, 2.5, "5"]) await expect(agent.getTokenTransactions({ limit })).rejects.toThrow(/limit must be/);
    const mainnet = encodeBech32mTokenIdentifier({ tokenIdentifier: TOKEN, network: "MAINNET" });
    await expect(agent.getTokenTransactions({ tokenIdentifier: mainnet })).rejects.toThrow(/not a REGTEST token identifier/);
  });

  it("getTokenTransaction(hash) looks one up by the hash a send returned; null when none", async () => {
    const { agent, calls } = mk();
    expect(await agent.getTokenTransaction("AB".repeat(32))).toBeNull();
    expect(calls.byHash).toEqual(["ab".repeat(32)]);
    calls.txs = [tx(9, 2, [[THEM, 1]], "2026-10-26T19:00:00Z")];
    expect(await agent.getTokenTransaction("09".repeat(32))).toMatchObject({ hash: "09".repeat(32), status: "finalized" });
    await expect(agent.getTokenTransaction("txid-1")).rejects.toThrow(/64-character hex/);
  });
});
