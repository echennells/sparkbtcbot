# Unilateral Exit & Leaf-Vault — Implementation Report

**Status:** Design / spec for implementation
**Target skill:** `sparkbtcbot`
**SDK audited:** `@buildonspark/spark-sdk@0.8.8` (skill pins `^0.8.1`; re-verify line refs against the resolved version)
**Branch:** `claude/spark-unilateral-exit-mobile-o13oyq`

---

## 1. Why this exists

A public exchange (Francis Pouliot / Roy@Breez / grubles, Jul 2 2026) surfaced a real gap in Spark's
self-custody story: **you cannot unilaterally exit from a bare mnemonic.** grubles demonstrated that a
*funded* mnemonic imported into `spark-cli` shows **no leaves to exit**, and Roy (Breez) confirmed the
mechanism: *"It relies on at least one of the operators being online."*

Unlike on-chain Bitcoin (seed = money), a Spark unilateral exit requires the tree of **pre-signed
branch + leaf-refund transactions** ("leaf material"). That material is **not derivable from the seed** —
it is handed to your wallet by the operators at transfer/claim time and held in wallet state. If you have
a fresh install (no local copy) and operators are offline/censoring, you have nothing to broadcast.

The skill currently overstates the guarantee (see §8). This report specifies a **leaf-vault**: a
continuously-maintained local mirror of exit material that makes an operatorless exit actually possible.

---

## 2. TL;DR for the team

1. The JS SDK **already ships the operatorless-exit primitives** — they are publicly exported. We do **not**
   need the Rust CLI and do **not** need any JS→Rust state bridge.
2. The SDK does **not** ship persistence or a one-call exit. We build two things:
   - **Leaf-vault** — persist a fully-resolved snapshot of exit material on every balance change.
   - **Offline-exit script** — rebuild from disk, fee-bump with an external UTXO, broadcast.
3. The correct persistence trigger is the **`balance:update`** event, **not** wrapping our own
   send/receive calls (background auto-claim + auto-optimize change leaf state with no user action).
4. Hard external requirement: the wallet must hold an **on-chain fee UTXO outside Spark** to pay exit fees.
   An agent holding only Spark funds cannot exit.
5. A stale snapshot yields **partial** recovery (untouched leaves only) — and the boundary is *not*
   "everything but the latest" (see §7).

---

## 3. How Spark unilateral exit works (background)

Funds live in a hierarchical tree of Bitcoin transactions: an L1 root UTXO → branch node txs → a leaf
node tx → a **timelocked refund tx** that pays the current owner. Exit = broadcast the node txs down to
your leaf, wait the leaf's **CSV relative timelock**, then broadcast the refund tx.

- On every transfer/claim, the tree branch is **re-signed with a decremented timelock** for the new owner.
  This is the security mechanism: the *current* owner always has a shorter timelock and can exit *before*
  a prior owner. (This is the "prior-owner race" already noted in `SKILL.md:102`.)
- Exit is **multi-transaction** (depth-dependent), each paying L1 fees at the mempool rate of the day.
- The leaf txs cannot pay their own fees; a unilateral exit uses **CPFP** from an external fee UTXO.

Reference (Breez `spark-cli`) for the canonical manual flow:
```
leaves list --compact
withdraw unilateral-exit <fee_rate> --leaf <leaf_id> --utxo <txid:vout:value_sats:pubkey_hex>
# broadcast parent node txs -> leaf tx -> WAIT CSV timelock -> refund tx
```
Breez README, verbatim: *"if you don't keep your leaves synced, you need to rely on at least one operator
for fetching the leaves information before you can unilaterally exit."* → **synced local leaves = self-sufficient.**

---

## 4. SDK capability audit (`@buildonspark/spark-sdk@0.8.8`)

### 4.1 Exit primitives — present and publicly exported

Exported from both `dist/index.node.d.ts` and `dist/index.browser.d.ts`:

