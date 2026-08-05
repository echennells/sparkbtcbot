// The shrink guard used to trip BROKEN during EVERY cooperative L1 exit: the
// exiting leaves leave getLeaves at broadcast while `owned` keeps counting their
// sats until the L1 tx confirms, so captured < owned for minutes (QA repro:
// 9,946 captured vs 19,052 owned, BROKEN for 8+ min of mempool wait). That
// balance signature is IDENTICAL to a genuine partial read dropping a
// transfer-locked leaf, so balances alone must never excuse it. The fix demands
// POSITIVE SSP evidence — a pending COOP_EXIT via wallet.getUserRequests — on
// top of captured >= available and a gate-proven union. These tests pin each
// corner: with evidence the snapshot succeeds (union kept, BROKEN cleared);
// without evidence, with an unreadable query, or with a spendable leaf missing,
// the strict throw is unchanged.
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { rm, stat, writeFile, mkdir } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { atomicWriteJson, readVault } from "../../lib/leaf-vault.js";
import { snapshotLeafVault, pendingCoopExitCount } from "../../skills/sparkbtcbot/scripts/leaf-vault.js";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";

const enc = (node) => Buffer.from(TreeNode.encode(TreeNode.fromPartial(node)).finish()).toString("hex");
const uniq = (n) => join(tmpdir(), `${n}-${process.pid}-${Math.random().toString(16).slice(2)}`);
const exists = (p) => stat(p).then(() => true, () => false);

const mkBalance = (owned, available = owned) => ({ balance: available, satsBalance: { available, owned, incoming: 0n } });
const leafObj = (id, value, extra = {}) => ({ id, status: "AVAILABLE", value, nodeTx: Uint8Array.from([1, 2, 3]), refundTx: Uint8Array.from([4, 5, 6]), ...extra });

const mkWallet = ({ leaves = [], owned = 0n, available, getUserRequests } = {}) => {
  const ee = new EventEmitter();
  return {
    on: (ev, cb) => ee.on(ev, cb),
    off: (ev, cb) => ee.off(ev, cb),
    leafManager: { getLeaves: async () => leaves },
    connectionManager: { createSparkClient: async () => ({}) },
    config: { getCoordinatorAddress: () => "coord" },
    getBalance: async () => mkBalance(owned, available ?? owned),
    ...(getUserRequests ? { getUserRequests } : {}),
  };
};

// Prior bundle holding a PROVABLE leaf that the fresh capture is missing —
// the QA scenario: that leaf's sats are the in-flight exit.
const provablePrior = { id: "leaf-exiting", status: "AVAILABLE", nodeTx: Uint8Array.from([9]), refundTx: Uint8Array.from([8]) };
const priorBundle = () => ({
  schema: "spark.unilateral-exit-bundle.v1",
  createdAt: "2026-07-09T00:00:00.000Z",
  network: "LOCAL",
  leaves: [{ id: "leaf-exiting", valueSats: 9106, treeNodeHex: enc(provablePrior) }],
});

// QA repro numbers: 9,946 still leaf-backed, 19,052 owned (9,106 exiting).
const exitWalletArgs = { leaves: [leafObj("leaf-kept", 9946n)], owned: 19052n, available: 9946n };

describe("shrink guard: cooperative-exit settlement window", () => {
  it("with SSP evidence of a pending COOP_EXIT: snapshot SUCCEEDS, union written, BROKEN cleared", async () => {
    // Own directory: BROKEN lives next to the vault, and tmpdir()/BROKEN would
    // race other leaf-vault test files running in parallel.
    const dir = uniq("lv-exitwin-dir");
    const p = join(dir, "current.json");
    const broken = join(dirname(p), "BROKEN");
    try {
      await mkdir(dir, { recursive: true });
      await atomicWriteJson(p, priorBundle());
      await writeFile(broken, JSON.stringify({ consecutiveFailures: 3 })); // stale marker from earlier trips
      let query = null;
      const w = mkWallet({
        ...exitWalletArgs,
        getUserRequests: async (args) => { query = args; return { count: 1, entities: [{}] }; },
      });
      const res = await snapshotLeafVault(w, { path: p, networkLabel: "LOCAL" });
      // The union carries BOTH the kept leaf and the exiting leaf's material.
      expect(res.leafCount).toBe(2);
      const written = await readVault(p);
      expect(written.leaves.map((l) => l.id).sort()).toEqual(["leaf-exiting", "leaf-kept"]);
      // Marker cleared — a gate-proven bundle was written, same invariant as the clean path.
      expect(await exists(broken)).toBe(false);
      // And the evidence query asked for in-flight coop exits specifically.
      expect(query.types).toEqual(["COOP_EXIT"]);
      expect(query.statuses).toEqual(["CREATED", "IN_PROGRESS"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("WITHOUT evidence (0 pending exits): identical balances still throw — a dropped transfer-leaf cannot slip through", async () => {
    const p = uniq("lv-exitwin-none") + ".json";
    try {
      await atomicWriteJson(p, priorBundle());
      const w = mkWallet({ ...exitWalletArgs, getUserRequests: async () => ({ count: 0, entities: [] }) });
      await expect(snapshotLeafVault(w, { path: p, networkLabel: "LOCAL" })).rejects.toThrow(/partial getLeaves/);
    } finally { await rm(p, { force: true }); }
  });

  it("when the SSP query FAILS: unknowable is no excuse — still throws", async () => {
    const p = uniq("lv-exitwin-err") + ".json";
    try {
      await atomicWriteJson(p, priorBundle());
      const w = mkWallet({ ...exitWalletArgs, getUserRequests: async () => { throw new Error("SSP down"); } });
      await expect(snapshotLeafVault(w, { path: p, networkLabel: "LOCAL" })).rejects.toThrow(/partial getLeaves/);
    } finally { await rm(p, { force: true }); }
  });

  it("capture short of AVAILABLE still throws even WITH a pending exit — a missing spendable leaf is never excused", async () => {
    const p = uniq("lv-exitwin-short") + ".json";
    try {
      await atomicWriteJson(p, priorBundle());
      // available 9,946 but the capture holds only 5,000 — a spendable-backing
      // leaf is genuinely missing; the exit explains only the owned-available band.
      const w = mkWallet({
        leaves: [leafObj("leaf-kept", 5000n)], owned: 19052n, available: 9946n,
        getUserRequests: async () => ({ count: 1, entities: [{}] }),
      });
      await expect(snapshotLeafVault(w, { path: p, networkLabel: "LOCAL" })).rejects.toThrow(/partial getLeaves/);
    } finally { await rm(p, { force: true }); }
  });
});

describe("pendingCoopExitCount degrades conservatively", () => {
  it("null when the wallet lacks getUserRequests (older SDK / raw fake)", async () => {
    expect(await pendingCoopExitCount({})).toBe(null);
  });
  it("null when the connection shape is unrecognized", async () => {
    expect(await pendingCoopExitCount({ getUserRequests: async () => "???" })).toBe(null);
  });
  it("falls back to entities.length when count is absent", async () => {
    expect(await pendingCoopExitCount({ getUserRequests: async () => ({ entities: [{}, {}] }) })).toBe(2);
  });
});
