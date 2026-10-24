// SDK 0.13's refund fee ladder (enableCpfpRefundLadder, on by default) gives
// claimed leaves of ~1,024 sats and up an ANCHORLESS refund. The exit tool the
// backup is for fee-bumps every refund through its anchor and fails on the
// whole backup when one is missing, so verifyVault must say so. Both fixtures
// are real hosted-REGTEST backups (experiments/fee-ladder), pruned to two
// leaves and their ancestors.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";
import { verifyVault, snapshotLeafVault, enableLeafVault } from "../../skills/sparkbtcbot/scripts/leaf-vault.js";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { readVault } from "../../lib/leaf-vault.js";
import { FEE_LADDERS_OFF, sparkWalletOptions } from "../../lib/wallet-options.js";
import * as lib from "../../lib/index.js";

const fixture = (name) => fileURLToPath(new URL(`../fixtures/leaf-vault/${name}.json`, import.meta.url));
const dec = (hex) => TreeNode.decode(Buffer.from(hex, "hex"));
const enc = (node) => Buffer.from(TreeNode.encode(node).finish()).toString("hex");
const truncate = (node, field) => ({ ...node, [field]: node[field].slice(0, 40) });

// A wallet serving a fixture's leaves, and their ancestors to the exit-chain
// walk, the way the operators would.
function fixtureWallet(name, editLeaves = () => {}) {
  const fx = JSON.parse(readFileSync(fixture(name), "utf8"));
  const leaves = fx.leaves.map((l) => dec(l.treeNodeHex));
  editLeaves(leaves);
  const nodes = Object.fromEntries((fx.nodes ?? []).map((n) => [n.id, dec(n.treeNodeHex)]));
  const total = BigInt(fx.leaves.reduce((s, l) => s + l.valueSats, 0));
  const ee = new EventEmitter();
  let n = 0;
  const wallet = {
    leafManager: { getLeaves: async () => { n++; return leaves; } },
    connectionManager: {
      createSparkClient: async () => ({
        query_nodes: async ({ source }) => {
          const out = {};
          for (let id = source.nodeIds.nodeIds[0]; id && nodes[id]; id = nodes[id].parentNodeId) out[id] = nodes[id];
          return { nodes: out };
        },
      }),
    },
    config: { getCoordinatorAddress: () => "mock" },
    getIdentityPublicKey: async () => fx.walletIdentityPublicKey,
    getBalance: async () => ({ balance: total, satsBalance: { available: total, owned: total, incoming: 0n } }),
    on: (ev, cb) => ee.on(ev, cb),
    off: (ev, cb) => ee.off(ev, cb),
  };
  return { wallet, ee, calls: () => n };
}

describe("verifyVault: anchorless refunds", () => {
  it("fails a backup taken with the ladder ON, naming the anchorless leaf", async () => {
    const r = await verifyVault(fixture("regtest-ladder-on"));
    expect(r).toMatchObject({
      ok: false,
      leafCount: 2,
      failed: [], // it still reconstructs to a root; that isn't the problem
      anchorless: ["01a0eda1-bc88-7efa-81cb-ae42aa56dec3"], // the 1,024-sat leaf; the 512 kept its anchor
    });
    expect(r.reason).toMatch(/1 leaf\/leaves have an anchorless refund/);
    expect(r.reason).toMatch(/re-anchors the leaves it receives/);
  });

  it("passes a backup taken with the ladder OFF", async () => {
    const r = await verifyVault(fixture("regtest-ladder-off"));
    expect(r).toMatchObject({ ok: true, leafCount: 2, failed: [], anchorless: [] });
  });
});