| Symbol | Location | Role |
|---|---|---|
| `buildUnilateralExitChain(node, nodeMap, sparkClient?, network)` | `src/utils/unilateral-exit.ts:103` | Walks a leaf → root, returns the ordered `TreeNode[]` exit chain. **`sparkClient` is optional** — operators are contacted **only** as a fallback when a parent is missing from `nodeMap` (`if (!parentNode && sparkClient)`). Full local `nodeMap` ⇒ zero operator contact. |
| `constructUnilateralExitFeeBumpPackages(nodeHexStrings, utxos, …)` | `src/utils/unilateral-exit.ts:198` | Builds CPFP fee-bump packages from node tx hex + external UTXOs. Pure/local. |
| `constructFeeBumpTx(...)` | `src/utils/unilateral-exit.ts:527` | Builds the child fee-bump tx. |
| `isEphemeralAnchorOutput(...)` | `src/utils/unilateral-exit.ts:168` | Detects the anchor output the CPFP child spends. |
| `doesLeafNeedRefresh`, `doesTxnNeedRenewed`, `getCurrentTimelock` | exported utils | Timelock/refresh detection. |
| Types: `LeafInfo`, `TxChain`, `FeeBumpTxChain`, `FeeBumpTxPackage`, `Utxo`, `FeeRate` | exported | Data shapes for the above. |

**Consequence:** operatorless exit is a first-class, supported code path in JS *if you supply a complete
local `nodeMap`.* That is exactly what the leaf-vault provides.

### 4.2 Leaf getter — present

- `getLeaves(isBalanceCheck?: boolean): Promise<TreeNode[]>` — returns the current leaf `TreeNode`s
  (each carries its tx data and `parentNodeId`). This is an **online** call (syncs from operators).
  *(Confirm the exact class/instance path in the resolved SDK during implementation.)*

### 4.3 What is NOT in the SDK

- **No persistence.** Grep for `writeFile`/`localStorage`/leaf-store found nothing. Leaves are held in
  memory, populated from operators during sync. **Persisting is our job.**
- **No one-call unilateral exit.** The wallet's high-level exit method is `coopExit` (cooperative). There
  is no `wallet.unilateralExit()`; we assemble it from §4.1.

### 4.4 Events (the trigger surface)

`SparkWalletEvent` (`src/spark-wallet/types.ts:197`):

| Event | String | Notes |
|---|---|---|
| `BalanceUpdate` | `balance:update` | **Doc: "Emitted whenever the balance changes (deposits, transfers, swaps, claims)."** (`types.ts:216`) — the superset we want. |
| `TransferClaimed` | `transfer:claimed` | Incoming transfer finalized. |
| `DepositConfirmed` | `deposit:confirmed` | L1 deposit available. |
| `Stream*` | `stream:*` | Connection lifecycle. |

### 4.5 State changes happen WITHOUT user action (why the trigger matters)

- **Auto-claim:** `claimTransfersInterval` (`spark-wallet.ts:226`) plus stream-handler claims
  (`:558`, `:796`) finalize incoming transfers on a background timer. A "claim" is the receiver-side
  finalization that makes leaves yours and mints your own refund txs (`claimTransfer` → `:3306`).
- **Auto-optimize:** after a claim, the LeafManager callback runs `optimizeLeaves()`
  (`spark-wallet.ts:320`; public at `:920`), which **consumes existing leaves** to re-denominate.
- **Optimizer marks old leaves SPENT:** `src/services/leaf-manager.ts:951` — the swap/optimization path
  *"transitions them to SPENT"*; `selectLeavesWithSwap(targetAmounts)` (`:449`) consumes current leaves
  and mints replacements via `SwapService` (`src/services/swap.ts`).

> **Design implication:** because claims and optimizations mutate leaf state on their own schedule, hooking
> our own `send()`/`receive()` calls is insufficient. Subscribe to `balance:update`.

---

## 5. Design — the leaf-vault

### 5.1 The snapshot artifact

For **every** current leaf, persist the **fully-resolved** chain leaf → root: each node's raw tx hex,
plus enough metadata to rebuild the `nodeMap` and to know the CSV timelock per leaf. One file, latest-only.

Suggested path: `~/.spark/leaf-vault/current.json` (respect `SPARK_SEED_PATH`-style overrides; mode `0600`).

### 5.2 The online snapshot trick (resolve now, so exit is offline)

At snapshot time we are online, so call `buildUnilateralExitChain` **with** the live `sparkClient`. Its
fallback fetches every missing parent via `query_nodes` and fills the `nodeMap`. Persist the resulting
**complete** chain. Then at exit time the `nodeMap` is already whole and the client is never needed.

```js
async #snapshotLeafVault() {
  const leaves = await this.#wallet.getLeaves();
  const nodeMap = new Map();
  const chains = [];
  for (const leaf of leaves) {
    const chain = await buildUnilateralExitChain(leaf, nodeMap, this.#sparkClient); // online: fills parents
    chains.push({
      leafId: leaf.id,
      value: leaf.value?.toString?.() ?? null,
      nodesHex: chain.map(n => n.rawTxHex),   // confirm field name in resolved SDK
      // TODO: capture per-leaf CSV timelock for the offline wait
    });
  }
  await atomicWriteJson(vaultPath, { version: 1, network, updatedAt: <injected>, chains });
}
```

