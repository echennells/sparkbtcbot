// fulfillInvoice pays whoever created the invoice — the one outbound path the
// allowlist used to miss entirely (it was a bare SDK passthrough while
// SKILL.md promised "every Spark transfer … must target an address in the
// file"). These tests pin the gate: the receiver is decoded FROM the invoice
// and held to the allowlist before the SDK is ever called, in dryRun too.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { encodeSparkAddress } from "@buildonspark/spark-sdk";

let mockAllowlist = null;
vi.mock("../../lib/recipients-allowlist.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    loadRecipientsAllowlist: vi.fn(async () => mockAllowlist),
  };
});

const { SparkAgent, sparkInvoiceReceiver } = await import(
  "../../skills/sparkbtcbot/scripts/spark-agent.js"
);

const { secp256k1 } = await import("@noble/curves/secp256k1");
const pkFromScalar = (n) =>
  Buffer.from(secp256k1.getPublicKey(Uint8Array.from([...new Uint8Array(31), n]), true)).toString("hex");
const RECEIVER_PK = pkFromScalar(1);
const OTHER_PK = pkFromScalar(2);
const invoiceFor = (pk, { id = 7, amount = 1500, network = "MAINNET" } = {}) =>
  encodeSparkAddress({
    identityPublicKey: pk,
    network,
    sparkInvoiceFields: {
      version: 1,
      id: new Uint8Array(16).fill(id),
      paymentType: { $case: "satsPayment", satsPayment: { amount } },
    },
  });
const bareAddress = (pk) => encodeSparkAddress({ identityPublicKey: pk, network: "MAINNET" });

const INVOICE = invoiceFor(RECEIVER_PK);

const origVault = process.env.SPARK_LEAF_VAULT;
beforeEach(() => { mockAllowlist = null; });
afterEach(() => {
  if (origVault === undefined) delete process.env.SPARK_LEAF_VAULT;
  else process.env.SPARK_LEAF_VAULT = origVault;
});

const mkAgent = () => {
  process.env.SPARK_LEAF_VAULT = "off";
  const calls = { fulfill: null };
  const wallet = {
    getSparkAddress: async () => "sp1from",
    fulfillSparkInvoice: async (invoices) => { calls.fulfill = invoices; return { satsTransactionSuccess: [] }; },
  };
  return { agent: new SparkAgent(wallet, "MAINNET"), calls };
};

describe("fulfillInvoice allowlist gate", () => {
  it("BLOCKS an invoice whose receiver is not in the allowlist (SDK never called)", async () => {
    const { agent, calls } = mkAgent();
    mockAllowlist = [bareAddress(OTHER_PK)];
    await expect(agent.fulfillInvoice([{ invoice: INVOICE, amount: 1500n }]))
      .rejects.toMatchObject({ code: "RECIPIENT_NOT_ALLOWED" });
    expect(calls.fulfill).toBeNull();
  });

  it("blocks in dryRun mode too — a dry-run can't be used to bless a disallowed receiver", async () => {
    const { agent, calls } = mkAgent();
    mockAllowlist = [bareAddress(OTHER_PK)];
    await expect(agent.fulfillInvoice([{ invoice: INVOICE }], { dryRun: true }))
      .rejects.toMatchObject({ code: "RECIPIENT_NOT_ALLOWED" });
    expect(calls.fulfill).toBeNull();
  });

  it("one disallowed receiver blocks the whole batch", async () => {
    const { agent, calls } = mkAgent();
    mockAllowlist = [bareAddress(RECEIVER_PK)];
    const entries = [{ invoice: INVOICE }, { invoice: invoiceFor(OTHER_PK) }];
    await expect(agent.fulfillInvoice(entries)).rejects.toMatchObject({ code: "RECIPIENT_NOT_ALLOWED" });
    expect(calls.fulfill).toBeNull();
  });

  it("permits when the receiver's bare address is listed, forwarding entries untouched", async () => {
    const { agent, calls } = mkAgent();
    mockAllowlist = [bareAddress(RECEIVER_PK)];
    const entries = [{ invoice: INVOICE, amount: 1500n }];
    await agent.fulfillInvoice(entries);
    expect(calls.fulfill).toBe(entries);
  });

  it("permits when the allowlist entry is a DIFFERENT encoding of the same receiver (identity-key match)", async () => {
    const { agent, calls } = mkAgent();
    // an older invoice from the same receiver on the list — same identity key,
    // different string — must still authorize the receiver
    mockAllowlist = [invoiceFor(RECEIVER_PK, { id: 9, amount: 42 })];
    await agent.fulfillInvoice([{ invoice: INVOICE }]);
    expect(calls.fulfill).not.toBeNull();
  });

  it("permits everything when no allowlist file exists (null = not enforced)", async () => {
    const { agent, calls } = mkAgent();
    mockAllowlist = null;
    await agent.fulfillInvoice([{ invoice: INVOICE }]);
    expect(calls.fulfill).not.toBeNull();
  });

  it("refuses a cross-network invoice (REGTEST invoice on a MAINNET agent)", async () => {
    const { agent, calls } = mkAgent();
    await expect(agent.fulfillInvoice([{ invoice: invoiceFor(RECEIVER_PK, { network: "REGTEST" }) }]))
      .rejects.toThrow();
    expect(calls.fulfill).toBeNull();
  });
});

describe("fulfillInvoice strictness + dryRun parity", () => {
  it("rejects unknown options instead of silently dropping them", async () => {
    const { agent, calls } = mkAgent();
    await expect(agent.fulfillInvoice([{ invoice: INVOICE }], { dryrun: true }))
      .rejects.toThrow(/unknown option/i);
    expect(calls.fulfill).toBeNull();
  });

  it("refuses an entry with no invoice string (nothing unvetted reaches the SDK)", async () => {
    const { agent, calls } = mkAgent();
    await expect(agent.fulfillInvoice([{ amount: 100n }])).rejects.toThrow(/invoice/);
    await expect(agent.fulfillInvoice("spark1notanarray")).rejects.toThrow(/array/);
    expect(calls.fulfill).toBeNull();
  });

  it("dryRun previews the decoded receiver and embedded amount without paying", async () => {
    const { agent, calls } = mkAgent();
    const preview = await agent.fulfillInvoice([{ invoice: INVOICE }], { dryRun: true });
    expect(preview).toMatchObject({
      dryRun: true,
      operation: "fulfill_spark_invoice",
      network: "MAINNET",
    });
    expect(preview.entries).toEqual([
      { invoice: INVOICE, to: bareAddress(RECEIVER_PK), amount: "1500", type: "sats" },
    ]);
    expect(calls.fulfill).toBeNull();
  });
});

describe("sparkInvoiceReceiver", () => {
  it("round-trips the receiver identity key out of an invoice", () => {
    const r = sparkInvoiceReceiver(INVOICE, "MAINNET");
    expect(r.identityPublicKey).toBe(RECEIVER_PK);
    expect(r.address).toBe(bareAddress(RECEIVER_PK));
    expect(r.invoiceFields?.paymentType).toMatchObject({ type: "sats", amount: 1500 });
  });
});