describe("sparkWalletOptions: both fee ladders off", () => {
  it("adds the network and turns both ladders off", () => {
    expect(sparkWalletOptions("REGTEST")).toEqual({
      network: "REGTEST",
      enableCpfpRefundLadder: false,
      enableDirectNodeFeeLadder: false,
    });
  });

  it("keeps other options, and an extra can't switch a ladder back on", () => {
    const o = sparkWalletOptions("MAINNET", {
      optimizationOptions: { auto: false },
      enableCpfpRefundLadder: true,
      enableDirectNodeFeeLadder: true,
    });
    expect(o).toEqual({
      optimizationOptions: { auto: false },
      network: "MAINNET",
      enableCpfpRefundLadder: false,
      enableDirectNodeFeeLadder: false,
    });
  });

  it("FEE_LADDERS_OFF is frozen and exported from the package entry", () => {
    expect(Object.isFrozen(FEE_LADDERS_OFF)).toBe(true);
    expect(lib.FEE_LADDERS_OFF).toBe(FEE_LADDERS_OFF);
    expect(lib.sparkWalletOptions).toBe(sparkWalletOptions);
  });
});

// The continuous backup (snapshotLeafVault / enableLeafVault, what SparkAgent
// runs) must see the same problem verify does, or it reports a backup healthy
// that the exit tool will refuse.
describe("the continuous backup reports anchorless refunds", () => {
  const ID = "01a0eda1-bc88-7efa-81cb-ae42aa56dec3";
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lv-anchor-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it("a snapshot still writes the bundle, and names the anchorless leaf", async () => {
    const on = await snapshotLeafVault(fixtureWallet("regtest-ladder-on").wallet, { path: join(dir, "on.json"), networkLabel: "REGTEST" });
    expect(on).toMatchObject({ leafCount: 2, anchorless: [ID] });
    expect((await readVault(join(dir, "on.json"))).leaves).toHaveLength(2);
    const off = await snapshotLeafVault(fixtureWallet("regtest-ladder-off").wallet, { path: join(dir, "off.json"), networkLabel: "REGTEST" });
    expect(off).toMatchObject({ leafCount: 2, anchorless: [] });
  });

  it("enableLeafVault: ready fails, health is unhealthy, and the warning comes once", async () => {
    const { wallet, ee, calls } = fixtureWallet("regtest-ladder-on");
    const errors = [];
    const v = enableLeafVault(wallet, { path: join(dir, "current.json"), networkLabel: "REGTEST", debounceMs: 0, intervalMs: 3_600_000, onError: (e) => errors.push(e) });
    const ready = await v.ready;
    expect(ready).toMatchObject({ ok: false, anchorless: [ID] });
    expect(ready.error).toMatch(/1 leaf\/leaves have an anchorless refund/);
    expect(v.health()).toMatchObject({ healthy: false, consecutiveFailures: 0, anchorless: [ID] });
    ee.emit("balance:update"); // a second snapshot finds the same leaf
    await v.dispose();
    expect(calls()).toBeGreaterThanOrEqual(2);
    expect(errors.map((e) => e.code)).toEqual(["LEAF_VAULT_ANCHORLESS"]);
    expect(errors[0].anchorless).toEqual([ID]);
  });

  it("enableLeafVault on a ladder-off backup: ready ok, healthy, no warning", async () => {
    const errors = [];
    const v = enableLeafVault(fixtureWallet("regtest-ladder-off").wallet, { path: join(dir, "current.json"), networkLabel: "REGTEST", intervalMs: 3_600_000, onError: (e) => errors.push(e) });
    expect(await v.ready).toEqual({ ok: true });
    expect(v.health()).toMatchObject({ healthy: true, anchorless: [] });
    await v.dispose();
    expect(errors).toEqual([]);
  });
});

