// The SDK validates sats amounts with Number.isSafeInteger, which is FALSE for
// EVERY BigInt — so passing BigInt(8258) threw a misleading "Sats amount must be
// less than 2^53" even for tiny values, while a plain 8258 worked. Worse, the
// wrapper's dry-run stringified the amount (accepting bigint) while the live path
// forwarded the bigint straight to the SDK — so dry-run and live disagreed. The
// toSats() helper normalizes number|bigint to a safe-integer Number at every
// SDK-bound amount. These tests pin: bigint is accepted and forwarded as a
// Number, dry-run/live agree, and garbage throws a CLEAR wrapper error (not the
// SDK's misleading one) BEFORE any SDK call.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// allow-all: #assertAllowed must not block the transfer under test
vi.mock("../../lib/recipients-allowlist.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadRecipientsAllowlist: vi.fn(async () => null) };
});

const { SparkAgent } = await import("../../skills/sparkbtcbot/scripts/spark-agent.js");

const origVault = process.env.SPARK_LEAF_VAULT;
beforeEach(() => { process.env.SPARK_LEAF_VAULT = "off"; });
afterEach(() => {
  if (origVault === undefined) delete process.env.SPARK_LEAF_VAULT;
  else process.env.SPARK_LEAF_VAULT = origVault;
});

const mkAgent = () => {
  const calls = { transfer: null, createInvoice: null };
  const wallet = {
    getSparkAddress: async () => "sp1from",
    transfer: async (args) => { calls.transfer = args; return { id: "t1", status: "PENDING" }; },
    createLightningInvoice: async (args) => { calls.createInvoice = args; return { invoice: { encodedInvoice: "lnbc1" } }; },
  };
  return { agent: new SparkAgent(wallet, "MAINNET"), calls };
};

describe("transfer amount normalization (bigint footgun)", () => {
  it("forwards a BigInt amount to the SDK as a plain Number", async () => {
    const { agent, calls } = mkAgent();
    await agent.transfer({ to: "sp1to", amount: 8258n });
    expect(calls.transfer.amountSats).toBe(8258);
    expect(typeof calls.transfer.amountSats).toBe("number"); // NOT bigint — the SDK rejects bigint
  });

  it("accepts a plain number unchanged", async () => {
    const { agent, calls } = mkAgent();
    await agent.transfer({ to: "sp1to", amount: 8258 });
    expect(calls.transfer.amountSats).toBe(8258);
  });

  it("dry-run and live AGREE on a BigInt (the reported inconsistency)", async () => {
    const { agent } = mkAgent();
    const preview = await agent.transfer({ to: "sp1to", amount: 8258n, dryRun: true });
    expect(preview.amount).toBe("8258"); // dry-run no longer silently diverges from live
  });

  it("throws a CLEAR wrapper error on a non-integer amount, before the SDK is called", async () => {
    const { agent, calls } = mkAgent();
    await expect(agent.transfer({ to: "sp1to", amount: 1.5 }))
      .rejects.toThrow(/SparkAgent\.transfer: amount must be a non-negative integer below 2\^53/);
    expect(calls.transfer).toBeNull(); // never reached the SDK
  });

  it("throws on an out-of-range BigInt (genuinely > 2^53) rather than silently truncating", async () => {
    const { agent, calls } = mkAgent();
    await expect(agent.transfer({ to: "sp1to", amount: 2n ** 60n }))
      .rejects.toThrow(/out of range/);
    expect(calls.transfer).toBeNull();
  });

  it("the same normalization protects the invoice paths too (createLightningInvoice)", async () => {
    const { agent, calls } = mkAgent();
    await agent.createLightningInvoice(5000n, "memo");
    expect(calls.createInvoice.amountSats).toBe(5000);
    expect(typeof calls.createInvoice.amountSats).toBe("number");
  });
});
