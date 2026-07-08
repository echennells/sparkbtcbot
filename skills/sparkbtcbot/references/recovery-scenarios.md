# Recovery scenarios — tested behavior

Empirical results for the leaf-vault backup (`scripts/leaf-vault.js`) and the unilateral-exit
recovery tool (`scripts/unilateral-exit.js`). Read alongside `references/unilateral-exit.md`
(usage) — this file is the *evidence*: what actually happens when you recover, including from a
**stale** backup, and how the justice / decrementing-timelock defense behaves.

## Test environment

- **Local Spark devnet** — the open-source operator stack (`buildonspark/spark` docker-compose:
  3 signing operators + Postgres + regtest bitcoind + a miner), so operator lifecycle and block
  production are fully controllable.
- **Broadcast caveat:** this devnet's bitcoind (Core v28.0.0) rejects the exit's ephemeral-anchor
  CPFP package on **dust relay policy**, so exits were mined with `generateblock` (consensus-checked,
  policy-bypassed). The transactions are consensus-valid; newer/relaxed-policy nodes relay them.
- **SSP absent:** the devnet has no Spark Service Provider (the receive/delivery side of a
  wallet-to-wallet transfer, Lightning, and leaf-swaps route through it). This means the *recipient*
  of a transfer can't finalize a claim on this devnet — so the "current owner defends itself" case
  was tested via the **operators' on-chain watchtower** rather than the recipient wallet. It does not
  affect deposit/claim/snapshot/exit, which are operator-and-bitcoin only.

Timelock constants (from the SDK): `INITIAL_SEQUENCE = 2000`, `TIME_LOCK_INTERVAL = 100`,
`DIRECT_TIMELOCK_OFFSET = 50`. A fresh leaf's refund carries a relative-timelock (CSV) of **2000**
blocks; each transfer hands the new owner a **shorter** one.

## The core guarantee (proven, many runs)

**Backup → restore of your own current funds works with no operators.** Deposit → `snapshotLeafVault`
→ rebuild the exit chain offline (operators never contacted) → broadcast → wait the CSV → recover on
L1. The vault's **integrity gate** refuses to persist a leaf unless it *provably reconstructs a
complete exit offline*, so in this design **"backed up" means "exitable"** — a written vault is a
recoverable vault, by construction.

## Stale-backup scenarios

A stale backup is a snapshot of an **old balance**. The scenarios below probe what that costs.

| # | Scenario | Setup | Result |
|---|---|---|---|
| **S1** | Does the timelock decrement on transfer? | deposit, read leaf timelock; transfer | ✅ `T_A = 2000`; transfers are **off-chain** (sender balance → 0, the deposit UTXO on L1 is untouched) |
| **S2** | Stale backup claw-back of a **sent** leaf, **operators up** | A snapshot → transfer leaf to B → A exits the stale vault | ❌ **Defeated.** The operators' watchtower swept the leaf at **CSV 1950** (height `Hn+1954`), `199,045 sats` → a non-A address, before A's `CSV 2000` refund could mature. **A got nothing.** |
| **S3** | Same, but **operators down** (true unilateral-exit conditions) | operators stopped → A exits the stale vault | ✅ **Succeeds.** No defender; A's own refund (`CSV 2000`, height `Hn+2003`) took `200,000 sats` → **A's address**. A **clawed back a leaf it had already sent.** |
| **S4** | Stale backup misses funds **received** after it | A snapshot → A deposits a 2nd leaf → A exits the stale vault | ✅ Recovers **only** the snapshotted leaf (200k). The 2nd leaf (received after the snapshot) is **absent from the vault → unrecoverable**. A fresh snapshot captured both. |

### S2 vs S3 — the justice mechanism, isolated

Same setup, opposite outcome, decided **entirely** by whether a defender existed:

| | Operators / watchtower | Who took the leaf | Spender CSV | Prior owner (A) result |
|---|---|---|---|---|
| **S2** | **up** | defender (non-A) | **1950** | got nothing |
| **S3** | **down** | A's own refund | **2000** | reclaimed 200k it had sent |

The decrementing timelock (`1950 < 2000`) is what *lets* the current-owner side win — but it only
protects the current owner if **someone actually fires the defense within the window** (here ~50
blocks, the `DIRECT_TIMELOCK_OFFSET`). With no defender, the stale prior-owner's exit matures and wins.

## End-to-end through the auto-enabled agent (`SparkAgent`)

