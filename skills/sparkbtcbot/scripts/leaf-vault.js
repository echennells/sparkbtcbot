// Leaf-vault: continuously mirror the unilateral-exit "leaf material" to disk so
// funds are recoverable with the Spark operators offline. Recovery itself is NOT
// done here — the exit is performed by Blink's production tool
// (github.com/blinkbitcoin/spark-unilateral-exit); this module keeps a fresh,
// complete recovery bundle in exactly the format that tool consumes
// (`spark.unilateral-exit-bundle.v1`). See references/unilateral-exit.md.
//
// SDK reach-in half (the SDK-free persistence/validation is lib/leaf-vault.js).
// The data we back up — the leaves as TreeNodes plus their resolved ancestor
// chain — is reachable only through the SDK's `protected` internals
// (wallet.leafManager / connectionManager / config) and the internal TreeNode
// proto codec. `protected` is a TypeScript-only barrier; the fields are real at
// runtime. Since they are NOT public API, we guard every access with a fail-loud
// self-check.
//
// Each node is persisted as its CANONICAL protobuf hex (TreeNode.encode) — the
// `treeNodeHex` Blink's CLI decodes — so recovery is a byte-faithful decode. The
// bundle carries `leaves[]` (which leaves to exit) plus `nodes[]` (their ancestor
// tree nodes), which Blink's createBundleSparkClient serves to the SDK offline to
// rebuild each exit chain; the ancestors are REQUIRED for any multi-level tree.
import { buildUnilateralExitChain, Network } from "@buildonspark/spark-sdk";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { open, mkdir, unlink } from "node:fs/promises";
import { atomicWriteJson, readVault, validateSnapshotShape, BUNDLE_SCHEMA } from "../../../lib/leaf-vault.js";

// TreeNode protobuf codec — loaded LAZILY from the SDK's own exports subpath
// (`@buildonspark/spark-sdk/proto/spark`). Lazy so a codec-resolution failure
// disables only the vault, NOT the whole agent (this module is statically
// imported by spark-agent.js).
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

const KNOWN_NETWORKS = ["MAINNET", "REGTEST", "TESTNET", "SIGNET", "LOCAL"];
const normalizeNetwork = (v) => String(v ?? "").toUpperCase();
const APP_VERSION = "sparkbtcbot";
const safe = async (fn) => { try { return await fn(); } catch { return undefined; } };
const toHexMaybe = (v) => (typeof v === "string" ? v : v && v.length ? Buffer.from(v).toString("hex") : undefined);
function toSafeSats(value) { try { const n = Number(BigInt(value ?? 0)); return Number.isSafeInteger(n) ? n : undefined; } catch { return undefined; } }
let _sdkVersion;
function sdkVersion() {
  if (_sdkVersion !== undefined) return _sdkVersion;
  try { _sdkVersion = createRequire(import.meta.url)("@buildonspark/spark-sdk/package.json").version ?? "unknown"; } catch { _sdkVersion = "unknown"; }
  return _sdkVersion;
}
function exportBalances(balance, leaves) {
  const btc = balance?.balance ?? balance?.satsBalance?.owned ?? balance?.satsBalance?.available;
  let btcSats;
  try { btcSats = btc != null ? String(BigInt(btc)) : String(leaves.reduce((s, l) => s + BigInt(l.value ?? 0), 0n)); } catch { btcSats = undefined; }
  return { ...(btcSats != null ? { btcSats } : {}), usdb: { status: "not-covered-by-bitcoin-unilateral-exit" } };
}

// The wallet's reported owned sats as a BigInt, or null when unreadable. Used by
// the empty- and shrink-guards to distinguish a real balance change from a
// transient/partial getLeaves. Unreadable is deliberately null (caller treats it
// conservatively) rather than 0.
async function reportedBalanceSats(wallet) {
  try {
    const b = await wallet.getBalance?.();
    const v = b?.balance ?? b?.satsBalance?.owned ?? b?.satsBalance?.available ?? null;
    return v == null ? null : BigInt(v);
  } catch { return null; }
}

// Sum of a bundle's leaf `valueSats` as a BigInt, or null if any leaf lacks a
// value (so we never silently under-count and mis-fire the shrink guard).
function sumLeafSats(leaves) {
  try {
    let s = 0n;
    for (const l of leaves) { if (l?.valueSats == null) return null; s += BigInt(l.valueSats); }
    return s;
  } catch { return null; }
}

// Fail LOUD if the protected internals we depend on have moved. A silently-empty
// or unencodable bundle is the worst possible failure for recovery data, so we
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

