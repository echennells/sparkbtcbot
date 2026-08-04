import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { atomicWriteJson, readVault, validateSnapshotShape, isHexString } from "../../lib/leaf-vault.js";

describe("atomicWriteJson + readVault (plain-JSON recovery bundle)", () => {
  it("writes and reads back a bundle verbatim", async () => {
    const p = join(tmpdir(), `leafvault-test-${process.pid}.json`);
    try {
      const bundle = { schema: "spark.unilateral-exit-bundle.v1", createdAt: "2026-07-09T00:00:00.000Z", network: "REGTEST", leaves: [{ id: "n1", valueSats: 4096, treeNodeHex: "0a0401020304" }] };
      await atomicWriteJson(p, bundle);
      expect(await readVault(p)).toEqual(bundle);
    } finally {
      await rm(p, { force: true });
    }
  });
});

describe("isHexString", () => {
  it("accepts non-empty even-length hex", () => {
    expect(isHexString("0a0401020304")).toBe(true);
    expect(isHexString("AB")).toBe(true);
  });
  it("rejects empty, odd-length, and non-hex", () => {
    expect(isHexString("")).toBe(false);
    expect(isHexString("abc")).toBe(false); // odd length
    expect(isHexString("zz")).toBe(false);
    expect(isHexString(undefined)).toBe(false);
  });
});

// validateSnapshotShape mirrors Blink's validateRecoveryBundle — this is the
// compatibility contract with blinkbitcoin/spark-unilateral-exit's CLI.
describe("validateSnapshotShape (spark.unilateral-exit-bundle.v1)", () => {
  const bundle = (over = {}) => ({
    schema: "spark.unilateral-exit-bundle.v1",
    createdAt: "2026-07-09T00:00:00.000Z",
    network: "MAINNET",
    leaves: [{ id: "leaf1", valueSats: 4096, treeNodeHex: "0a020102" }],
    ...over,
  });
  it("accepts a well-formed bundle (leaves only)", () => {
    expect(validateSnapshotShape(bundle())).toMatchObject({ ok: true });
  });
  it("accepts optional ancestor nodes", () => {
    expect(validateSnapshotShape(bundle({ nodes: [{ id: "root", treeNodeHex: "0a020304" }] })).ok).toBe(true);
  });
  it("rejects a wrong/missing schema", () => {
    expect(validateSnapshotShape(bundle({ schema: "nope" })).ok).toBe(false);
    expect(validateSnapshotShape(bundle({ schema: undefined })).ok).toBe(false);
  });
  it("rejects a non-ISO createdAt", () => {
    expect(validateSnapshotShape(bundle({ createdAt: "not-a-date" })).ok).toBe(false);
  });
  it("rejects a missing network", () => {
    expect(validateSnapshotShape(bundle({ network: "" })).ok).toBe(false);
  });
  it("rejects an empty leaves array (schema requires >=1 leaf)", () => {
    expect(validateSnapshotShape(bundle({ leaves: [] })).ok).toBe(false);
  });
  it("rejects a leaf with no/invalid treeNodeHex (unusable recovery data)", () => {
    expect(validateSnapshotShape(bundle({ leaves: [{ id: "a", treeNodeHex: "" }] })).ok).toBe(false);
    expect(validateSnapshotShape(bundle({ leaves: [{ id: "a", treeNodeHex: "zz" }] })).ok).toBe(false);
    const r = validateSnapshotShape(bundle({ leaves: [{ id: "a", treeNodeHex: "abc" }] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("treeNodeHex");
  });
  it("rejects a leaf missing an id", () => {
    const r = validateSnapshotShape(bundle({ leaves: [{ treeNodeHex: "0a020102" }] }));
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("id");
  });
  it("rejects a non-integer valueSats", () => {
    expect(validateSnapshotShape(bundle({ leaves: [{ id: "a", valueSats: 1.5, treeNodeHex: "0a020102" }] })).ok).toBe(false);
  });
  it("rejects malformed nodes when present", () => {
    expect(validateSnapshotShape(bundle({ nodes: "x" })).ok).toBe(false);
    expect(validateSnapshotShape(bundle({ nodes: [{ id: "r", treeNodeHex: "zz" }] })).ok).toBe(false);
    expect(validateSnapshotShape(bundle({ nodes: [{ treeNodeHex: "0a020102" }] })).ok).toBe(false);
  });
});