S1–S4 above drove `snapshotLeafVault` **manually**. This run exercises the **shipped path**: a live
`SparkAgent` with the vault auto-enabled (`enableLeafVault` wired into its constructor), snapshotting
on its own event hooks (`balance:update` / `transfer:claimed` / `deposit:confirmed`) with **no manual
snapshot call anywhere**. Both restore directions were driven to L1. (Value-in was via **deposits**,
which fire the same hooks; the wallet-to-wallet *receive* leg stays SSP-blocked here — see Test
environment.)

| # | Situation | Flow | Result |
|---|---|---|---|
| **E1** | **Fresh** — have the latest data | agent auto-snapshots across 2 deposits → restore the CURRENT vault | ✅ The vault advanced **1→2 leaves unprompted** (fired by the deposit events, no manual call). Restore rebuilt **both** chains offline (operators not contacted) → recovered the **full 400,000 sats** to L1. |
| **E2** | **Stale** — missing the latest update | auto-snapshot deposit #1 → **freeze a copy** → auto-snapshot deposit #2 → restore the FROZEN copy | ✅ Auto-snapshot fired on each deposit. Frozen copy = **1** leaf; live vault = **2**. Restoring the copy recovered **only** the pre-freeze **200,000 sats**; deposit #2 was **absent from the copy → stranded**. |

E1/E2 confirm the manual findings hold through the real integration: **a fresh vault recovers
everything; a stale one recovers exactly what it captured and loses the delta.** Because the agent
keeps the vault current by itself, "stale" only arises if the process misses an event entirely
(e.g. offline while the balance changes).

## Conclusions

1. **The backup is a floor, not a gamble.** Whatever is in the vault *and still yours* is recoverable
   — you cannot lose it. Your leaves carry the **shortest** timelock, so if you broadcast your exit you
   win any race against a prior owner. (The integrity gate guarantees a saved vault is genuinely
   exitable.)

2. **Staleness only costs the delta.** A stale vault recovers the leaves you still hold that were
   captured at snapshot time. It **cannot** reclaim leaves you've since *sent* (S2 — correctly; you no
   longer own them), and it is **blind** to leaves you've since *received* (S4 — simply not in it). A
   stale vault = a stale balance.

3. **The genuine risk runs the other way — the justice / time-window attack.** If someone **sent you**
   a leaf and later broadcasts *their* stale exit for it, you (the current owner) must respond within
   ~50 blocks or **lose that leaf** (S3, seen from the victim's side). While operators are up, their
   **watchtower auto-defends you** (S2). But unilateral exit is the *operators-are-gone* case — so
   **that auto-defender is gone too**, and you need your own watchtower or to be actively watching.
   Note: **self-deposited funds have no prior owner**, so nobody can mount this attack on them.

4. **Freshness is the mitigation, and it's automatic.** `SparkAgent` auto-enables `enableLeafVault`
   (opt out with `SPARK_LEAF_VAULT=off`), which snapshots on boot, on every leaf-changing event
   (`balance:update` / `transfer:claimed` / `deposit:confirmed`, debounced), and on a safety-net timer
   for refreshes — so "stale" never drifts far from "now" (proven end-to-end in E1/E2). Received leaves
   additionally warrant watchtower awareness in an operators-gone world (conclusion 3).

## Evidence (on-chain, from the devnet runs)

- **S2** — A's node tx confirmed at height `Hn`; leaf output `O` spent at `Hn+1954` by a `CSV 1950`
  transaction paying `199,045 sats` to a non-A taproot address (the operator-watchtower defense).
  A's `CSV 2000` refund could not mature in time.
- **S3** — A's node tx `dfdf67ae5700…` confirmed at height `18136`; `O` spent at `20139` (`Hn+2003`)
  by A's refund `58a8afaa5d40…` (`CSV 2000`), paying `200,000 sats` to A's address `bcrt1pcmym4eg…`.
- **S4** — wallet held `400,000 sats` across 2 leaves; stale vault covered 1; exit recovered `200,000`;
  a fresh snapshot covered both leaves.
- **Core** — repeated deposit → snapshot → offline-verify → exit → `200,000 sats` recovered on L1,
  operators uninvolved in the exit.
- **E1** (auto-agent, fresh) — two `200,000`-sat deposits; the vault auto-advanced `1→2` leaves on the
  deposit / `balance:update` events (no manual snapshot); restoring the current 2-leaf vault confirmed
  both refunds, recovering `400,000 sats`. Leaves `019f3fd4-eb8a…`, `019f3fd5-0376…`.
- **E2** (auto-agent, stale) — frozen copy = 1 leaf (`019f3fd9-3f57…`); live vault = 2 leaves (adds
  `019f3fd9-52c2…`). The shared leaf is byte-identical in both files; the copy is simply missing the
  second entry, so its restore recovered `200,000 sats` and stranded the other `200,000`.