// Take an online snapshot into a Blink `spark.unilateral-exit-bundle.v1` bundle:
// resolve every leaf's leaf->root exit chain (the client fills ancestors), split
// into leaves + ancestor nodes, then run the INTEGRITY GATE — the leaf carries its
// pre-signed txs, the chain reaches a genuine root, and every leaf reconstructs
// OFFLINE — and only then persist atomically. Writes nothing on any failure.
export async function snapshotLeafVault(wallet, { path = DEFAULT_VAULT_PATH, networkLabel, operatorSet = "spark-sdk", appVersion = APP_VERSION } = {}) {
  const TreeNode = await getTreeNode();
  assertLeafInternalsIntact(wallet, TreeNode);

  const leaves = await wallet.leafManager.getLeaves(true);
  const network = normalizeNetwork(networkLabel ?? String(leaves[0]?.network ?? "MAINNET"));

  if (leaves.length === 0) {
    // The bundle schema requires >=1 leaf; an empty wallet has nothing to exit.
    // Guard a TRANSIENT empty getLeaves from discarding a good bundle (M-2): only
    // treat empty as real when the wallet genuinely reports zero balance.
    const prior = await readVault(path).catch(() => null);
    if (Array.isArray(prior?.leaves) && prior.leaves.length > 0) {
      const sats = await reportedBalanceSats(wallet); // null when unreadable → treat as non-zero
      if (sats == null || sats > 0n) return { path, leafCount: prior.leaves.length, skipped: "transient-empty-getLeaves" };
    }
    return { path, leafCount: 0, skipped: "no-leaves" }; // nothing to back up; any prior bundle is left in place
  }

  const netEnum = Network[network];
  const client = await wallet.connectionManager.createSparkClient(wallet.config.getCoordinatorAddress());

  const leafIds = new Set(leaves.map((l) => l.id));
  const ancestors = new Map();   // id -> ancestor TreeNode (non-leaf) => bundle.nodes
  const onlineLen = new Map();   // leafId -> resolved chain length
  const reachesRoot = new Map(); // leafId -> chain includes a genuine root (no parentNodeId)
  for (const leaf of leaves) {
    const nodeMap = new Map();
    const chain = await buildUnilateralExitChain(leaf, nodeMap, client, netEnum);
    if (!chain.length) throw new Error(`leaf-vault: could not resolve exit chain for leaf ${leaf.id}; backup NOT captured.`);
    onlineLen.set(leaf.id, chain.length);
    reachesRoot.set(leaf.id, chain.some((n) => !n?.parentNodeId));
    for (const n of nodeMap.values()) if (!leafIds.has(n.id)) ancestors.set(n.id, n);
  }

  const identity = toHexMaybe(await safe(() => wallet.getIdentityPublicKey?.()));
  const balance = await safe(() => wallet.getBalance?.());
  const bundle = {
    schema: BUNDLE_SCHEMA,
    createdAt: new Date().toISOString(),
    network,
    operatorSet,
    ...(identity ? { walletIdentityPublicKey: identity } : {}),
    sparkSdkVersion: sdkVersion(),
    appVersion,
    leaves: leaves.map((l) => ({
      id: l.id,
      ...(l.status != null ? { status: String(l.status) } : {}),
      ...(toSafeSats(l.value) !== undefined ? { valueSats: toSafeSats(l.value) } : {}),
      treeNodeHex: encodeNode(TreeNode, l),
    })),
    ...(ancestors.size ? { nodes: [...ancestors.values()].map((n) => ({ id: n.id, treeNodeHex: encodeNode(TreeNode, n) })) } : {}),
    balances: exportBalances(balance, leaves),
  };

  // --- INTEGRITY GATE (must pass or nothing is written) ---
  const persisted = JSON.parse(JSON.stringify(bundle)); // exactly the bytes that hit disk
  const shape = validateSnapshotShape(persisted);
  if (!shape.ok) throw new Error(`leaf-vault: bundle failed shape validation (${shape.reason}); NOT written.`);

  // Rebuild a combined id->TreeNode map (leaves + ancestor nodes) exactly like
  // Blink's createBundleSparkClient, and prove every leaf reconstructs OFFLINE.
  const reMap = new Map([...persisted.leaves, ...(persisted.nodes ?? [])].map((n) => [n.id, decodeNode(TreeNode, n.treeNodeHex)]));
  for (const leaf of persisted.leaves) {
    const ln = reMap.get(leaf.id);
    // content: the exit consumes nodeTx/refundTx — topology alone is not enough (M-1).
    if (!(ln?.nodeTx?.length > 0) || !(ln?.refundTx?.length > 0)) throw new Error(`leaf-vault: leaf ${leaf.id} missing pre-signed nodeTx/refundTx — not exitable; NOT written.`);
    // completeness: the chain must reach a genuine tree root — guards the bulk-query
    // root-skip that silently produced incomplete bundles in Blink's case study.
    if (!reachesRoot.get(leaf.id)) throw new Error(`leaf-vault: leaf ${leaf.id} exit chain never reaches a tree root — incomplete bundle; NOT written.`);
    const offline = await buildUnilateralExitChain(reMap.get(leaf.id), reMap, undefined, undefined); // NO client
    if (offline.length !== onlineLen.get(leaf.id)) throw new Error(`leaf-vault: leaf ${leaf.id} rebuilds to ${offline.length}/${onlineLen.get(leaf.id)} nodes offline — incomplete; NOT written.`);
  }

  // --- SHRINK GUARD (M-2 generalized: partial getLeaves, not just empty) ---
  // getLeaves(true) can return a NON-EMPTY subset (its coordinator recover path
  // swallows transient failures), and every leaf that IS present passes the gate
  // above — so an unchecked partial capture would atomically overwrite the complete
  // prior bundle with health still green and strand the dropped leaves' only backup.
  // A previously-backed-up leaf may vanish legitimately only if it was SPENT, in
  // which case the wallet balance has fallen below the prior bundle's total. If we
  // cannot positively confirm that, keep the prior bundle and surface it (a thrown
  // snapshot increments the failure count and trips the BROKEN marker if persistent).
  const prior = await readVault(path).catch(() => null);
  if (Array.isArray(prior?.leaves) && prior.leaves.length > 0) {
    const newIds = new Set(persisted.leaves.map((l) => l.id));
    const missing = prior.leaves.filter((l) => !newIds.has(l.id));
    if (missing.length > 0) {
      // A leaf present in the prior bundle is absent here. Legitimate only if every
      // sat the wallet still reports as owned is represented by the leaves we just
      // captured. Compare the CAPTURED total to the reported balance (not the PRIOR
      // total): a send drops one leaf's balance but its change leaf is in the
      // capture, so a complete capture still satisfies captured >= reported — while a
      // send that ALSO transiently loses a different still-live leaf leaves captured
      // < reported and is caught. (priorSats vs reported would wrongly let any spend
      // excuse an arbitrary transient drop.)
      const capturedSats = sumLeafSats(persisted.leaves);
      const reported = await reportedBalanceSats(wallet);
      const coversBalance = capturedSats != null && reported != null && capturedSats >= reported;
      if (!coversBalance) {
        throw new Error(
          `leaf-vault: a leaf present in the prior bundle is missing and the capture holds ` +
          `${capturedSats ?? "an unreadable"} sats vs a reported ${reported ?? "unreadable"} balance ` +
          `— treating as a partial getLeaves; prior bundle KEPT, new bundle NOT written.`,
        );
      }
    }
  }

  await atomicWriteJson(path, persisted);
  return { path, leafCount: persisted.leaves.length, nodeCount: (persisted.nodes ?? []).length, network };
}

