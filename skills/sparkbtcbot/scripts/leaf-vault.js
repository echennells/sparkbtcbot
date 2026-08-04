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
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { open, mkdir, unlink } from "node:fs/promises";
import { atomicWriteJson, readVault, validateSnapshotShape, isNonEmptyStr, BUNDLE_SCHEMA, RECOVERABLE_NETWORKS } from "../../../lib/leaf-vault.js";

// TreeNode protobuf codec (+ the proto Network enum's name mapping) — loaded
// LAZILY from the SDK's own exports subpath (`@buildonspark/spark-sdk/proto/spark`).
// Lazy so a codec-resolution failure disables only the vault, NOT the whole agent
// (this module is statically imported by spark-agent.js).
let _proto = null;
async function getProto() {
  if (_proto) return _proto;
  try {
    const { TreeNode, networkToJSON } = await import("@buildonspark/spark-sdk/proto/spark");
    _proto = { TreeNode, networkToJSON };
  } catch (e) {
    const err = new Error(`leaf-vault: cannot load the SDK TreeNode codec (@buildonspark/spark-sdk/proto/spark): ${e?.message ?? e}. Backup NOT captured.`);
    err.code = "LEAF_VAULT_FATAL"; // reach-in breakage, not a transient — see runSnapshot
    throw err;
  }
  return _proto;
}
const encodeNode = (TreeNode, node) => Buffer.from(TreeNode.encode(TreeNode.fromPartial(node)).finish()).toString("hex");
const decodeNode = (TreeNode, hex) => TreeNode.decode(Buffer.from(hex, "hex"));

// Read the env override at CALL time, not module load: the CLI (and any host
// that loads .env after importing this module) must see the .env value, and a
// module-scope const would freeze the pre-dotenv environment.
export const defaultVaultPath = () =>
  process.env.SPARK_LEAF_VAULT_PATH || join(homedir(), ".spark", "leaf-vault", "current.json");

// The network labels Blink's recovery tool accepts (its normalizeNetwork throws
// on anything else) — a bundle carrying any other label verifies green locally
// but is refused at recovery time, so we refuse to write one.
// Single source of truth in lib (the Blink-compat contract); alias for local use.
const KNOWN_NETWORKS = RECOVERABLE_NETWORKS;
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
// The wallet's OWNED sats from a getBalance() result. Owned FIRST: the SDK's
// top-level `balance` is a deprecated alias for AVAILABLE, and owned includes
// leaves locked in in-flight transfers/swaps — still exitable, still needing a
// backup. This ordering IS the "judge owned, not available" semantics every
// guard and the CLI rely on; it lives in exactly one place so it cannot drift.
const ownedSats = (b) => b?.satsBalance?.owned ?? b?.balance ?? b?.satsBalance?.available ?? null;

function exportBalances(balance, leaves) {
  const btc = ownedSats(balance);
  let btcSats;
  try { btcSats = btc != null ? String(BigInt(btc)) : String(leaves.reduce((s, l) => s + BigInt(l.value ?? 0), 0n)); } catch { btcSats = undefined; }
  return { ...(btcSats != null ? { btcSats } : {}), usdb: { amount: "unknown", status: "not-covered-by-bitcoin-unilateral-exit" } };
}

// The wallet's reported owned sats as a BigInt, or null when unreadable. Used by
// the empty- and shrink-guards to distinguish a real balance change from a
// transient/partial getLeaves, and by the CLI to judge a missing vault's
// severity. Unreadable is deliberately null (caller treats it conservatively)
// rather than 0.
export async function reportedBalanceSats(wallet) {
  try {
    const v = ownedSats(await wallet.getBalance?.());
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
    const err = new Error(
      `leaf-vault: SDK internals moved — cannot reach [${missing.join(", ")}]. Backup NOT captured. ` +
      `Re-verify the reach-in against the resolved @buildonspark/spark-sdk version before relying on ` +
      `unilateral-exit recovery.`,
    );
    err.code = "LEAF_VAULT_FATAL"; // reach-in breakage — enableLeafVault marks BROKEN on the first hit
    throw err;
  }
}

