// Regression tests for the Trail-of-Bits review fixes on the leaf-vault. Each test
// triggers the specific NEW branch a fix added — the failure/edge paths a green
// end-to-end run does not exercise (that gap was the whole point of the review).
import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, readFile, readdir, stat, mkdir } from "node:fs/promises";
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

// M-2 — a transient empty getLeaves() must not atomically clobber a good vault.
describe("transient empty getLeaves guard (M-2)", () => {
  const mockWallet = (leaves, balance) => ({
    leafManager: { getLeaves: async () => leaves },
    connectionManager: { createSparkClient: async () => ({}) },
    config: { getCoordinatorAddress: () => "coord" },
    getBalance: async () => ({ balance }),
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
  const leafObj = (id) => ({ id, status: "AVAILABLE", nodeTx: Uint8Array.from([1, 2, 3]), refundTx: Uint8Array.from([4, 5, 6]) });
  const writePriorTwo = (p) => atomicWriteJson(p, {
    schema: "spark.unilateral-exit-bundle.v1", createdAt: "2026-07-09T00:00:00.000Z", network: "LOCAL",
    leaves: [{ id: "leaf1", valueSats: 100000, treeNodeHex: "0a020102" }, { id: "leaf2", valueSats: 100000, treeNodeHex: "0a020102" }],
  });
  const mockWallet = (leaves, balance) => ({
    leafManager: { getLeaves: async () => leaves },
    connectionManager: { createSparkClient: async () => ({}) },
    config: { getCoordinatorAddress: () => "coord" },
    getBalance: async () => ({ balance }),
  });

  it("KEEPS the complete 2-leaf bundle when getLeaves drops a leaf but balance still covers both", async () => {
    const p = uniq("lv-shrink-partial") + ".json";
    try {
      await writePriorTwo(p);
      await expect(
        snapshotLeafVault(mockWallet([leafObj("leaf1")], 200000n), { path: p, networkLabel: "LOCAL" }),
      ).rejects.toThrow(/partial getLeaves|prior bundle KEPT/i);
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1", "leaf2"]); // complete bundle preserved
    } finally { await rm(p, { force: true }); }
  });

  it("WRITES the smaller bundle when the dropped leaf was genuinely spent (balance fell)", async () => {
    const p = uniq("lv-shrink-spent") + ".json";
    try {
      await writePriorTwo(p);
      const r = await snapshotLeafVault(mockWallet([leafObj("leaf1")], 100000n), { path: p, networkLabel: "LOCAL" });
      expect(r.leafCount).toBe(1);
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1"]); // legit shrink published
    } finally { await rm(p, { force: true }); }
  });

  it("KEEPS the complete bundle when a leaf is dropped and balance is UNREADABLE (conservative)", async () => {
    const p = uniq("lv-shrink-unreadable") + ".json";
    try {
      await writePriorTwo(p);
      const wallet = mockWallet([leafObj("leaf1")], 0n);
      wallet.getBalance = async () => { throw new Error("coordinator unreachable"); };
      await expect(snapshotLeafVault(wallet, { path: p, networkLabel: "LOCAL" })).rejects.toThrow(/partial getLeaves|unreadable/i);
      expect((await readVault(p)).leaves.map((l) => l.id)).toEqual(["leaf1", "leaf2"]);
    } finally { await rm(p, { force: true }); }
  });
});