// "Can Blink's tool actually recover from this file?" — reload a bundle, validate
// its shape, and rebuild every leaf's chain OFFLINE (no wallet, no operators) to a
// genuine root with its pre-signed txs intact. Run periodically / before trusting.
export async function verifyVault(path = DEFAULT_VAULT_PATH) {
  const TreeNode = await getTreeNode();
  const bundle = await readVault(path);
  const shape = validateSnapshotShape(bundle);
  if (!shape.ok) return { ok: false, reason: shape.reason, leafCount: bundle?.leaves?.length ?? 0 };
  const reMap = new Map([...(bundle.leaves ?? []), ...(bundle.nodes ?? [])].map((n) => [n.id, decodeNode(TreeNode, n.treeNodeHex)]));
  const failed = [];
  for (const leaf of bundle.leaves) {
    const ln = reMap.get(leaf.id);
    const chain = await buildUnilateralExitChain(ln, reMap, undefined, undefined);
    const complete = chain.length && chain.some((n) => !n?.parentNodeId);
    if (!complete || !(ln?.nodeTx?.length > 0) || !(ln?.refundTx?.length > 0)) failed.push(leaf.id);
  }
  return {
    ok: failed.length === 0,
    reason: failed.length ? `${failed.length} leaf/leaves do not reconstruct offline to a root (or lack pre-signed txs)` : "all leaves reconstruct offline to a root",
    leafCount: bundle.leaves.length,
    failed,
    createdAt: bundle.createdAt,
    network: bundle.network,
  };
}

// A conspicuous on-disk signal that the backup is failing, so a broken bundle is
// not merely a single unread stderr line (H-2). Written next to the bundle.
async function writeBrokenMarker(markerPath, err, failures) {
  const body =
    `leaf-vault backup is BROKEN as of ${new Date().toISOString()}\n` +
    `consecutive failures: ${failures}\n` +
    `last error: ${err?.message ?? err}\n\n` +
    `Unilateral exit may be IMPOSSIBLE until this is resolved. The wallet still works,\n` +
    `but the operatorless-recovery bundle is NOT being written. See references/unilateral-exit.md.\n`;
  await mkdir(dirname(markerPath), { recursive: true, mode: 0o700 }).catch(() => {});
  const fh = await open(markerPath, "w", 0o600);
  try { await fh.writeFile(body); } finally { await fh.close(); }
}

