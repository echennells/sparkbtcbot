// Leaf-vault: continuously mirror the unilateral-exit "leaf material" to disk so
// funds are recoverable with operators offline. See references/unilateral-exit.md.
//
// SDK reach-in half (the SDK-free persistence/validation is lib/leaf-vault.js).
// The data we back up — the leaves as TreeNodes plus their resolved parent chain —
// is reachable only through the SDK's `protected` internals (wallet.leafManager /
// connectionManager / config) and the internal TreeNode proto codec. `protected`
// is a TypeScript-only barrier; the fields are real at runtime. Since they are NOT
// public API, we guard every access with a fail-loud self-check.
//
// Each node is persisted as its CANONICAL protobuf hex (TreeNode.encode) — the
// exact bytes the SDK uses — so recovery is a byte-faithful TreeNode.decode rather
// than a fragile field-by-field JSON reconstruction.
import { buildUnilateralExitChain } from "@buildonspark/spark-sdk";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { atomicWriteJson, readVault, validateSnapshotShape } from "../../../lib/leaf-vault.js";

// TreeNode protobuf codec — an internal SDK proto module, resolved RELATIVE to the
// installed SDK so it survives different install locations.
const require = createRequire(import.meta.url);
const { TreeNode } = await import(
  pathToFileURL(join(dirname(require.resolve("@buildonspark/spark-sdk")), "proto", "spark.js")).href
);
const encodeNode = (node) => Buffer.from(TreeNode.encode(TreeNode.fromPartial(node)).finish()).toString("hex");
const decodeNode = (hex) => TreeNode.decode(Uint8Array.from(Buffer.from(hex, "hex")));

export const DEFAULT_VAULT_PATH =
  process.env.SPARK_LEAF_VAULT_PATH || join(homedir(), ".spark", "leaf-vault", "current.json");

// Fail LOUD if the protected internals we depend on have moved. A silently-empty
// or unencodable vault is the worst possible failure for recovery data, so we
// throw rather than capture nothing.
export function assertLeafInternalsIntact(wallet) {
  const missing = [];
  if (typeof wallet?.leafManager?.getLeaves !== "function") missing.push("wallet.leafManager.getLeaves");
  if (typeof wallet?.connectionManager?.createSparkClient !== "function") missing.push("wallet.connectionManager.createSparkClient");
  if (typeof wallet?.config?.getCoordinatorAddress !== "function") missing.push("wallet.config.getCoordinatorAddress");
  if (typeof TreeNode?.encode !== "function" || typeof TreeNode?.decode !== "function") missing.push("TreeNode proto codec");
  if (missing.length) {
    throw new Error(
      `leaf-vault: SDK internals moved — cannot reach [${missing.join(", ")}]. Backup NOT captured. ` +
      `Re-verify the reach-in against the resolved @buildonspark/spark-sdk version before relying on ` +
      `unilateral-exit recovery.`,
    );
  }
}

// Take an online snapshot: resolve every leaf's leaf->root exit chain (the client
// fills missing parents), encode each node to canonical protobuf hex, then run the
// INTEGRITY GATE — prove the serialized snapshot rebuilds every chain OFFLINE (no
// operators) — and only then persist atomically. Writes nothing on any failure.
export async function snapshotLeafVault(wallet, { path = DEFAULT_VAULT_PATH, networkLabel } = {}) {
  assertLeafInternalsIntact(wallet);

  const leaves = await wallet.leafManager.getLeaves(true);
  const network = networkLabel ?? String(leaves[0]?.network ?? "UNKNOWN");

  if (leaves.length === 0) {
    const empty = { version: 2, network, updatedAt: new Date().toISOString(), leafIds: [], nodes: [] };
    await atomicWriteJson(path, empty);
    return { path, leafCount: 0, nodeCount: 0, network };
  }

  const client = await wallet.connectionManager.createSparkClient(wallet.config.getCoordinatorAddress());

  const allNodes = new Map();  // id -> live TreeNode (leaves + every resolved parent)
  const onlineLen = new Map(); // leafId -> resolved chain length (completeness target)
  for (const leaf of leaves) {
    const nodeMap = new Map();
    const chain = await buildUnilateralExitChain(leaf, nodeMap, client, undefined);
    if (!chain.length) throw new Error(`leaf-vault: could not resolve exit chain for leaf ${leaf.id}; backup NOT captured.`);
    onlineLen.set(leaf.id, chain.length);
    allNodes.set(leaf.id, leaf);
    for (const n of nodeMap.values()) allNodes.set(n.id, n);
  }

  // Encode each node to canonical protobuf hex. `value` is kept only for human
  // readability; the hex is the source of truth.
  const nodes = [...allNodes.values()].map((n) => ({ id: n.id, value: String(n.value ?? ""), hex: encodeNode(n) }));
  const snapshot = { version: 2, network, updatedAt: new Date().toISOString(), leafIds: leaves.map((l) => l.id), nodes };

  // --- INTEGRITY GATE (must pass or nothing is written) ---
  const persisted = JSON.parse(JSON.stringify(snapshot)); // exactly the bytes that hit disk
  const shape = validateSnapshotShape(persisted);
  if (!shape.ok) throw new Error(`leaf-vault: snapshot failed shape validation (${shape.reason}); backup NOT written.`);

  const reMap = new Map(persisted.nodes.map((n) => [n.id, decodeNode(n.hex)]));
  for (const leafId of persisted.leafIds) {
    const offline = await buildUnilateralExitChain(reMap.get(leafId), reMap, undefined, undefined); // NO client
    if (offline.length !== onlineLen.get(leafId)) {
      throw new Error(
        `leaf-vault: leaf ${leafId} rebuilds to ${offline.length}/${onlineLen.get(leafId)} nodes offline — ` +
        `incomplete recovery data; backup NOT written.`,
      );
    }
  }

  await atomicWriteJson(path, persisted);
  return { path, leafCount: persisted.leafIds.length, nodeCount: persisted.nodes.length, network };
}