// Non-empty bytes used to be enough to pass, so a truncated or garbage refund
// verified green.
describe("a pre-signed tx that doesn't parse fails the backup", () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "lv-parse-")); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  for (const field of ["refundTx", "nodeTx"]) {
    it(`verify: a truncated ${field}`, async () => {
      const bundle = JSON.parse(readFileSync(fixture("regtest-ladder-off"), "utf8"));
      const leaf = bundle.leaves[0];
      leaf.treeNodeHex = enc(truncate(dec(leaf.treeNodeHex), field));
      const p = join(dir, "current.json");
      await writeFile(p, JSON.stringify(bundle));
      const r = await verifyVault(p);
      expect(r).toMatchObject({ ok: false, failed: [leaf.id], anchorless: [] });
      expect(r.reason).toMatch(/missing or don't parse/);
    });
  }

  it("snapshot: a leaf with an unparseable refund is not written", async () => {
    const { wallet } = fixtureWallet("regtest-ladder-off", (leaves) => { leaves[0] = truncate(leaves[0], "refundTx"); });
    await expect(snapshotLeafVault(wallet, { path: join(dir, "current.json"), networkLabel: "REGTEST" })).rejects.toThrow(/missing or unparseable/);
  });
});

describe("SparkAgent and a wallet opened with the ladders on", () => {
  const orig = process.env.SPARK_LEAF_VAULT;
  afterEach(() => {
    vi.restoreAllMocks();
    if (orig === undefined) delete process.env.SPARK_LEAF_VAULT;
    else process.env.SPARK_LEAF_VAULT = orig;
  });
  const config = (on) => ({ getEnableCpfpRefundLadder: () => on, getEnableDirectNodeFeeLadder: () => false });

  it("warns at construction, and not for one opened with sparkWalletOptions", () => {
    process.env.SPARK_LEAF_VAULT = "off"; // the warning doesn't depend on the vault
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    new SparkAgent({ config: config(true) }, "LOCAL");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/fee ladders ON[\s\S]*sparkWalletOptions/);
    warn.mockClear();
    new SparkAgent({ config: config(false) }, "LOCAL");
    new SparkAgent({}, "LOCAL"); // no config to read: say nothing
    expect(warn).not.toHaveBeenCalled();
  });
});

// The options belong to the wallet object, so one entry point that forgets
// them hands the operators fee ladders and leaves anchorless refunds behind.
describe("every wallet this package opens, or tells you to open, passes sparkWalletOptions", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const calls = (text) => [...text.matchAll(/\b(?:Issuer)?SparkWallet\.initialize\(\{([\s\S]*?)\}\);/g)].map((m) => m[1]);
  // Everything an agent runs or copies from; SKILL.md is loaded every session.
  const shipped = async () => {
    const { readdir, readFile } = await import("node:fs/promises");
    const files = ["skills/sparkbtcbot/SKILL.md", "README.md", "AGENTS.md"];
    for (const [dir, ext] of [["skills/sparkbtcbot/scripts/", ".js"], ["skills/sparkbtcbot/references/", ".md"]]) {
      for (const f of (await readdir(root + dir)).filter((n) => n.endsWith(ext))) files.push(dir + f);
    }
    return Promise.all(files.map(async (f) => ({ f, text: await readFile(root + f, "utf8") })));
  };

  it("in every full initialize call", async () => {
    let found = 0;
    for (const { f, text } of await shipped()) {
      for (const body of calls(text)) {
        found++;
        expect(body, `${f}: SparkWallet.initialize without sparkWalletOptions`).toMatch(/options: sparkWalletOptions\(/);
      }
    }
    expect(found).toBeGreaterThanOrEqual(12); // 7 scripts, 4 references, SKILL.md
  });

  // A fragment in prose ("initialize it with `options: { network, … }`") gets
  // copied as readily as a code block, and the full-call match can't see it.
  it("and never as a raw options object, prose included", async () => {
    const raw = [];
    for (const { f, text } of await shipped()) {
      text.split("\n").forEach((line, i) => { if (/\boptions:\s*\{/.test(line)) raw.push(`${f}:${i + 1}`); });
    }
    expect(raw, "wallet options written as a raw object; use sparkWalletOptions(network, extra)").toEqual([]);
  });
});