// Decode a bundle's leaves+nodes and prove each leaf reconstructs OFFLINE (no
// client, no operators): per leaf — its pre-signed txs are present, and its
// leaf→root chain rebuilds from the bundle's own nodes. This is the single
// statement of "what proves a bundle can recover funds", consumed by both the
// snapshot integrity gate and verifyVault so the two cannot drift.
async function proveOffline(TreeNode, leaves, nodes) {
  const reMap = new Map([...leaves, ...(nodes ?? [])].map((n) => [n.id, decodeNode(TreeNode, n.treeNodeHex)]));
  const proofs = new Map();
  for (const leaf of leaves) {
    const ln = reMap.get(leaf.id);
    const chain = await buildUnilateralExitChain(ln, reMap, undefined, undefined); // NO client
    proofs.set(leaf.id, {
      hasTxs: ln?.nodeTx?.length > 0 && ln?.refundTx?.length > 0,
      chainLen: chain.length,
      reachesRoot: chain.some((n) => !n?.parentNodeId),
    });
  }
  return proofs;
}

// Take an online snapshot into a Blink `spark.unilateral-exit-bundle.v1` bundle:
// resolve every leaf's leaf->root exit chain (the client fills ancestors), split
// into leaves + ancestor nodes, then run the INTEGRITY GATE — the leaf carries its
// pre-signed txs, the chain reaches a genuine root, and every leaf reconstructs
// OFFLINE — and only then persist atomically. Writes nothing on any failure.
export async function snapshotLeafVault(wallet, { path = defaultVaultPath(), networkLabel } = {}) {
  const { TreeNode, networkToJSON } = await getProto();
  assertLeafInternalsIntact(wallet, TreeNode);

  const leaves = await wallet.leafManager.getLeaves(true);

  if (leaves.length === 0) {
    // The bundle schema requires >=1 leaf; a genuinely empty wallet has nothing
    // to exit. But empty getLeaves is a TRANSIENT capture failure on a FUNDED
    // wallet (the coordinator recover path swallows errors) — so "empty" only
    // means "confirmed empty" when the wallet ALSO reports zero balance. This
    // balance check must run whether or not a prior bundle exists: on first boot
    // or a lost/corrupt vault there is no prior, and gating the check on a prior
    // let a funded wallet be scored "confirmed empty" — clearing BROKEN and going
    // health-green with NO bundle written (F1). null/unreadable balance is treated
    // as non-zero, i.e. fail safe toward "keep protecting".
    const sats = await reportedBalanceSats(wallet); // null when unreadable → treat as non-zero
    if (sats == null || sats > 0n) {
      const prior = await readVault(path).catch(() => null);
      const leafCount = Array.isArray(prior?.leaves) ? prior.leaves.length : 0;
      return { path, leafCount, skipped: "transient-empty-getLeaves" }; // funded but no leaves captured — NOT a success
    }
    // Confirmed-empty (balance is zero): a complete, healthy backup state — nothing
    // to exit, so a leftover BROKEN marker (e.g. from before the wallet was emptied)
    // is noise.
    await unlink(join(dirname(path), "BROKEN")).catch(() => {});
    return { path, leafCount: 0, skipped: "no-leaves" }; // nothing to back up; any prior bundle is left in place
  }

  // A wallet leaf's `network` is a NUMERIC proto enum at runtime — String() of it
  // ("1") would pass every shape check yet be refused by Blink's recovery tool.
  // Derive the label through the proto codec, and refuse to persist any label
  // outside the set that tool accepts (fail loud, like the reach-in checks).
  let derived = leaves[0]?.network;
  if (typeof derived === "number") {
    try { derived = networkToJSON(derived); } catch { /* leave as-is; the gate below fails loud */ }
  }
  const network = normalizeNetwork(networkLabel ?? derived ?? "MAINNET");
  if (!KNOWN_NETWORKS.includes(network)) {
    throw new Error(`leaf-vault: network "${network}" is not one of ${KNOWN_NETWORKS.join("/")} — Blink's recovery CLI would refuse this bundle; NOT written.`);
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
    operatorSet: "spark-sdk",
    ...(identity ? { walletIdentityPublicKey: identity } : {}),
    sparkSdkVersion: sdkVersion(),
    appVersion: APP_VERSION,
    leaves: leaves.map((l) => {
      const valueSats = toSafeSats(l.value);
      return {
        id: l.id,
        ...(l.status != null ? { status: String(l.status) } : {}),
        ...(valueSats !== undefined ? { valueSats } : {}),
        treeNodeHex: encodeNode(TreeNode, l),
      };
    }),
    ...(ancestors.size ? { nodes: [...ancestors.values()].map((n) => ({ id: n.id, treeNodeHex: encodeNode(TreeNode, n) })) } : {}),
    balances: exportBalances(balance, leaves),
  };

  // --- INTEGRITY GATE (must pass or nothing is written) ---
  const persisted = JSON.parse(JSON.stringify(bundle)); // exactly the value that hits disk
  const shape = validateSnapshotShape(persisted);
  if (!shape.ok) throw new Error(`leaf-vault: bundle failed shape validation (${shape.reason}); NOT written.`);

  // Prove every leaf reconstructs OFFLINE from the bundle's own bytes, exactly
  // like Blink's createBundleSparkClient would serve them.
  const proofs = await proveOffline(TreeNode, persisted.leaves, persisted.nodes);
  for (const leaf of persisted.leaves) {
    const p = proofs.get(leaf.id);
    // content: the exit consumes nodeTx/refundTx — topology alone is not enough (M-1).
    if (!p.hasTxs) throw new Error(`leaf-vault: leaf ${leaf.id} missing pre-signed nodeTx/refundTx — not exitable; NOT written.`);
    // completeness: the chain must reach a genuine tree root — guards the bulk-query
    // root-skip that silently produced incomplete bundles in Blink's case study.
    if (!reachesRoot.get(leaf.id)) throw new Error(`leaf-vault: leaf ${leaf.id} exit chain never reaches a tree root — incomplete bundle; NOT written.`);
    if (p.chainLen !== onlineLen.get(leaf.id)) throw new Error(`leaf-vault: leaf ${leaf.id} rebuilds to ${p.chainLen}/${onlineLen.get(leaf.id)} nodes offline — incomplete; NOT written.`);
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
    // IDENTITY GUARD: the vault path is shared machine-wide by default, so a
    // second wallet or a network flip (.env SPARK_NETWORK) must never replace a
    // different wallet's only recovery bundle — the shrink guard below cannot see
    // that case (the new capture trivially covers its own wallet's balance). Both
    // checks require both sides present, so an unreadable identity or a
    // pre-identity bundle is never a false positive.
    if (isNonEmptyStr(prior.network) && normalizeNetwork(prior.network) !== network) {
      throw new Error(
        `leaf-vault: prior bundle at ${path} is for network ${prior.network}, this wallet is ${network} ` +
        `— refusing to overwrite a different wallet's recovery bundle; prior bundle KEPT. ` +
        `Set SPARK_LEAF_VAULT_PATH to a distinct path per wallet/network.`,
      );
    }
    if (isNonEmptyStr(prior.walletIdentityPublicKey) && isNonEmptyStr(identity) &&
        prior.walletIdentityPublicKey.toLowerCase() !== identity.toLowerCase()) {
      throw new Error(
        `leaf-vault: prior bundle at ${path} belongs to a different wallet identity ` +
        `— refusing to overwrite its only recovery bundle; prior bundle KEPT. ` +
        `Set SPARK_LEAF_VAULT_PATH to a distinct path per wallet.`,
      );
    }

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
        // RESCUE before failing: the fresh capture may hold leaves (a new deposit,
        // a claimed transfer) that exist NOWHERE else — discarding it with the
        // throw would leave them unbacked for as long as the guard keeps tripping.
        // Write a UNION bundle (fresh capture + the prior leaves it is missing,
        // fresh bytes winning per node id) — but only if the union passes the same
        // offline proof as any other bundle, so "a written bundle is an exitable
        // one" stays true. Then STILL throw: the failure counter, BROKEN marker,
        // and health semantics are unchanged. Caveat: the union may re-persist a
        // genuinely spent leaf (indistinguishable from a transiently missing one);
        // that is harmless to the Blink contract and self-heals on the next clean
        // snapshot.
        let rescued = false;
        try {
          const nodeById = new Map();
          for (const n of prior.nodes ?? []) nodeById.set(n.id, n);
          for (const n of persisted.nodes ?? []) nodeById.set(n.id, n); // fresh bytes win
          const union = {
            ...persisted,
            leaves: [...persisted.leaves, ...missing],
            ...(nodeById.size ? { nodes: [...nodeById.values()] } : {}),
          };
          if (validateSnapshotShape(union).ok) {
            const unionProofs = await proveOffline(TreeNode, union.leaves, union.nodes);
            const allProven = union.leaves.every((l) => {
              const p = unionProofs.get(l.id);
              if (!p?.hasTxs || !p.reachesRoot || !p.chainLen) return false;
              const online = onlineLen.get(l.id); // undefined for carried-over prior leaves
              return online === undefined || p.chainLen === online;
            });
            if (allProven) {
              await atomicWriteJson(path, union);
              rescued = true;
            }
          }
        } catch { /* best-effort; the guard error below still fires */ }
        throw new Error(
          `leaf-vault: a leaf present in the prior bundle is missing and the capture holds ` +
          `${capturedSats ?? "an unreadable"} sats vs a reported ${reported ?? "unreadable"} balance ` +
          `— treating as a partial getLeaves; new bundle NOT written.` +
          (rescued
            ? ` A UNION bundle (fresh capture + carried-over prior leaves ${missing.map((l) => l.id).join(", ")}) ` +
              `was written so the new leaves have exit material until a clean snapshot lands.`
            : ` Prior bundle KEPT.`),
        );
      }
    }
  }

  await atomicWriteJson(path, persisted);
  // A freshly persisted, gate-proven bundle supersedes any BROKEN state — this is
  // the ONLY place the marker is cleared for a funded wallet, so a skip or a
  // manual CLI run can never clear it without actually writing a bundle.
  await unlink(join(dirname(path), "BROKEN")).catch(() => {});
  return { path, leafCount: persisted.leaves.length, nodeCount: (persisted.nodes ?? []).length, network };
}

