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
import { buildUnilateralExitChain, Network } from "@buildonspark/spark-sdk";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { open, mkdir, unlink } from "node:fs/promises";
import { atomicWriteJson, readVault, validateSnapshotShape } from "../../../lib/leaf-vault.js";

// TreeNode protobuf codec — loaded LAZILY from the SDK's own exports subpath
// (`@buildonspark/spark-sdk/proto/spark`), NOT by hand-navigating the package
// layout. Lazy so a codec-resolution failure disables only the vault: this module
// is statically imported by spark-agent.js, and a top-level `await import` that
// threw would brick SparkAgent at construction — before the SPARK_LEAF_VAULT=off
// opt-out could take effect and taking down all wallet functionality with it.
let _TreeNode = null;
async function getTreeNode() {
  if (_TreeNode) return _TreeNode;
  try {
    ({ TreeNode: _TreeNode } = await import("@buildonspark/spark-sdk/proto/spark"));
  } catch (e) {
    throw new Error(`leaf-vault: cannot load the SDK TreeNode codec (@buildonspark/spark-sdk/proto/spark): ${e?.message ?? e}. Backup NOT captured.`);
  }
  return _TreeNode;
}
const encodeNode = (TreeNode, node) => Buffer.from(TreeNode.encode(TreeNode.fromPartial(node)).finish()).toString("hex");
const decodeNode = (TreeNode, hex) => TreeNode.decode(Uint8Array.from(Buffer.from(hex, "hex")));

export const DEFAULT_VAULT_PATH =
  process.env.SPARK_LEAF_VAULT_PATH || join(homedir(), ".spark", "leaf-vault", "current.json");

