// Pure persistence + validation for the unilateral-exit "leaf vault".
//
// Background: a Spark seed phrase alone CANNOT unilaterally exit — exit needs the
// tree of pre-signed node/refund txs ("leaf material") that operators hand the
// wallet at claim/transfer time and it holds in memory. If operators go dark and
// you have no local copy, you cannot broadcast. The leaf-vault is a
// continuously-maintained on-disk mirror of that material so an operatorless exit
// is actually possible. See references/unilateral-exit.md.
//
// Design: each node is stored as its CANONICAL TreeNode protobuf hex — the exact
// bytes the SDK uses on the wire — NOT a JSON decomposition of its fields. That
// keeps the vault plain-JSON (hex strings + metadata) and removes an entire class
// of serialization bugs: there is no per-field type handling (Uint8Array/Buffer/
// bigint/Date) to get wrong, because the node is never disassembled. Recovery is a
// byte-faithful decode, not a field-by-field reconstruction. The SDK proto
// encode/decode lives in scripts/leaf-vault.js; this module is the SDK-free
// persistence + shape core.

import { open, rename, mkdir, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";

// Atomic, crash-safe write: UNIQUE temp file → fsync → rename → dir fsync. A
// half-written OR clobbered vault is the only thing between the agent and its
// recovery data, so two things matter: (1) the temp name is unique per call and
// opened O_EXCL ("wx") — concurrent snapshots (boot + event + timer all fire in
// one process) must never share an inode, or one writer's O_TRUNC corrupts the
// other mid-write and a rename publishes spliced bytes; (2) the parent directory
// is fsync'd after the rename so the new directory entry survives power loss (the
// file fsync alone doesn't make the rename durable). Matches lib/encrypted-seed.js.
export async function atomicWriteJson(path, obj) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 }).catch(() => {}); // 0700 — recovery data
  const tmp = `${path}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  const fh = await open(tmp, "wx", 0o600); // wx = O_CREAT|O_EXCL|O_WRONLY
  try {
    await fh.writeFile(JSON.stringify(obj));
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmp, path); // atomic commit point
  } catch (e) {
    await unlink(tmp).catch(() => {}); // never leave a stray temp on a failed publish
    throw e;
  }
  try {
    const dh = await open(dir, "r"); // fsync the directory so the rename is durable
    try { await dh.sync(); } finally { await dh.close(); }
  } catch { /* some platforms/filesystems reject directory fsync — best-effort */ }
  return path;
}

export async function readVault(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function isHexString(s) {
  return typeof s === "string" && s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
}

function isNonEmptyStr(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// The recovery-bundle schema we produce and validate — Blink's
// `spark.unilateral-exit-bundle.v1` (blinkbitcoin/spark-unilateral-exit), the
// format their production recovery CLI consumes.
export const BUNDLE_SCHEMA = "spark.unilateral-exit-bundle.v1";

// Structural check, mirroring Blink's validateRecoveryBundle: a supported schema
// tag, an ISO createdAt, a network, and >=1 leaf each carrying a string id + hex
// treeNodeHex (+ optional integer valueSats); optional ancestor `nodes` each
// {id, treeNodeHex}. Returns { ok, reason }. The real proof that a bundle can
// recover funds is the offline chain rebuild in scripts/leaf-vault.js — this is
// the fast pre-filter and the compatibility contract with Blink's CLI.
export function validateSnapshotShape(bundle) {
  if (!bundle || typeof bundle !== "object" || Array.isArray(bundle)) return { ok: false, reason: "bundle must be a JSON object" };
  if (bundle.schema !== BUNDLE_SCHEMA) return { ok: false, reason: `unsupported schema: ${bundle.schema ?? "missing"}` };
  if (typeof bundle.createdAt !== "string" || Number.isNaN(Date.parse(bundle.createdAt))) return { ok: false, reason: "createdAt must be an ISO timestamp" };
  if (!isNonEmptyStr(bundle.network)) return { ok: false, reason: "network is required" };
  if (!Array.isArray(bundle.leaves) || bundle.leaves.length === 0) return { ok: false, reason: "bundle must include at least one leaf" };
  for (let i = 0; i < bundle.leaves.length; i++) {
    const leaf = bundle.leaves[i];
    if (!leaf || typeof leaf !== "object" || Array.isArray(leaf)) return { ok: false, reason: `leaf ${i} must be an object` };
    if (!isNonEmptyStr(leaf.id)) return { ok: false, reason: `leaf ${i} id is required` };
    if (!isHexString(leaf.treeNodeHex)) return { ok: false, reason: `leaf ${leaf.id} treeNodeHex must be hex` };
    if (leaf.valueSats !== undefined && !Number.isSafeInteger(leaf.valueSats)) return { ok: false, reason: `leaf ${leaf.id} valueSats must be an integer` };
  }
  if (bundle.nodes !== undefined) {
    if (!Array.isArray(bundle.nodes)) return { ok: false, reason: "nodes must be an array when present" };
    for (let i = 0; i < bundle.nodes.length; i++) {
      const n = bundle.nodes[i];
      if (!n || typeof n !== "object" || Array.isArray(n) || !isNonEmptyStr(n.id)) return { ok: false, reason: `node ${i} id is required` };
      if (!isHexString(n.treeNodeHex)) return { ok: false, reason: `node ${n.id} treeNodeHex must be hex` };
    }
  }
  return { ok: true, reason: "ok" };
}