### 5.3 Persistence rules (correctness-critical)

- **Trigger:** `wallet.on('balance:update', () => void this.#snapshotLeafVault())`, plus **one snapshot at
  boot after first sync**, plus a **low-frequency timer** as a safety net for any missed event.
- **Atomic:** write to a temp file then `rename()` — a half-written vault is the only thing between the
  agent and its money.
- **Latest-only / supersede:** do **not** keep old snapshots as "fallback." Stale entries for changed
  leaves are invalid or lose the timelock race (see §7). Keep exactly one current file.
- **Synchronous-ish:** treat "vault write succeeded" as part of "operation done" to minimize the window
  between an operator-side change and the local mirror catching up.

### 5.4 Integration seam (already exists)

`SparkAgent` already wires wallet events in the same shape we need
(`skills/sparkbtcbot/scripts/spark-agent.js:274` `onTransferClaimed`, `:278` `onDepositConfirmed`,
`:284` `cleanupConnections`). Add an **opt-in** `enableLeafVault()` that registers the `balance:update`
listener and does the boot snapshot. No new runtime model — the skill already holds a long-lived wallet
(`SKILL.md:213`).

### 5.5 Offline exit flow (operators dark)

`scripts/unilateral-exit.js`:
1. Load `current.json`; rebuild `nodeMap`.
2. For each leaf: `buildUnilateralExitChain(leaf, nodeMap)` **without** a client.
3. `constructUnilateralExitFeeBumpPackages(nodesHex, [externalUtxo])`.
4. Broadcast in order: parent node txs → leaf tx → **wait CSV timelock** → refund tx.
5. Watchtower the timelock window (prior-owner race, `SKILL.md:102`).

---

## 6. Hard requirements & preconditions

| Requirement | Why | Notes |
|---|---|---|
| **External on-chain fee UTXO** (outside Spark) | Leaf txs can't self-fund; exit uses CPFP | Format `txid:vout:value_sats:pubkey_hex`; confirmed; signable single-key (P2WPKH/P2TR); **sized for a worst-case multi-tx, high-fee exit**. Operational rule: *never let the external L1 balance hit zero.* Selected at exit time, not pre-registered. |
| **Independent L1 broadcaster** | Can't rely on operator infra during an outage | Own node or a broadcast API. |
| **Persistent process** | `balance:update` only fires while alive | Boot snapshot covers gaps; see §9. |
| **Watchtower / timelock monitoring** | Prior-owner race + CSV wait | Already an acknowledged operational dependency (`SKILL.md:113`). |
| **Re-sync after every change** | Timelocks decrement; optimizer restructures | The whole point of the `balance:update` trigger. |

---

## 7. Staleness semantics — what a not-current vault recovers

Leaves are independent for exit (each chain is self-contained), so a stale vault is a **partial** safety
net — **but the boundary is NOT "everything except the latest deposit."** The background optimizer
*consumes existing leaves* (marks them SPENT, `leaf-manager.ts:951`), so a change after the snapshot can
invalidate **old** funds too.

| Leaf's fate since snapshot | Recoverable from stale vault? |
|---|---|
| Untouched (sat still) | ✅ Fully |
| Received after snapshot | ❌ Not in file |
| Consumed by an auto-optimize swap | ❌ Marked SPENT / superseded — even if the value was "old" |
| Transferred away | ❌ Not yours; losing timelock race if attempted |
| Timelock-refreshed, still yours | ⚠️ Gray area — treat as not-reliable |

**Why a stale entry is worse than useless:** once a leaf is SPENT cooperatively, operators re-spent the
parent output the old leaf tx consumes → broadcasting it is an invalid double-spend, or (where the tree
allows) the decremented-timelock race the current owner is designed to win.

**Honest framing for docs/UX:** *"You recover whatever hasn't moved since your last snapshot — and the
optimizer moves things on its own, so keep snapshots current."* Snapshot **frequency** directly shrinks
the "moved-since" set you'd forfeit. Quiet wallet → lose ~nothing; busy auto-optimizing agent → can lose
a lot.

---

## 8. Skill documentation corrections (separate from code)

These claims are currently overstated and should be tightened in the same PR:

