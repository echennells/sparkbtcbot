// Regression tests for the Trail-of-Bits review fixes on the leaf-vault. Each test
// triggers the specific NEW branch a fix added — the failure/edge paths a green
// end-to-end run does not exercise (that gap was the whole point of the review).
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, readFile, readdir, stat, mkdir } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { atomicWriteJson, readVault } from "../../lib/leaf-vault.js";
import { snapshotLeafVault, verifyVault, enableLeafVault } from "../../skills/sparkbtcbot/scripts/leaf-vault.js";
import { TreeNode } from "@buildonspark/spark-sdk/proto/spark";

const enc = (node) => Buffer.from(TreeNode.encode(TreeNode.fromPartial(node)).finish()).toString("hex");
const uniq = (n) => join(tmpdir(), `${n}-${process.pid}-${Math.random().toString(16).slice(2)}`);

// H-3 — the per-PID temp path defeated atomic-write under concurrency.
describe("atomicWriteJson concurrency (H-3: unique temp + O_EXCL)", () => {
  it("40 concurrent writes to one path never corrupt it — result is ONE complete payload", async () => {
    const p = uniq("lv-conc") + ".json";
    try {
      const payloads = Array.from({ length: 40 }, (_, i) => ({ version: 2, network: "R", updatedAt: "t", leafIds: [`n${i}`], nodes: [{ id: `n${i}`, value: String(i), hex: "0a020102".repeat(i + 1) }] }));
      await Promise.all(payloads.map((pl) => atomicWriteJson(p, pl)));
      const got = JSON.parse(await readFile(p, "utf8")); // must parse — no spliced/truncated bytes
      expect(payloads).toContainEqual(got);              // must equal ONE payload — no interleave
    } finally { await rm(p, { force: true }); }
  });
  it("leaves no stray .tmp files behind", async () => {
    const dir = uniq("lv-tmp");
    await mkdir(dir, { recursive: true });
    const p = join(dir, "current.json");
    try {
      await Promise.all(Array.from({ length: 20 }, () => atomicWriteJson(p, { version: 2, network: "R", leafIds: [], nodes: [] })));
      expect((await readdir(dir)).filter((f) => f.includes(".tmp"))).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

// M-1 — the gate proved chain TOPOLOGY only; content (the pre-signed txs) could be empty.
describe("integrity CONTENT gate (M-1)", () => {
  const bundle = (leaf) => ({ schema: "spark.unilateral-exit-bundle.v1", createdAt: "2026-07-09T00:00:00.000Z", network: "LOCAL", leaves: [{ id: "leaf1", valueSats: 1, treeNodeHex: enc(leaf) }] });
  it("verifyVault passes a leaf WITH pre-signed txs and FAILS one without — topology passes for both", async () => {
    const good = uniq("lv-m1-good") + ".json";
    const bad = uniq("lv-m1-bad") + ".json";
    try {
      const withTx = { id: "leaf1", status: "AVAILABLE", nodeTx: Uint8Array.from([1, 2, 3]), refundTx: Uint8Array.from([4, 5, 6]) };
      const withoutTx = { id: "leaf1", status: "AVAILABLE" }; // chain length 1 (topology OK), but zero tx bytes
      await atomicWriteJson(good, bundle(withTx));
      await atomicWriteJson(bad, bundle(withoutTx));
      expect(await verifyVault(good)).toMatchObject({ ok: true });
      const r = await verifyVault(bad);
      expect(r.ok).toBe(false);
      expect(r.failed).toContain("leaf1");
    } finally { await rm(good, { force: true }); await rm(bad, { force: true }); }
  });
});

// Real SDK getBalance shape: the top-level `balance` is a deprecated alias for
// AVAILABLE; owned (which includes leaves locked in in-flight transfers/swaps)
// lives in satsBalance. Mocks MUST use this shape — a mock that omits `balance`
// certifies an owned-first ordering the production code might not have.
const mkBalance = (owned, available = owned) => ({ balance: available, satsBalance: { available, owned, incoming: 0n } });

// M-2 — a transient empty getLeaves() must not atomically clobber a good vault.
describe("transient empty getLeaves guard (M-2)", () => {
  const mockWallet = (leaves, owned) => ({
    leafManager: { getLeaves: async () => leaves },
    connectionManager: { createSparkClient: async () => ({}) },
    config: { getCoordinatorAddress: () => "coord" },
    getBalance: async () => mkBalance(owned),
  });
  const goodBundle = { schema: "spark.unilateral-exit-bundle.v1", createdAt: "2026-07-09T00:00:00.000Z", network: "LOCAL", leaves: [{ id: "leaf1", valueSats: 200000, treeNodeHex: "0a020102" }] };
  it("does NOT clobber a good bundle when getLeaves is empty but balance > 0", async () => {
    const p = uniq("lv-m2a") + ".json";
    try {
      await atomicWriteJson(p, goodBundle);
      const r = await snapshotLeafVault(mockWallet([], 200000n), { path: p, networkLabel: "LOCAL" });
      expect(r.skipped).toBe("transient-empty-getLeaves");
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1"]); // last-good bundle preserved
    } finally { await rm(p, { force: true }); }
  });
  it("writes NO bundle for a genuinely empty wallet (schema needs >=1 leaf)", async () => {
    const p = uniq("lv-m2b") + ".json";
    try {
      const r = await snapshotLeafVault(mockWallet([], 0n), { path: p, networkLabel: "LOCAL" });
      expect(r.skipped).toBe("no-leaves");
      const wrote = await readVault(p).then(() => true, () => false);
      expect(wrote).toBe(false); // nothing written
    } finally { await rm(p, { force: true }); }
  });
  it("reads OWNED sats, not `available` — owned-but-locked funds keep a good bundle", async () => {
    const p = uniq("lv-owned") + ".json";
    try {
      await atomicWriteJson(p, goodBundle); // prior complete bundle
      // getLeaves transiently empty, but the wallet OWNS funds locked in an in-flight
      // transfer: owned=200000, available=0 — and, like the real SDK, the deprecated
      // top-level `balance` mirrors AVAILABLE (0). Must be treated as transient-empty
      // (keep the prior bundle): an available-first read would see 0 and call this a
      // genuinely empty wallet.
      const wallet = {
        leafManager: { getLeaves: async () => [] },
        connectionManager: { createSparkClient: async () => ({}) },
        config: { getCoordinatorAddress: () => "coord" },
        getBalance: async () => mkBalance(200000n, 0n),
      };
      const r = await snapshotLeafVault(wallet, { path: p, networkLabel: "LOCAL" });
      expect(r.skipped).toBe("transient-empty-getLeaves"); // owned>0 -> not a genuine empty
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1"]);
    } finally { await rm(p, { force: true }); }
  });
});

// H-2 — a broken backup must surface, not vanish into one stderr line.
describe("auto-vault surfaces failure loudly (H-2)", () => {
  it("boot snapshot failure -> ready.ok=false, BROKEN marker written, health unhealthy", async () => {
    const dir = uniq("lv-h2");
    const p = join(dir, "current.json");
    const brokenWallet = { on() {}, off() {} }; // missing leafManager -> assertLeafInternalsIntact throws (fatal)
    const v = enableLeafVault(brokenWallet, { path: p, maxConsecutiveFailures: 1 });
    try {
      const ready = await v.ready;
      expect(ready.ok).toBe(false);
      expect(ready.error).toMatch(/SDK internals moved/i);
      expect(v.health().healthy).toBe(false);
      expect(v.health().consecutiveFailures).toBeGreaterThanOrEqual(1);
      const markerExists = await stat(join(dir, "BROKEN")).then(() => true, () => false);
      expect(markerExists).toBe(true);
    } finally { await v.dispose(); await rm(dir, { recursive: true, force: true }); }
  });
});

// A NON-EMPTY partial getLeaves must not silently overwrite a complete bundle —
// the sibling of the empty-case (M-2) guard. A previously-backed-up leaf may vanish
// legitimately only if it was SPENT (balance fell to match); otherwise it is a
// partial capture and the prior complete bundle must be kept.
describe("partial getLeaves shrink guard", () => {
  const leafObj = (id, value) => ({ id, status: "AVAILABLE", value, nodeTx: Uint8Array.from([1, 2, 3]), refundTx: Uint8Array.from([4, 5, 6]) });
  const writePriorTwo = (p) => atomicWriteJson(p, {
    schema: "spark.unilateral-exit-bundle.v1", createdAt: "2026-07-09T00:00:00.000Z", network: "LOCAL",
    leaves: [{ id: "leaf1", valueSats: 100000, treeNodeHex: "0a020102" }, { id: "leaf2", valueSats: 100000, treeNodeHex: "0a020102" }],
  });
  const mockWallet = (leaves, owned, available = owned) => ({
    leafManager: { getLeaves: async () => leaves },
    connectionManager: { createSparkClient: async () => ({}) },
    config: { getCoordinatorAddress: () => "coord" },
    getBalance: async () => mkBalance(owned, available),
  });

  it("KEEPS the complete 2-leaf bundle when getLeaves drops a leaf but balance still covers both", async () => {
    const p = uniq("lv-shrink-partial") + ".json";
    try {
      await writePriorTwo(p);
      await expect(
        snapshotLeafVault(mockWallet([leafObj("leaf1", 100000n)], 200000n), { path: p, networkLabel: "LOCAL" }),
      ).rejects.toThrow(/partial getLeaves|prior bundle KEPT/i);
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1", "leaf2"]); // complete bundle preserved
    } finally { await rm(p, { force: true }); }
  });

  it("WRITES the smaller bundle when the dropped leaf was genuinely spent (balance fell)", async () => {
    const p = uniq("lv-shrink-spent") + ".json";
    try {
      await writePriorTwo(p);
      const r = await snapshotLeafVault(mockWallet([leafObj("leaf1", 100000n)], 100000n), { path: p, networkLabel: "LOCAL" });
      expect(r.leafCount).toBe(1);
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1"]); // legit shrink published
    } finally { await rm(p, { force: true }); }
  });

  it("KEEPS the complete bundle when a leaf is dropped and balance is UNREADABLE (conservative)", async () => {
    const p = uniq("lv-shrink-unreadable") + ".json";
    try {
      await writePriorTwo(p);
      const wallet = mockWallet([leafObj("leaf1", 100000n)], 0n);
      wallet.getBalance = async () => { throw new Error("coordinator unreachable"); };
      await expect(snapshotLeafVault(wallet, { path: p, networkLabel: "LOCAL" })).rejects.toThrow(/partial getLeaves|unreadable/i);
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1", "leaf2"]);
    } finally { await rm(p, { force: true }); }
  });

  it("KEEPS the complete bundle when the dropped leaf is LOCKED, not spent (owned covers it, available does not)", async () => {
    // leaf2 is locked in an in-flight transfer: getLeaves (available-only) drops
    // it and `available` no longer counts it, but `owned` still does. Judging on
    // available would call this a legitimate spend and overwrite leaf2's only
    // exit material; judging on owned correctly blocks the shrink.
    const p = uniq("lv-shrink-locked") + ".json";
    try {
      await writePriorTwo(p);
      await expect(
        snapshotLeafVault(mockWallet([leafObj("leaf1", 100000n)], 200000n, 100000n), { path: p, networkLabel: "LOCAL" }),
      ).rejects.toThrow(/partial getLeaves|prior bundle KEPT/i);
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1", "leaf2"]);
    } finally { await rm(p, { force: true }); }
  });
});

// Flush-on-dispose: an ENABLED vault must leave a fresh bundle when a short-lived
// process transacts then exits before the 4s debounce fires — but a read-only run
// (no leaf change) must NOT pay for a redundant snapshot on the way out.
describe("leaf-vault flush-on-dispose (dirty tracking)", () => {
  const leaf = (id) => ({ id, status: "AVAILABLE", nodeTx: Uint8Array.from([1, 2, 3]), refundTx: Uint8Array.from([4, 5, 6]) });
  const mkWallet = (onGetLeaves, owned) => {
    const ee = new EventEmitter();
    return {
      on: (ev, cb) => ee.on(ev, cb),
      off: (ev, cb) => ee.off(ev, cb),
      emit: (ev) => ee.emit(ev),
      leafManager: { getLeaves: async () => onGetLeaves() },
      connectionManager: { createSparkClient: async () => ({}) },
      config: { getCoordinatorAddress: () => "coord" },
      getBalance: async () => mkBalance(owned),
    };
  };

  it("FLUSHES a final snapshot on dispose after a leaf-changing event (dirty)", async () => {
    const p = uniq("lv-flush-dirty") + ".json";
    try {
      let calls = 0;
      const w = mkWallet(() => { calls += 1; return [leaf("leaf1")]; }, 100000n);
      // huge debounce/interval so ONLY the boot snapshot + our explicit flush run
      const v = enableLeafVault(w, { path: p, networkLabel: "LOCAL", intervalMs: 9e6, debounceMs: 9e6 });
      await v.ready;
      expect(calls).toBe(1); // boot snapshot
      w.emit("balance:update"); // a change; its debounced snapshot won't fire (9e6ms)
      await v.dispose(); // dirty -> flush
      expect(calls).toBe(2); // boot + flush
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1"]);
    } finally { await rm(p, { force: true }); }
  });

  it("does NOT flush on dispose for a read-only run (no leaf change)", async () => {
    const p = uniq("lv-flush-clean") + ".json";
    try {
      let calls = 0;
      const w = mkWallet(() => { calls += 1; return [leaf("leaf1")]; }, 100000n);
      const v = enableLeafVault(w, { path: p, networkLabel: "LOCAL", intervalMs: 9e6, debounceMs: 9e6 });
      await v.ready;
      await v.dispose(); // no event -> not dirty -> no flush
      expect(calls).toBe(1); // boot only
    } finally { await rm(p, { force: true }); }
  });

  it("a transient-empty getLeaves does NOT clear dirty, so dispose still flushes (ToB Finding 1)", async () => {
    const p = uniq("lv-skip-dirty") + ".json";
    try {
      let call = 0;
      // boot -> leaf present (writes); debounced snapshot -> transient empty (SKIP, keeps prior);
      // dispose flush -> leaf present again. The skip must leave the vault dirty, so the flush runs.
      const seq = [[leaf("leaf1")], [], [leaf("leaf1")]];
      const w = mkWallet(() => seq[Math.min(call++, seq.length - 1)], 100000n);
      const v = enableLeafVault(w, { path: p, networkLabel: "LOCAL", intervalMs: 9e6, debounceMs: 0 });
      await v.ready; // boot snapshot (call 1 -> [leaf], writes)
      w.emit("balance:update"); // changeGen -> 1; debounce 0 schedules an immediate snapshot
      await new Promise((r) => setTimeout(r, 60)); // let it run (call 2 -> [] -> transient-empty SKIP)
      await v.dispose(); // skip left it dirty -> flush (call 3 -> [leaf], writes)
      expect(call).toBeGreaterThanOrEqual(3); // boot + skipped debounced + flush
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1"]);
    } finally { await rm(p, { force: true }); }
  });
});