// Fail LOUD if the protected internals we depend on have moved. A silently-empty
// or unencodable vault is the worst possible failure for recovery data, so we
// throw rather than capture nothing.
export function assertLeafInternalsIntact(wallet, TreeNode) {
  const missing = [];
  if (typeof wallet?.leafManager?.getLeaves !== "function") missing.push("wallet.leafManager.getLeaves");
  if (typeof wallet?.connectionManager?.createSparkClient !== "function") missing.push("wallet.connectionManager.createSparkClient");
  if (typeof wallet?.config?.getCoordinatorAddress !== "function") missing.push("wallet.config.getCoordinatorAddress");
  if (typeof TreeNode?.encode !== "function" || typeof TreeNode?.decode !== "function" || typeof TreeNode?.fromPartial !== "function") {
    missing.push("TreeNode proto codec (encode/decode/fromPartial)");
  }
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
// operators) AND that the leaf nodes carry their pre-signed txs — and only then
// persist atomically. Writes nothing on any failure.
export async function snapshotLeafVault(wallet, { path = DEFAULT_VAULT_PATH, networkLabel } = {}) {
  const TreeNode = await getTreeNode();
  assertLeafInternalsIntact(wallet, TreeNode);

  const leaves = await wallet.leafManager.getLeaves(true);
  const network = networkLabel ?? String(leaves[0]?.network ?? "UNKNOWN");
  const netEnum = networkLabel != null && Network[networkLabel] !== undefined ? Network[networkLabel] : undefined;

  if (leaves.length === 0) {
    // Guard a TRANSIENT empty getLeaves(true) (leaves momentarily non-AVAILABLE
    // mid-optimize/transfer, or a coordinator hiccup) from atomically clobbering a
    // good vault. Only persist empty if the wallet genuinely reports zero balance
    // AND no prior vault held leaves; otherwise keep the last-good vault.
    const prior = await readVault(path).catch(() => null);
    const priorLeaves = prior?.leafIds?.length ?? 0;
    if (priorLeaves > 0) {
      let sats = null;
      try { const b = await wallet.getBalance(); sats = b?.balance ?? b?.satsBalance?.available ?? null; } catch { /* unreadable → treat as non-zero */ }
      if (sats == null || BigInt(sats) > 0n) {
        return { path, leafCount: priorLeaves, nodeCount: prior?.nodes?.length ?? 0, network, skipped: "transient-empty-getLeaves" };
      }
    }
    const empty = { version: 2, network, updatedAt: new Date().toISOString(), leafIds: [], nodes: [] };
    await atomicWriteJson(path, empty);
    return { path, leafCount: 0, nodeCount: 0, network };
  }

  const client = await wallet.connectionManager.createSparkClient(wallet.config.getCoordinatorAddress());

  const allNodes = new Map();  // id -> live TreeNode (leaves + every resolved parent)
  const onlineLen = new Map(); // leafId -> resolved chain length (completeness target)
  for (const leaf of leaves) {
    const nodeMap = new Map();
    const chain = await buildUnilateralExitChain(leaf, nodeMap, client, netEnum); // real network (not undefined→MAINNET)
    if (!chain.length) throw new Error(`leaf-vault: could not resolve exit chain for leaf ${leaf.id}; backup NOT captured.`);
    onlineLen.set(leaf.id, chain.length);
    allNodes.set(leaf.id, leaf);
    for (const n of nodeMap.values()) allNodes.set(n.id, n);
  }

  // Encode each node to canonical protobuf hex. `value` is kept only for human
  // readability; the hex is the source of truth.
  const nodes = [...allNodes.values()].map((n) => ({ id: n.id, value: String(n.value ?? ""), hex: encodeNode(TreeNode, n) }));
  const snapshot = { version: 2, network, updatedAt: new Date().toISOString(), leafIds: leaves.map((l) => l.id), nodes };

  // --- INTEGRITY GATE (must pass or nothing is written) ---
  const persisted = JSON.parse(JSON.stringify(snapshot)); // exactly the bytes that hit disk
  const shape = validateSnapshotShape(persisted);
  if (!shape.ok) throw new Error(`leaf-vault: snapshot failed shape validation (${shape.reason}); backup NOT written.`);

  const reMap = new Map(persisted.nodes.map((n) => [n.id, decodeNode(TreeNode, n.hex)]));

  // CONTENT gate: chain topology alone (buildUnilateralExitChain reads only
  // status/parentNodeId) can PASS even if an SDK change emptied the pre-signed tx
  // bytes — TreeNode.fromPartial silently defaults absent fields to empty. The
  // exit CONSUMES nodeTx/refundTx, so assert the leaf nodes actually carry them,
  // or "validated" would not imply "exitable".
  for (const leafId of persisted.leafIds) {
    const ln = reMap.get(leafId);
    if (!(ln?.nodeTx?.length > 0) || !(ln?.refundTx?.length > 0)) {
      throw new Error(`leaf-vault: leaf ${leafId} is missing pre-signed nodeTx/refundTx bytes — captured data is not exitable; backup NOT written.`);
    }
  }

  // TOPOLOGY gate: every leaf must rebuild to the same chain length OFFLINE.
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
// leaf's chain OFFLINE (no wallet, no operators), AND confirm each leaf carries
// its pre-signed txs. Run periodically / before you trust a vault.
export async function verifyVault(path = DEFAULT_VAULT_PATH) {
  const TreeNode = await getTreeNode();
  const vault = await readVault(path);
  const shape = validateSnapshotShape(vault);
  if (!shape.ok) return { ok: false, reason: shape.reason, leafCount: vault?.leafIds?.length ?? 0 };
  const reMap = new Map(vault.nodes.map((n) => [n.id, decodeNode(TreeNode, n.hex)]));
  const failed = [];
  for (const leafId of vault.leafIds) {
    const ln = reMap.get(leafId);
    const chain = await buildUnilateralExitChain(ln, reMap, undefined, undefined);
    if (!chain.length || !(ln?.nodeTx?.length > 0) || !(ln?.refundTx?.length > 0)) failed.push(leafId);
  }
  return {
    ok: failed.length === 0,
    reason: failed.length ? `${failed.length} leaf/leaves do not reconstruct offline (or lack pre-signed txs)` : "all leaves reconstruct offline",
    leafCount: vault.leafIds.length,
    failed,
    updatedAt: vault.updatedAt,
    network: vault.network,
  };
}

// A conspicuous on-disk signal that the backup is failing, so a broken vault is
// not merely a single unread stderr line. Written next to the vault.
async function writeBrokenMarker(markerPath, err, failures) {
  const body =
    `leaf-vault backup is BROKEN as of ${new Date().toISOString()}\n` +
    `consecutive failures: ${failures}\n` +
    `last error: ${err?.message ?? err}\n\n` +
    `Unilateral exit may be IMPOSSIBLE until this is resolved. The wallet still works,\n` +
    `but the operatorless-recovery backup is NOT being written. See references/unilateral-exit.md.\n`;
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 }).catch(() => {});
  const fh = await open(markerPath, "w", 0o600);
  try { await fh.writeFile(body); } finally { await fh.close(); }
}