// Keep the bundle current. Snapshots at boot, on every leaf-changing event
// (`balance:update`, `transfer:claimed`, `deposit:confirmed`), and on a
// low-frequency safety-net timer (catches timelock refreshes). Overlapping
// triggers are single-flighted so concurrent writes can't race; a burst of events
// is also debounced. Returns `{ dispose, ready, health }` — `ready` resolves to
// `{ ok, error? }` for the boot snapshot so a caller can surface a broken backup.
export function enableLeafVault(wallet, { path = DEFAULT_VAULT_PATH, networkLabel, intervalMs = 20 * 60_000, debounceMs = 4000, maxConsecutiveFailures = 3, onError } = {}) {
  debounceMs = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : 4000;
  intervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 20 * 60_000;

  const brokenMarker = join(dirname(path), "BROKEN");
  let consecutiveFailures = 0;
  let lastSuccessAt = null;
  let lastError = null;
  let inFlight = null;
  let disposed = false;
  // Track uncaptured leaf changes so a short-lived process (init -> transact ->
  // cleanup) still flushes a fresh bundle on the way out, WITHOUT a read-only run
  // paying for a redundant snapshot. A generation counter (not a boolean) so an
  // event that fires *during* a snapshot correctly leaves the vault dirty.
  let changeGen = 0;   // bumped on each leaf-changing wallet event
  let snappedGen = 0;  // highest changeGen a successful snapshot has captured
  const isDirty = () => changeGen > snappedGen;

  const report = (e) => (onError ? onError(e) : console.error(`[leaf-vault] snapshot FAILED (${consecutiveFailures}x in a row): ${e?.message ?? e}`));

  const runSnapshot = () => {
    if (disposed) return Promise.resolve(null);
    if (inFlight) return inFlight;
    const gen = changeGen; // the change-generation this run will capture
    inFlight = (async () => {
      try {
        const r = await snapshotLeafVault(wallet, { path, networkLabel });
        // Only mark the change captured when the snapshot actually PERSISTED. The
        // skip paths (transient-empty / no-leaves) resolve without writing, so
        // advancing snappedGen there would falsely clear isDirty() and let dispose
        // drop the flush — leaving a real leaf change unbacked. A skip stays dirty.
        if (!r?.skipped && gen > snappedGen) snappedGen = gen; // events during a real run keep isDirty() true
        consecutiveFailures = 0; lastSuccessAt = Date.now(); lastError = null;
        await unlink(brokenMarker).catch(() => {});
        return r;
      } catch (e) {
        consecutiveFailures++; lastError = e;
        report(e);
        const fatal = /SDK internals moved|cannot load the SDK TreeNode/i.test(String(e?.message));
        if (fatal || consecutiveFailures >= maxConsecutiveFailures) await writeBrokenMarker(brokenMarker, e, consecutiveFailures).catch(() => {});
        throw e;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  let debounceTimer = null;
  const schedule = () => {
    changeGen += 1; // a leaf-changing event happened; mark the vault dirty
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => { debounceTimer = null; runSnapshot().catch(() => {}); }, debounceMs);
    debounceTimer.unref?.();
  };

  const ready = runSnapshot().then(() => ({ ok: true }), (e) => ({ ok: false, error: e?.message ?? String(e) }));

  const events = ["balance:update", "transfer:claimed", "deposit:confirmed"];
  for (const ev of events) wallet.on?.(ev, schedule);
  const timer = setInterval(() => runSnapshot().catch(() => {}), intervalMs);
  timer.unref?.();

  const dispose = async () => {
    for (const ev of events) wallet.off?.(ev, schedule);
    clearInterval(timer);
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    await inFlight?.catch(() => {});
    // Flush a final snapshot ONLY if a leaf change happened that no snapshot has
    // captured yet — closes the "init -> transfer -> cleanup exits before the 4s
    // debounce fires" gap without making a read-only run snapshot on exit. Runs
    // before `disposed` is set so this flush is allowed; best-effort, since a
    // failure is already surfaced via the failure counter / BROKEN marker.
    if (isDirty()) await runSnapshot().catch(() => {});
    disposed = true;
  };

  return {
    dispose,
    ready,
    health: () => ({ healthy: consecutiveFailures === 0 && lastSuccessAt != null, lastSuccessAt, consecutiveFailures, lastError: lastError?.message ?? null }),
  };
}

// CLI: `node leaf-vault.js verify` checks the current bundle; no arg takes a
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
