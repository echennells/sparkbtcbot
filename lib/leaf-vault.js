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

// Structural check. A usable snapshot has a version, a network, a leafIds list, a
// nodes array whose entries each carry a string id + non-empty protobuf hex, and
// every leaf id must be present among the nodes (else its chain can't start).
// Returns { ok, reason }. The real proof that a snapshot can recover funds is the
// offline chain rebuild in scripts/leaf-vault.js — this is the fast pre-filter.
export function validateSnapshotShape(snapshot) {
  if (!snapshot || typeof snapshot !== "object") return { ok: false, reason: "snapshot is not an object" };
  if (snapshot.version == null) return { ok: false, reason: "missing version" };
  if (!snapshot.network) return { ok: false, reason: "missing network" };
  if (!Array.isArray(snapshot.leafIds)) return { ok: false, reason: "leafIds is not an array" };
  if (!Array.isArray(snapshot.nodes)) return { ok: false, reason: "nodes is not an array" };
  // An empty vault (no leaves) is valid — it means "wallet had no Spark balance".
  if (snapshot.leafIds.length === 0) {
    return snapshot.nodes.length === 0
      ? { ok: true, reason: "empty vault (no leaves)" }
      : { ok: false, reason: "leafIds empty but nodes present" };
  }
  const ids = new Set();
  for (const n of snapshot.nodes) {
    if (!n || typeof n.id !== "string") return { ok: false, reason: "a node is missing a string id" };
    if (!isHexString(n.hex)) return { ok: false, reason: `node ${n.id} has no/invalid protobuf hex` };
    ids.add(n.id);
  }
  for (const lid of snapshot.leafIds) {
    if (!ids.has(lid)) return { ok: false, reason: `leaf ${lid} is not present among the nodes` };
  }
  return { ok: true, reason: "ok" };
}