// Severity of "no vault on disk" given the wallet's OWNED sats (null =
// unreadable). This is the monitoring contract behind the CLI's exit codes:
// 0 = nothing to back up, 1 = funded with NO exit backup (alarm), 2 = cannot
// judge (treat as critical if the wallet is known to be funded).
export function judgeMissingVault(sats) {
  if (sats == null) return { level: "INDETERMINATE", exitCode: 2 };
  if (sats > 0n) return { level: "CRITICAL", exitCode: 1 };
  return { level: "OK", exitCode: 0 };
}

// "Can Blink's tool actually recover from this file?" — reload a bundle, validate
// its shape, and rebuild every leaf's chain OFFLINE (no wallet, no operators) to a
// genuine root with its pre-signed txs intact. Run periodically / before trusting.
export async function verifyVault(path = defaultVaultPath()) {
  const { TreeNode } = await getProto();
  let bundle;
  try {
    bundle = await readVault(path);
  } catch (err) {
    // "No vault on disk" is a distinct state from "vault is broken", and only the
    // caller knows which one is alarming: a wallet with no leaves has nothing to
    // back up, while a funded wallet with no vault has lost its only unilateral-exit
    // path. Report it as data instead of throwing a raw ENOENT so callers can decide.
    if (err?.code === "ENOENT") return { ok: false, missing: true, reason: `no vault at ${path}`, leafCount: 0, path };
    throw err;
  }
  const shape = validateSnapshotShape(bundle);
  if (!shape.ok) return { ok: false, reason: shape.reason, leafCount: bundle?.leaves?.length ?? 0 };
  const proofs = await proveOffline(TreeNode, bundle.leaves, bundle.nodes);
  const failed = bundle.leaves
    .filter((l) => { const p = proofs.get(l.id); return !p.chainLen || !p.reachesRoot || !p.hasTxs; })
    .map((l) => l.id);
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
export function enableLeafVault(wallet, { path = defaultVaultPath(), networkLabel, intervalMs = 20 * 60_000, debounceMs = 4000, maxConsecutiveFailures = 3, onError } = {}) {
  debounceMs = Number.isFinite(debounceMs) && debounceMs >= 0 ? debounceMs : 4000;
  intervalMs = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 20 * 60_000;

  const brokenMarker = join(dirname(path), "BROKEN");
  let consecutiveFailures = 0;
  let consecutiveTransientSkips = 0;
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
    let persistedRun = false;
    inFlight = (async () => {
      try {
        const r = await snapshotLeafVault(wallet, { path, networkLabel });
        consecutiveFailures = 0; lastError = null;
        if (!r?.skipped) {
          // Only mark the change captured when the snapshot actually PERSISTED —
          // advancing snappedGen on a skip would falsely clear isDirty() and let
          // dispose drop the flush, leaving a real leaf change unbacked.
          if (gen > snappedGen) snappedGen = gen; // events during a real run keep isDirty() true
          persistedRun = true;
          consecutiveTransientSkips = 0;
          lastSuccessAt = Date.now();
        } else if (r.skipped === "transient-empty-getLeaves") {
          // Nothing persisted while the wallet still reports funds: the prior
          // bundle is aging. One is noise; a chronic streak means the capture
          // path is broken with no throw to trip the failure counter (H-2), so
          // surface it the same way persistent failures are surfaced.
          consecutiveTransientSkips++;
          if (consecutiveTransientSkips >= maxConsecutiveFailures) {
            const e = new Error(
              `leaf-vault: getLeaves returned empty ${consecutiveTransientSkips}x in a row while the ` +
              `wallet reports a positive balance — the prior bundle is KEPT but going stale.`,
            );
            lastError = e;
            report(e);
            await writeBrokenMarker(brokenMarker, e, consecutiveTransientSkips).catch(() => {});
          }
        } else {
          // "no-leaves": a confirmed-empty wallet is a complete, healthy backup
          // state — nothing to protect, nothing stale.
          consecutiveTransientSkips = 0;
          lastSuccessAt = Date.now();
        }
        return r;
      } catch (e) {
        consecutiveFailures++; lastError = e;
        report(e);
        const fatal = e?.code === "LEAF_VAULT_FATAL"; // reach-in breakage: don't wait out the threshold
        if (fatal || consecutiveFailures >= maxConsecutiveFailures) await writeBrokenMarker(brokenMarker, e, consecutiveFailures).catch(() => {});
        throw e;
      } finally {
        inFlight = null;
        // An event that fired DURING this run was absorbed by single-flight and
        // its debounce already consumed — without this re-arm its change would
        // wait for the next event or the 20-min interval (or be lost to a crash).
        // Only after a PERSISTED run: re-arming after a failure or skip would
        // retry-loop every debounceMs against whatever is wrong.
        if (persistedRun && !disposed && isDirty() && !debounceTimer) {
          debounceTimer = setTimeout(() => { debounceTimer = null; runSnapshot().catch(() => {}); }, debounceMs);
          debounceTimer.unref?.();
        }
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
    // The awaited run's finally may have re-armed the debounce; clear it again —
    // the flush below covers any remaining dirtiness.
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
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
    health: () => ({
      healthy: consecutiveFailures === 0 && lastSuccessAt != null && consecutiveTransientSkips < maxConsecutiveFailures,
      lastSuccessAt,
      consecutiveFailures,
      consecutiveTransientSkips,
      lastError: lastError?.message ?? null,
    }),
  };
}

