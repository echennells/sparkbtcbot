// SparkAgent-level vault wiring: the L-3 opt-out normalization, and the enabled
// path through the agent surface users actually call — construction auto-enables
// the vault (at SPARK_LEAF_VAULT_PATH, read lazily), a leaf-changing event is
// flushed by `await agent.cleanup()`, and vaultHealth() reports the enabled shape.
import { describe, it, expect, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { readVault } from "../../lib/leaf-vault.js";

describe("SparkAgent SPARK_LEAF_VAULT opt-out normalization (L-3)", () => {
  const orig = process.env.SPARK_LEAF_VAULT;
  afterEach(() => { if (orig === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = orig; });

  for (const val of ["off", "OFF", "false", "0", "no", " off "]) {
    it(`treats SPARK_LEAF_VAULT=${JSON.stringify(val)} as disabled`, () => {
      process.env.SPARK_LEAF_VAULT = val;
      const agent = new SparkAgent({}, "LOCAL"); // wallet unused on the disabled path
      expect(agent.vaultHealth()).toEqual({ disabled: true });
    });
  }
});

// A phantom/mistyped option on a money-moving call must THROW, not silently
// vanish — the failure class behind a real double-send (dryRun passed to the
// raw SDK, which has no such option). Wrapper strictness makes it loud.
describe("SparkAgent rejects unknown options on money-moving calls", () => {
  const agent = () => {
    process.env.SPARK_LEAF_VAULT = "off"; // vault not under test here
    return new SparkAgent({ getSparkAddress: async () => "sp1from" }, "LOCAL");
  };
  const orig = process.env.SPARK_LEAF_VAULT;
  afterEach(() => { if (orig === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = orig; });

  it("throws on a mistyped dryRun (e.g. lowercase 'dryrun') instead of sending", async () => {
    await expect(agent().transfer({ to: "sp1dest", amount: 1000n, dryrun: true }))
      .rejects.toThrow(/unknown option.*dryrun/i);
  });

  for (const [method, args] of [
    ["transfer", [{ to: "sp1dest", amount: 1n, bogus: 1 }]],
    ["transferTokens", [{ tokenIdentifier: "btkn1x", amount: 1n, to: "sp1dest", bogus: 1 }]],
    ["withdraw", [{ to: "bc1qdest", amount: 30000, bogus: 1 }]],
    ["claimDeposit", [{ txid: "ab".repeat(32), bogus: 1 }]],
    ["payLightningInvoice", ["lnbc1...", { maxFeeSats: 10, bogus: 1 }]],
  ]) {
    it(`${method} rejects unknown option keys`, async () => {
      await expect(agent()[method](...args)).rejects.toThrow(/unknown option.*bogus/i);
    });
  }

  it("still accepts the REAL dryRun spelling (preview returns without sending)", async () => {
    const preview = await agent().transfer({ to: "sp1dest", amount: 1000n, dryRun: true });
    expect(preview).toMatchObject({ dryRun: true, operation: "spark_transfer", amount: "1000" });
  });
});

describe("SparkAgent enabled path (auto-vault through the agent surface)", () => {
  const origFlag = process.env.SPARK_LEAF_VAULT;
  const origPath = process.env.SPARK_LEAF_VAULT_PATH;
  afterEach(() => {
    if (origFlag === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = origFlag;
    if (origPath === undefined) delete process.env.SPARK_LEAF_VAULT_PATH; else process.env.SPARK_LEAF_VAULT_PATH = origPath;
  });

  it("constructor enables the vault, cleanup() flushes the pending change and awaits wallet.cleanup", async () => {
    const dir = join(tmpdir(), `agent-vault-${process.pid}-${Math.random().toString(16).slice(2)}`);
    const p = join(dir, "current.json");
    delete process.env.SPARK_LEAF_VAULT;
    process.env.SPARK_LEAF_VAULT_PATH = p; // read lazily at enable time
    const ee = new EventEmitter();
    let walletCleanedUp = false;
    const wallet = {
      on: (ev, cb) => ee.on(ev, cb),
      off: (ev, cb) => ee.off(ev, cb),
      leafManager: { getLeaves: async () => [{ id: "leaf1", status: "AVAILABLE", nodeTx: Uint8Array.from([1]), refundTx: Uint8Array.from([2]) }] },
      connectionManager: { createSparkClient: async () => ({}) },
      config: { getCoordinatorAddress: () => "coord" },
      getBalance: async () => ({ balance: 1000n, satsBalance: { available: 1000n, owned: 1000n, incoming: 0n } }),
      cleanup: async () => { walletCleanedUp = true; },
    };
    try {
      const agent = new SparkAgent(wallet, "LOCAL");
      // wait for the boot snapshot to land
      for (let i = 0; i < 100 && !agent.vaultHealth().lastSuccessAt; i++) await new Promise((r) => setTimeout(r, 20));
      expect(agent.vaultHealth()).toMatchObject({ healthy: true, consecutiveFailures: 0 });
      ee.emit("balance:update"); // pending change the 4s debounce won't reach
      await agent.cleanup();     // must flush it and await wallet.cleanup
      expect(walletCleanedUp).toBe(true);
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
