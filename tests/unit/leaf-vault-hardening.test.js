// Regression pins for the 0.4.0 hardening pass on the leaf-vault: network-label
// derivation, the identity guard, the union rescue, skip accounting + BROKEN
// marker lifecycle, the missed-event re-arm, scheduling/dispose races, the
// verifyVault ENOENT contract, and the shared atomic writer's failure paths.
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { rm, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { atomicWriteJson, readVault } from "../../lib/leaf-vault.js";
import { atomicWriteFile } from "../../lib/atomic-file.js";
import { snapshotLeafVault, verifyVault, enableLeafVault, judgeMissingVault } from "../../skills/sparkbtcbot/scripts/leaf-vault.js";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";

const enc = (node) => Buffer.from(TreeNode.encode(TreeNode.fromPartial(node)).finish()).toString("hex");
const uniq = (n) => join(tmpdir(), `${n}-${process.pid}-${Math.random().toString(16).slice(2)}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => stat(p).then(() => true, () => false);

// Real SDK getBalance shape (top-level `balance` = deprecated AVAILABLE alias).
const mkBalance = (owned, available = owned) => ({ balance: available, satsBalance: { available, owned, incoming: 0n } });
const leafObj = (id, value, extra = {}) => ({ id, status: "AVAILABLE", value, nodeTx: Uint8Array.from([1, 2, 3]), refundTx: Uint8Array.from([4, 5, 6]), ...extra });

const mkWallet = ({ leaves = [], owned = 0n, available, identity } = {}) => {
  const ee = new EventEmitter();
  return {
    on: (ev, cb) => ee.on(ev, cb),
    off: (ev, cb) => ee.off(ev, cb),
    emit: (ev) => ee.emit(ev),
    leafManager: { getLeaves: async () => (typeof leaves === "function" ? leaves() : leaves) },
    connectionManager: { createSparkClient: async () => ({}) },
    config: { getCoordinatorAddress: () => "coord" },
    getBalance: async () => mkBalance(owned, available ?? owned),
    ...(identity !== undefined ? { getIdentityPublicKey: async () => identity } : {}),
  };
};

const priorBundle = (over = {}) => ({
  schema: "spark.unilateral-exit-bundle.v1",
  createdAt: "2026-07-09T00:00:00.000Z",
  network: "LOCAL",
  leaves: [{ id: "leaf1", valueSats: 100000, treeNodeHex: "0a020102" }],
  ...over,
});

describe("network label derivation + KNOWN_NETWORKS gate", () => {
  it("derives the label from a NUMERIC proto enum (never persists network '1')", async () => {
    const p = uniq("lv-net-enum") + ".json";
    try {
      // proto Network: MAINNET = 1. No networkLabel — the documented raw-SDK path.
      const w = mkWallet({ leaves: [leafObj("leaf1", 1000n, { network: 1 })], owned: 1000n });
      const r = await snapshotLeafVault(w, { path: p });
      expect(r.network).toBe("MAINNET");
      expect((await readVault(p)).network).toBe("MAINNET");
    } finally { await rm(p, { force: true }); }
  });

  it("refuses to write a bundle whose network Blink's tool would reject", async () => {
    const p = uniq("lv-net-bad") + ".json";
    try {
      const w = mkWallet({ leaves: [leafObj("leaf1", 1000n)], owned: 1000n });
      await expect(snapshotLeafVault(w, { path: p, networkLabel: "BITCOIN" })).rejects.toThrow(/not one of/);
      expect(await exists(p)).toBe(false); // nothing written
    } finally { await rm(p, { force: true }); }
  });
});

describe("identity guard: a different wallet/network must not clobber the prior bundle", () => {
  it("rejects a capture for a DIFFERENT NETWORK and keeps the prior bundle", async () => {
    const p = uniq("lv-ident-net") + ".json";
    try {
      await atomicWriteJson(p, priorBundle({ network: "MAINNET" }));
      const w = mkWallet({ leaves: [leafObj("r1", 500n)], owned: 500n });
      await expect(snapshotLeafVault(w, { path: p, networkLabel: "LOCAL" })).rejects.toThrow(/different wallet|network/i);
      expect((await readVault(p)).network).toBe("MAINNET"); // untouched
    } finally { await rm(p, { force: true }); }
  });

  it("rejects a capture from a DIFFERENT WALLET IDENTITY on the same network", async () => {
    const p = uniq("lv-ident-key") + ".json";
    try {
      await atomicWriteJson(p, priorBundle({ walletIdentityPublicKey: "aa11" }));
      const w = mkWallet({ leaves: [leafObj("r1", 500n)], owned: 500n, identity: "bb22" });
      await expect(snapshotLeafVault(w, { path: p, networkLabel: "LOCAL" })).rejects.toThrow(/different wallet identity/i);
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1"]);
    } finally { await rm(p, { force: true }); }
  });

  it("same network + same identity still writes (spent leaf, balance fell)", async () => {
    const p = uniq("lv-ident-ok") + ".json";
    try {
      await atomicWriteJson(p, priorBundle({ walletIdentityPublicKey: "aa11" }));
      const w = mkWallet({ leaves: [leafObj("fresh1", 500n)], owned: 500n, identity: "aa11" });
      const r = await snapshotLeafVault(w, { path: p, networkLabel: "LOCAL" });
      expect(r.leafCount).toBe(1);
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["fresh1"]);
    } finally { await rm(p, { force: true }); }
  });
});

describe("union rescue: a blocked shrink still persists the fresh leaves' exit material", () => {
  it("writes a UNION bundle (fresh + provable carried-over prior leaves) and still throws", async () => {
    const p = uniq("lv-union") + ".json";
    try {
      // The prior leaf must be genuinely provable offline for the union to publish.
      const provablePrior = { id: "leaf-locked", status: "AVAILABLE", nodeTx: Uint8Array.from([9]), refundTx: Uint8Array.from([8]) };
      await atomicWriteJson(p, priorBundle({ leaves: [{ id: "leaf-locked", valueSats: 100000, treeNodeHex: enc(provablePrior) }] }));
      // Fresh capture: only the new deposit; owned still counts the locked leaf.
      const w = mkWallet({ leaves: [leafObj("leaf-new", 50000n)], owned: 150000n, available: 50000n });
      await expect(snapshotLeafVault(w, { path: p, networkLabel: "LOCAL" })).rejects.toThrow(/UNION bundle/);
      const written = await readVault(p);
      expect(written.leaves.map((l) => l.id).sort()).toEqual(["leaf-locked", "leaf-new"]);
    } finally { await rm(p, { force: true }); }
  });

  it("keeps the prior bundle untouched when the carried-over leaves are NOT provable", async () => {
    const p = uniq("lv-union-no") + ".json";
    try {
      await atomicWriteJson(p, priorBundle()); // dummy treeNodeHex — not provable
      const w = mkWallet({ leaves: [leafObj("leaf-new", 50000n)], owned: 150000n, available: 50000n });
      await expect(snapshotLeafVault(w, { path: p, networkLabel: "LOCAL" })).rejects.toThrow(/prior bundle KEPT/i);
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1"]);
    } finally { await rm(p, { force: true }); }
  });
});

describe("integrity gate refuses via snapshotLeafVault (not just verifyVault)", () => {
  it("a leaf without pre-signed txs throws and leaves the prior bundle untouched (M-1, snapshot side)", async () => {
    const p = uniq("lv-gate-m1") + ".json";
    try {
      await atomicWriteJson(p, priorBundle());
      const w = mkWallet({ leaves: [{ id: "leaf1", status: "AVAILABLE" }], owned: 100000n });
      await expect(snapshotLeafVault(w, { path: p, networkLabel: "LOCAL" })).rejects.toThrow(/missing pre-signed/);
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1"]);
    } finally { await rm(p, { force: true }); }
  });

  it("an unresolvable online exit chain throws and writes nothing", async () => {
    const p = uniq("lv-gate-chain") + ".json";
    try {
      // parentNodeId forces an ancestor fetch through the (useless) mock client.
      const w = mkWallet({ leaves: [leafObj("leaf1", 1000n, { parentNodeId: "missing-parent" })], owned: 1000n });
      await expect(snapshotLeafVault(w, { path: p, networkLabel: "LOCAL" })).rejects.toThrow();
      expect(await exists(p)).toBe(false);
    } finally { await rm(p, { force: true }); }
  });
});

describe("skip accounting + BROKEN marker lifecycle", () => {
  it("chronic transient-empty getLeaves trips the BROKEN marker and unhealthy health", async () => {
    const dir = uniq("lv-skip-chronic");
    const p = join(dir, "current.json");
    await mkdir(dir, { recursive: true });
    await atomicWriteJson(p, priorBundle());
    const errors = [];
    const w = mkWallet({ leaves: [], owned: 100000n }); // funded, chronically empty capture
    const v = enableLeafVault(w, { path: p, networkLabel: "LOCAL", maxConsecutiveFailures: 2, debounceMs: 0, intervalMs: 9e6, onError: (e) => errors.push(e) });
    try {
      await v.ready;            // skip 1
      w.emit("balance:update"); // debounce 0 -> skip 2 -> threshold
      await sleep(80);
      expect(v.health().healthy).toBe(false);
      expect(v.health().consecutiveTransientSkips).toBeGreaterThanOrEqual(2);
      expect(await exists(join(dir, "BROKEN"))).toBe(true);
      expect(errors.some((e) => /empty.*in a row/i.test(e.message))).toBe(true);
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1"]); // prior kept
    } finally { await v.dispose(); await rm(dir, { recursive: true, force: true }); }
  });

  it("a genuinely empty wallet (no-leaves) stays healthy and clears a stale marker", async () => {
    const dir = uniq("lv-skip-empty");
    const p = join(dir, "current.json");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "BROKEN"), "stale marker");
    const v = enableLeafVault(mkWallet({ leaves: [], owned: 0n }), { path: p, networkLabel: "LOCAL", debounceMs: 9e6, intervalMs: 9e6 });
    try {
      const ready = await v.ready;
      expect(ready.ok).toBe(true);
      expect(v.health().healthy).toBe(true);
      expect(await exists(join(dir, "BROKEN"))).toBe(false); // confirmed-empty cleared it
    } finally { await v.dispose(); await rm(dir, { recursive: true, force: true }); }
  });

  it("a transient-empty skip does NOT clear an existing BROKEN marker", async () => {
    const dir = uniq("lv-skip-keepmark");
    const p = join(dir, "current.json");
    await mkdir(dir, { recursive: true });
    await atomicWriteJson(p, priorBundle());
    await writeFile(join(dir, "BROKEN"), "real marker");
    const v = enableLeafVault(mkWallet({ leaves: [], owned: 100000n }), { path: p, networkLabel: "LOCAL", debounceMs: 9e6, intervalMs: 9e6 });
    try {
      await v.ready; // transient-empty skip
      expect(await exists(join(dir, "BROKEN"))).toBe(true); // nothing persisted -> marker stays
    } finally { await v.dispose(); await rm(dir, { recursive: true, force: true }); }
  });

  it("a real persisted snapshot clears the BROKEN marker", async () => {
    const dir = uniq("lv-mark-clear");
    const p = join(dir, "current.json");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "BROKEN"), "old failure");
    const v = enableLeafVault(mkWallet({ leaves: [leafObj("leaf1", 1000n)], owned: 1000n }), { path: p, networkLabel: "LOCAL", debounceMs: 9e6, intervalMs: 9e6 });
    try {
      const ready = await v.ready;
      expect(ready.ok).toBe(true);
      expect(await exists(join(dir, "BROKEN"))).toBe(false);
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1"]);
    } finally { await v.dispose(); await rm(dir, { recursive: true, force: true }); }
  });

  it("a FATAL reach-in failure writes the marker on the FIRST failure (below threshold)", async () => {
    const dir = uniq("lv-fatal-first");
    const v = enableLeafVault({ on() {}, off() {} }, { path: join(dir, "current.json"), maxConsecutiveFailures: 3, debounceMs: 9e6, intervalMs: 9e6, onError: () => {} });
    try {
      const ready = await v.ready;
      expect(ready.ok).toBe(false);
      expect(v.health().consecutiveFailures).toBe(1); // below threshold — fatal path, not threshold path
      expect(await exists(join(dir, "BROKEN"))).toBe(true);
    } finally { await v.dispose(); await rm(dir, { recursive: true, force: true }); }
  });

  it("a single NON-fatal failure below threshold does NOT write the marker", async () => {
    const dir = uniq("lv-nonfatal");
    const p = join(dir, "current.json");
    let first = true;
    const w = mkWallet({ leaves: () => { if (first) { first = false; throw new Error("network flake"); } return [leafObj("leaf1", 1000n)]; }, owned: 1000n });
    const v = enableLeafVault(w, { path: p, maxConsecutiveFailures: 3, networkLabel: "LOCAL", debounceMs: 9e6, intervalMs: 9e6, onError: () => {} });
    try {
      const ready = await v.ready;
      expect(ready.ok).toBe(false);
      expect(await exists(join(dir, "BROKEN"))).toBe(false); // 1 < 3 and not fatal
    } finally { await v.dispose(); await rm(dir, { recursive: true, force: true }); }
  });
});

describe("scheduling: re-arm, debounce coalescing, interval, dispose races", () => {
  it("an event during an in-flight snapshot re-arms and is captured without waiting for the interval", async () => {
    const dir = uniq("lv-rearm");
    const p = join(dir, "current.json");
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const w = mkWallet({ leaves: () => { calls++; return calls === 1 ? gate.then(() => [leafObj("leaf1", 1000n)]) : [leafObj("leaf1", 1000n)]; }, owned: 1000n });
    const v = enableLeafVault(w, { path: p, networkLabel: "LOCAL", debounceMs: 20, intervalMs: 9e6 });
    try {
      await sleep(30);          // boot snapshot is blocked inside getLeaves
      w.emit("balance:update"); // its debounce will collapse into the in-flight run
      await sleep(40);          // debounce fired -> returned the in-flight boot run
      release();
      await v.ready;
      await sleep(120);         // the re-arm must schedule the follow-up capture
      expect(calls).toBeGreaterThanOrEqual(2);
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1"]);
    } finally { await v.dispose(); await rm(dir, { recursive: true, force: true }); }
  });

  it("a burst of events within the debounce window coalesces into ONE snapshot", async () => {
    const dir = uniq("lv-debounce");
    const p = join(dir, "current.json");
    let calls = 0;
    const w = mkWallet({ leaves: () => { calls++; return [leafObj("leaf1", 1000n)]; }, owned: 1000n });
    const v = enableLeafVault(w, { path: p, networkLabel: "LOCAL", debounceMs: 60, intervalMs: 9e6 });
    try {
      await v.ready; // boot = call 1
      for (let i = 0; i < 5; i++) { w.emit("balance:update"); await sleep(2); }
      await sleep(200);
      expect(calls).toBe(2); // boot + exactly one coalesced snapshot
    } finally { await v.dispose(); await rm(dir, { recursive: true, force: true }); }
  });

  it("the safety-net interval fires a snapshot with no events at all", async () => {
    const dir = uniq("lv-interval");
    const p = join(dir, "current.json");
    let calls = 0;
    const w = mkWallet({ leaves: () => { calls++; return [leafObj("leaf1", 1000n)]; }, owned: 1000n });
    const v = enableLeafVault(w, { path: p, networkLabel: "LOCAL", debounceMs: 9e6, intervalMs: 70 });
    try {
      await v.ready;
      await sleep(200);
      expect(calls).toBeGreaterThanOrEqual(2); // boot + at least one timer snapshot
    } finally { await v.dispose(); await rm(dir, { recursive: true, force: true }); }
  });

  it("dispose during an in-flight snapshot waits for it, flushes once, then stays quiet; double dispose is a no-op", async () => {
    const dir = uniq("lv-dispose-race");
    const p = join(dir, "current.json");
    let release;
    const gate = new Promise((r) => { release = r; });
    let calls = 0;
    const w = mkWallet({ leaves: () => { calls++; return calls === 1 ? gate.then(() => [leafObj("leaf1", 1000n)]) : [leafObj("leaf1", 1000n)]; }, owned: 1000n });
    const v = enableLeafVault(w, { path: p, networkLabel: "LOCAL", debounceMs: 9e6, intervalMs: 9e6 });
    try {
      await sleep(20);          // boot in flight
      w.emit("balance:update"); // dirty
      const disposing = v.dispose();
      release();
      await disposing;
      expect(calls).toBe(2); // boot + the dirty flush — exactly once
      await v.dispose();     // second dispose: no throw, no extra snapshot
      w.emit("balance:update");
      await sleep(60);
      expect(calls).toBe(2); // nothing runs after dispose
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1"]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("verifyVault contract", () => {
  it("returns { ok:false, missing:true, leafCount:0 } for a nonexistent path", async () => {
    expect(await verifyVault(uniq("lv-none") + ".json")).toMatchObject({ ok: false, missing: true, leafCount: 0 });
  });

  it("throws (not 'missing') on a corrupt vault file", async () => {
    const p = uniq("lv-corrupt") + ".json";
    try {
      await writeFile(p, "not json at all");
      await expect(verifyVault(p)).rejects.toThrow();
    } finally { await rm(p, { force: true }); }
  });
});

describe("atomic writer failure paths", () => {
  it("atomicWriteJson cleans up its temp when the publish fails", async () => {
    const dir = uniq("lv-atomic-fail");
    const p = join(dir, "current.json");
    await mkdir(p, { recursive: true }); // destination IS a directory -> rename must fail
    try {
      await expect(atomicWriteJson(p, { a: 1 })).rejects.toThrow();
      expect((await readdir(dir)).filter((f) => f.includes(".tmp"))).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("atomicWriteFile exclusive: EEXIST on an existing destination, temp cleaned, original intact", async () => {
    const dir = uniq("lv-atomic-excl");
    await mkdir(dir, { recursive: true });
    const p = join(dir, "target.bin");
    try {
      await writeFile(p, "original");
      await expect(atomicWriteFile(p, "new bytes", { exclusive: true })).rejects.toMatchObject({ code: "EEXIST" });
      const entries = await readdir(dir);
      expect(entries.filter((f) => f.includes(".tmp"))).toEqual([]);
      const { readFile } = await import("node:fs/promises");
      expect(await readFile(p, "utf8")).toBe("original"); // never replaced
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("judgeMissingVault (CLI exit-code contract: 0 ok / 1 critical / 2 indeterminate)", () => {
  it("unreadable balance -> INDETERMINATE, exit 2", () => {
    expect(judgeMissingVault(null)).toEqual({ level: "INDETERMINATE", exitCode: 2 });
  });
  it("funded wallet -> CRITICAL, exit 1 (owned sats with no exit backup)", () => {
    expect(judgeMissingVault(150000n)).toEqual({ level: "CRITICAL", exitCode: 1 });
  });
  it("empty wallet -> OK, exit 0", () => {
    expect(judgeMissingVault(0n)).toEqual({ level: "OK", exitCode: 0 });
  });
});

describe("npm subpath exports", () => {
  it("sparkbtcbot/leaf-vault and /leaf-vault/core resolve via the package exports map", async () => {
    const vault = await import("sparkbtcbot/leaf-vault");
    expect(typeof vault.enableLeafVault).toBe("function");
    expect(typeof vault.snapshotLeafVault).toBe("function");
    expect(typeof vault.verifyVault).toBe("function");
    const core = await import("sparkbtcbot/leaf-vault/core");
    expect(typeof core.validateSnapshotShape).toBe("function");
    expect(typeof core.atomicWriteJson).toBe("function");
  });
});