// Keep the vault current. Snapshots at boot, on every leaf-changing event
// (`balance:update`, `transfer:claimed`, `deposit:confirmed` — the receive/send/
// deposit signals), and on a low-frequency safety-net timer that catches timelock
// REFRESHES (which change exit material without a balance event; a refresh-stale
// vault still recovers to you, so the timer lag is harmless — see
// references/recovery-scenarios.md). Overlapping triggers are single-flighted so
// concurrent writes can't race; a burst of events is also debounced. Returns
// `{ dispose, ready, health }` — `ready` resolves to `{ ok, error? }` for the boot
// snapshot so a caller can surface a broken backup loudly instead of silently.
export function enableLeafVault(wallet, { path = DEFAULT_VAULT_PATH, networkLabel, intervalMs = 20 * 60_000, debounceMs = 4000, maxConsecutiveFailures = 3, onError } = {}) {
  // Validate options so a bad interval/debounce can't silently disable the refresh
  // safety-net.
  debounceMs = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : 4000;
  intervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 20 * 60_000;

  const brokenMarker = join(dirname(path), "BROKEN");
  let consecutiveFailures = 0;
  let lastSuccessAt = null;
  let lastError = null;
  let inFlight = null;
  let disposed = false;

  const report = (e) => (onError ? onError(e) : console.error(`[leaf-vault] snapshot FAILED (${consecutiveFailures}x in a row): ${e?.message ?? e}`));

  // Single-flight: coalesce overlapping triggers (boot + event + timer) into ONE
  // running snapshot, so concurrent atomicWriteJson calls can't race and a burst
  // doesn't stack redundant operator round-trips.
  const runSnapshot = () => {
    if (disposed) return Promise.resolve(null);
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const r = await snapshotLeafVault(wallet, { path, networkLabel });
        consecutiveFailures = 0; lastSuccessAt = Date.now(); lastError = null;
        await unlink(brokenMarker).catch(() => {}); // recovered → clear the marker
        return r;
      } catch (e) {
        consecutiveFailures++; lastError = e;
        report(e);
        // Fail LOUD-and-persistent, not one unread stderr line. An internals-moved
        // / codec-load error means capture is IMPOSSIBLE (not transient) → mark
        // immediately; otherwise mark after N failures in a row.
        const fatal = /SDK internals moved|cannot load the SDK TreeNode/i.test(String(e?.message));
        if (fatal || consecutiveFailures >= maxConsecutiveFailures) await writeBrokenMarker(brokenMarker, e, consecutiveFailures).catch(() => {});
        throw e;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  // Debounce chatty events into one snapshot after the wallet settles.
  let debounceTimer = null;
  const schedule = () => {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { debounceTimer = null; runSnapshot().catch(() => {}); }, debounceMs);
    debounceTimer.unref?.();
  };

  // Boot snapshot; `ready` always RESOLVES (never rejects) to a health object.
  const ready = runSnapshot().then(() => ({ ok: true }), (e) => ({ ok: false, error: e?.message ?? String(e) }));

  const events = ["balance:update", "transfer:claimed", "deposit:confirmed"];
  for (const ev of events) wallet.on?.(ev, schedule);
  // Timer calls runSnapshot DIRECTLY (not the debounced schedule) so the refresh
  // safety-net fires regardless of the debounce interval.
  const timer = setInterval(() => runSnapshot().catch(() => {}), intervalMs);
  timer.unref?.();

  const dispose = async () => {
    disposed = true;
    for (const ev of events) wallet.off?.(ev, schedule);
    clearInterval(timer);
    if (debounceTimer) clearTimeout(debounceTimer);
    await inFlight?.catch(() => {}); // let an in-flight snapshot finish before teardown
  };

  return {
    dispose,
    ready,
    health: () => ({ healthy: consecutiveFailures === 0 && lastSuccessAt != null, lastSuccessAt, consecutiveFailures, lastError: lastError?.message ?? null }),
  };
}

// CLI: `node leaf-vault.js verify` checks the current vault; no arg takes a
// snapshot using the encrypted-seed wallet.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
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
