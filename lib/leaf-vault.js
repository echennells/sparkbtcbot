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

import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWriteFile } from "./atomic-file.js";

// A half-written OR clobbered vault is the only thing between the agent and its
// recovery data — the crash/concurrency guarantees (H-3) live in the shared
// writer, lib/atomic-file.js.
export async function atomicWriteJson(path, obj) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 }).catch(() => {}); // 0700 — recovery data
  return atomicWriteFile(path, JSON.stringify(obj));
}

export async function readVault(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

export function isHexString(s) {
  return typeof s === "string" && s.length > 0 && s.length % 2 === 0 && /^[0-9a-fA-F]+$/.test(s);
}

export function isNonEmptyStr(v) {
  return typeof v === "string" && v.trim().length > 0;
}

// The recovery-bundle schema we produce and validate — Blink's
// `spark.unilateral-exit-bundle.v1` (blinkbitcoin/spark-unilateral-exit), the
// format their production recovery CLI consumes.
export const BUNDLE_SCHEMA = "spark.unilateral-exit-bundle.v1";

// The networks Blink's recovery CLI accepts. A bundle whose label is outside
// this set (a stringified numeric proto enum like "1", an older/foreign
// bundle, a typo) verifies structurally but is REFUSED at recovery time — so
// the shape gate, which is the compatibility contract, must enforce it. The
// snapshot writer refuses these too (scripts/leaf-vault.js), but verifyVault
// runs this validator against bundles it did NOT produce, so the check has to
// live here or a bad-label bundle passes verify green (F2).
export const RECOVERABLE_NETWORKS = ["MAINNET", "REGTEST", "TESTNET", "SIGNET", "LOCAL"];

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
  if (!RECOVERABLE_NETWORKS.includes(bundle.network)) return { ok: false, reason: `network "${bundle.network}" is not one Blink's recovery CLI accepts (${RECOVERABLE_NETWORKS.join("/")})` };
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