1. `references/architecture.md:10` — *"Users can always exit to L1 unilaterally if operators go offline."*
   Inverts reality: operators-offline + not-synced is exactly the failure case. Condition it on holding
   leaf material.
2. `SKILL.md:106` — *"Spark guarantees you can always exit to L1"* — condition on synced leaf material +
   external fee UTXO.
3. `SKILL.md:227–231` — *"the mnemonic is the entire backup"* / *"losing the local data directory loses
   nothing"* / *"unilateral exit is the fallback if recovery is censored."* Self-contradicting: unilateral
   exit needs the **same** leaf state recovery would fetch. Correct to: *losing the data dir loses nothing
   **as long as ≥1 operator is reachable to re-serve leaf state**; the only always-available fallback is
   holding the leaf material yourself (the leaf-vault) + an external fee UTXO.*

---

## 9. Known limitation to document

The `balance:update` listener fires **only while the process is alive.** A one-shot/cron-style agent that
`cleanupConnections()` after each op will not snapshot background changes that occur while it is down —
but those are caught on the **next boot's sync + init snapshot**. The only truly uncovered window is:
*change lands → operators go permanently dark → agent never boots+syncs in between.* Mitigation: run as a
**persistent service**, not a cron one-shot. State this plainly so nobody assumes a cron agent has a
current vault.

---

## 10. Proposed deliverables

| File | Purpose |
|---|---|
| `skills/sparkbtcbot/references/unilateral-exit.md` | Model, `balance:update` trigger, fee-UTXO requirement, staleness table, persistent-service caveat |
| `skills/sparkbtcbot/scripts/leaf-vault.js` | `#snapshotLeafVault` + `atomicWriteJson`; opt-in `enableLeafVault()` on `SparkAgent` |
| `skills/sparkbtcbot/scripts/unilateral-exit.js` | Offline rebuild → CPFP → ordered broadcast → CSV wait |
| Edits to `agent-class.md`, `SKILL.md`, `architecture.md` | §8 corrections + vault documentation |
| Tests (see §11) | Vault round-trip; offline chain build with no client |

---

## 11. Open questions to resolve during implementation

1. **Exact `TreeNode` field names** for raw tx hex and per-leaf CSV timelock in the resolved SDK version
   (report used `rawTxHex`/`value` as placeholders).
2. **`getLeaves()` completeness** — does it return enough parent linkage for `buildUnilateralExitChain` to
   resolve the full chain in one online pass, or must we page `query_nodes` ourselves?
3. **Refresh semantics** — is a pure timelock-refreshed-but-still-owned leaf's *old* refund tx still valid?
   (Determines the ⚠️ row in §7.) Verify empirically on testnet.
4. **`sparkClient` handle** — confirm the supported way to obtain the `SparkServiceClient` the primitives
   accept from a `SparkWallet` instance (vs. reaching into internals).
5. **Fee-UTXO UX** — how the agent operator supplies/rotates the external UTXO, and how we warn when the
   L1 reserve is depleted.
6. **Broadcast path** — bundle a default (mempool.space API) vs. require operator-configured node.

---

## 12. Testing recommendations

- **Vault round-trip (unit):** snapshot → serialize → reload → `buildUnilateralExitChain` with **no
  client** returns a complete chain (asserts operatorless capability).
- **Trigger coverage (integration):** simulate `transfer:claimed` + a forced `optimizeLeaves()` and assert
  a fresh snapshot lands for each, atomically.
- **Staleness (integration):** snapshot, then optimize/transfer, then assert stale entries are detectable
  as SPENT/superseded (don't silently attempt them).
- **Offline exit (funded tier / regtest):** full exit from disk with operators unreachable + an external
  regtest fee UTXO; verify CSV wait ordering.

---

## 13. Sources

- Breez `spark-sdk` unilateral-exit README — https://github.com/breez/spark-sdk/blob/main/crates/internal/README.md#unilateral-exit
- Spark docs — Unilateral Exit (Wallet SDK / `sparkcli`) — https://docs.spark.money/wallets/unilateral-exit
- Lightspark — "Unilateral Exit is Now Live" — https://www.lightspark.com/news/spark/unilateral-exit
- Breez API simplification PR (referenced in the thread, unmerged as of writing) — https://github.com/breez/spark-sdk/pull/795
- SDK line references: `@buildonspark/spark-sdk@0.8.8` source as inspected (`src/utils/unilateral-exit.ts`,
  `src/spark-wallet/spark-wallet.ts`, `src/spark-wallet/types.ts`, `src/services/leaf-manager.ts`,
  `src/services/swap.ts`).
