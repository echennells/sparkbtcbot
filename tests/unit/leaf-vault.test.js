import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import { atomicWriteJson, readVault, validateSnapshotShape, isHexString } from "../../lib/leaf-vault.js";

describe("atomicWriteJson + readVault (plain-JSON protobuf-hex vault)", () => {
  it("writes and reads back a vault verbatim", async () => {
    const p = join(tmpdir(), `leafvault-test-${process.pid}.json`);
    try {
      const snap = { version: 2, network: "REGTEST", updatedAt: "2026-07-07T00:00:00.000Z", leafIds: ["n1"], nodes: [{ id: "n1", value: "4096", hex: "0a0401020304" }] };
      await atomicWriteJson(p, snap);
      expect(await readVault(p)).toEqual(snap);
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

describe("validateSnapshotShape", () => {
  const node = (id) => ({ id, value: "1", hex: "0a020102" });
  it("accepts a well-formed vault", () => {
    expect(validateSnapshotShape({ version: 2, network: "REGTEST", leafIds: ["a"], nodes: [node("a"), node("b")] })).toMatchObject({ ok: true });
  });
  it("accepts an explicit empty vault (no leaves)", () => {
    expect(validateSnapshotShape({ version: 2, network: "REGTEST", leafIds: [], nodes: [] })).toMatchObject({ ok: true });
  });
  it("rejects missing version or network", () => {
    expect(validateSnapshotShape({ network: "R", leafIds: [], nodes: [] }).ok).toBe(false);
    expect(validateSnapshotShape({ version: 2, leafIds: [], nodes: [] }).ok).toBe(false);
  });
  it("rejects a node with no/invalid protobuf hex (unusable recovery data)", () => {
    expect(validateSnapshotShape({ version: 2, network: "R", leafIds: ["a"], nodes: [{ id: "a", hex: "" }] }).ok).toBe(false);
    expect(validateSnapshotShape({ version: 2, network: "R", leafIds: ["a"], nodes: [{ id: "a", hex: "zz" }] }).ok).toBe(false);
    const r = validateSnapshotShape({ version: 2, network: "R", leafIds: ["a"], nodes: [{ id: "a", hex: "abc" }] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("hex");
  });
  it("rejects a node missing a string id", () => {
    const r = validateSnapshotShape({ version: 2, network: "R", leafIds: ["a"], nodes: [{ hex: "0a020102" }] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("id");
  });
  it("rejects a leaf that is not present among the nodes (chain can't start)", () => {
    const r = validateSnapshotShape({ version: 2, network: "R", leafIds: ["gone"], nodes: [node("a")] });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("gone");
  });
  it("rejects leafIds-empty-but-nodes-present (inconsistent)", () => {
    expect(validateSnapshotShape({ version: 2, network: "R", leafIds: [], nodes: [node("a")] }).ok).toBe(false);
  });
});
