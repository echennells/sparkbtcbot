// The audit log never stores an invoice (a BOLT11 can carry a description),
// including one quoted in free text. FORBIDDEN_KEYS only checks key names, and
// the SDK's errors put their context into the message: SparkError appends
// ' [invoice: lnbc…]', so a failed payment's error line used to write the
// whole invoice into ~/.spark/audit.jsonl.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SparkValidationError, encodeSparkAddress } from "@buildonspark/spark-sdk";
import { createAuditLog, redactInvoices } from "../../lib/audit-log.js";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

const PK = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const invoiceFields = { version: 1, id: new Uint8Array(16).fill(3), paymentType: { $case: "satsPayment", satsPayment: { amount: 1000 } } };
const SPARK_INVOICE = encodeSparkAddress({ identityPublicKey: PK, network: "MAINNET", sparkInvoiceFields: invoiceFields });
const SPARK_INVOICE_RT = encodeSparkAddress({ identityPublicKey: PK, network: "REGTEST", sparkInvoiceFields: invoiceFields });
const ADDRESS = encodeSparkAddress({ identityPublicKey: PK, network: "MAINNET" });
// The SDK still decodes the legacy prefixes (sp1, sprt1, …). Shape only: the
// redaction is by shape, so the checksum doesn't matter here.
const LEGACY_INVOICE = `sp1${SPARK_INVOICE.slice("spark1".length)}`;
const LEGACY_ADDRESS = `sp1${ADDRESS.slice("spark1".length)}`;
const LNURL = "LNURL1DP68GURN8GHJ7UM9WFMXJCM99E3K7MF0V9CXJ0M385EKVCENXC6R2C35XVUKXEFCV5MKVV34X5EKZD3EV56NYD3HXQURZEPEXEJXXEPNXSCRVWFNV9NXZCN9XQ6XYEFHVGCXXCMYXYMNSERXFQ5FNS";
const invoice2000 = async () =>
  (await readFile("node_modules/light-bolt11-decoder/README.md", "utf8")).match(/lnbc20u[a-z0-9]+/)[0];

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "audit-log-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("redactInvoices", () => {
  it("cuts BOLT11, LNURL and Spark invoices (current and legacy prefixes, any case) to their prefix", async () => {
    const inv = await invoice2000();
    const text = `a ${inv} b ${inv.toUpperCase()} c ${SPARK_INVOICE} d ${SPARK_INVOICE_RT} e ${LEGACY_INVOICE} f ${LNURL}`;
    expect(redactInvoices(text)).toBe(
      "a lnbc20u1…[redacted] b LNBC20U1…[redacted] c spark1…[redacted] d sparkrt1…[redacted] e sp1…[redacted] f LNURL1…[redacted]",
    );
  });

  it("leaves bare Spark addresses, amounts and non-strings alone", () => {
    const text = `to ${ADDRESS} or ${LEGACY_ADDRESS}: 2000 sats, lnbc1000u, spark1`;
    expect(redactInvoices(text)).toBe(text);
    for (const v of [42, null, undefined, true, { invoice: "x" }]) expect(redactInvoices(v)).toBe(v);
  });
});

describe("createAuditLog().append", () => {
  it("redacts invoices in every string value, nested and in arrays", async () => {
    const inv = await invoice2000();
    const log = createAuditLog({ path: join(dir, "audit.jsonl"), clock: () => 0 });
    await log.append({ op: "x", reason: `refused ${inv}`, nested: { why: [SPARK_INVOICE], to: ADDRESS } });
    const raw = await readFile(join(dir, "audit.jsonl"), "utf8");
    expect(raw).not.toContain(inv.slice(0, 60));
    expect(raw).not.toContain(SPARK_INVOICE.slice(0, 80));
    expect(JSON.parse(raw)).toEqual({
      ts: "1970-01-01T00:00:00.000Z",
      op: "x",
      reason: "refused lnbc20u1…[redacted]",
      nested: { why: ["spark1…[redacted]"], to: ADDRESS },
    });
  });
});

describe("SparkAgent's audit line never quotes an invoice from an SDK error", () => {
  const KEYS = ["SPARK_LEAF_VAULT", "SPARK_DAILY_BUDGET_SATS", "SPARK_SPEND_LEDGER_PATH", "SPARK_LN_DEDUP_PATH", "SPARK_AUDIT_LOG_PATH", "SPARK_AUDIT_LOG", "SPARK_SEED_PATH"];
  const saved = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    process.env.SPARK_LEAF_VAULT = "off";
    delete process.env.SPARK_DAILY_BUDGET_SATS;
    process.env.SPARK_SPEND_LEDGER_PATH = join(dir, "ledger.json");
    process.env.SPARK_LN_DEDUP_PATH = join(dir, "ln-dedup");
    process.env.SPARK_AUDIT_LOG_PATH = join(dir, "audit.jsonl");
    delete process.env.SPARK_AUDIT_LOG;
    process.env.SPARK_SEED_PATH = join(dir, "seed.enc"); // absent → not sealed
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
  const auditLines = async () => (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));

  it("a Lightning payment failing on the SDK's bolt11 decoder", async () => {
    const inv = await invoice2000();
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      // what the SDK's decodeInvoice throws: the message ends '[invoice: lnbc…]'
      payLightningInvoice: async ({ invoice }) => { throw new SparkValidationError("Invalid payment secret found in invoice", { invoice }); },
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    await expect(agent.payLightningInvoice(inv, { maxAmountSats: 3000 })).rejects.toMatchObject({ code: "PAYMENT_COMMITTED" });
    expect(await readFile(join(dir, "audit.jsonl"), "utf8")).not.toContain(inv.slice(0, 60));
    expect((await auditLines()).at(-1)).toMatchObject({
      op: "lightning_pay", result: "unknown",
      error: expect.stringMatching(/^Invalid payment secret found in invoice \[invoice: lnbc20u1…\[redacted\]/),
    });
  });

  it("redacts before the 300-character cut, so no stub of the invoice survives", async () => {
    const inv = await invoice2000();
    // the invoice starts past character 250: cut first, then redact, would
    // leave ~40 data characters — too short to look like an invoice
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: async ({ invoice }) => { throw new SparkValidationError(`${"operator said no; ".repeat(14)}retry later`, { invoice }); },
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    await expect(agent.payLightningInvoice(inv, { maxAmountSats: 3000 })).rejects.toMatchObject({ code: "PAYMENT_COMMITTED" });
    expect(await readFile(join(dir, "audit.jsonl"), "utf8")).not.toContain(inv.slice(0, 20));
    expect((await auditLines()).at(-1).error).toMatch(/lnbc20u1…\[redacted\]/);
  });

  it("a Spark invoice passed to transfer() (the SDK refuses it, quoting it back)", async () => {
    const wallet = {
      getSparkAddress: async () => "sp1from",
      transfer: async ({ receiverSparkAddress }) => {
        throw new SparkValidationError("Spark address is a Spark invoice. Use fulfillSparkInvoice instead.", { field: "receiverSparkAddress", value: receiverSparkAddress });
      },
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    await expect(agent.transfer({ to: SPARK_INVOICE, amount: 1000 })).rejects.toMatchObject({ name: "SparkValidationError" });
    expect(await readFile(join(dir, "audit.jsonl"), "utf8")).not.toContain(SPARK_INVOICE.slice(0, 80));
    expect((await auditLines()).at(-1)).toMatchObject({ op: "spark_transfer", result: "error", recipients: ["spark1…[redacted]"] });
  });
});