// "Can I actually recover from this file?" — reload a vault and rebuild every
// leaf's chain OFFLINE (no wallet, no operators). Run periodically / before you
// trust a vault.
export async function verifyVault(path = DEFAULT_VAULT_PATH) {
  const vault = await readVault(path);
  const shape = validateSnapshotShape(vault);
  if (!shape.ok) return { ok: false, reason: shape.reason, leafCount: vault?.leafIds?.length ?? 0 };
  const reMap = new Map(vault.nodes.map((n) => [n.id, decodeNode(n.hex)]));
  const failed = [];
  for (const leafId of vault.leafIds) {
    const chain = await buildUnilateralExitChain(reMap.get(leafId), reMap, undefined, undefined);
    if (!chain.length) failed.push(leafId);
  }
  return {
    ok: failed.length === 0,
    reason: failed.length ? `${failed.length} leaf/leaves do not reconstruct offline` : "all leaves reconstruct offline",
    leafCount: vault.leafIds.length,
    failed,
    updatedAt: vault.updatedAt,
    network: vault.network,
  };
}

// Opt-in: keep the vault current. Snapshots at boot, on every `balance:update`
// (the superset event — deposits, transfers, swaps, claims, AND background
// auto-claim/auto-optimize that mutate leaf state with no user action), and on a
// low-frequency safety-net timer. Returns a disposer.
export function enableLeafVault(wallet, { path = DEFAULT_VAULT_PATH, networkLabel, intervalMs = 30 * 60_000, onError } = {}) {
  const report = (e) => (onError ? onError(e) : console.error("[leaf-vault]", e?.message ?? e));
  const run = () => snapshotLeafVault(wallet, { path, networkLabel }).catch(report);
  run(); // boot snapshot after first sync
  const onBalance = () => run();
  wallet.on?.("balance:update", onBalance);
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  return () => {
    wallet.off?.("balance:update", onBalance);
    clearInterval(timer);
  };
}

// CLI: `node leaf-vault.js verify` checks the current vault; no arg takes a
// snapshot using the encrypted-seed wallet.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "verify") {
    const r = await verifyVault();
    console.log(r.ok ? "✅" : "❌", JSON.stringify(r, null, 2));
    process.exit(r.ok ? 0 : 1);
  } else {
    const [{ SparkWallet }, { loadMnemonicFromEnv }] = await Promise.all([
      import("@buildonspark/spark-sdk"),
      import("../../../lib/encrypted-seed.js"),
    ]);
    const { wallet } = await SparkWallet.initialize({
      mnemonicOrSeed: await loadMnemonicFromEnv(),
      options: { network: process.env.SPARK_NETWORK || "MAINNET" },
    });
    try {
      console.log("✅ leaf-vault snapshot:", JSON.stringify(await snapshotLeafVault(wallet, { networkLabel: process.env.SPARK_NETWORK })));
    } finally {
      await wallet.cleanup();
    }
  }
}
