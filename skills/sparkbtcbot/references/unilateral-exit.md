# Unilateral exit (operatorless recovery)

Getting your Bitcoin off Spark and back onto L1 **without the operators** — the
last-resort path if the Spark Service Provider and signing operators are
permanently gone.

## This skill keeps the backup; Blink's tool does the exit

Recovery has two halves, and this skill only owns the first:

1. **Keep a fresh recovery bundle while operators are online** — the *leaf-vault*
   (`scripts/leaf-vault.js`, auto-enabled in `SparkAgent`). Seed-only recovery is
   impossible once operators are offline: your current leaves and their ancestor
   tree nodes cannot be derived from the seed. The leaf-vault mirrors that material
   to `~/.spark/leaf-vault/current.json` on every balance change, in the exact
   format the recovery tool consumes.
2. **Perform the exit** — done by Blink's production tool,
   **[blinkbitcoin/spark-unilateral-exit](https://github.com/blinkbitcoin/spark-unilateral-exit)**.
   It is tested on real mainnet, prices each leaf and skips uneconomical dust,
   respects TRUC confirm-and-continue sequencing, and handles the CPFP fee-bumping
   and the ~2-week CSV timelock. Do not hand-roll this.

## The bundle format

The leaf-vault writes `spark.unilateral-exit-bundle.v1` — the schema Blink's CLI
validates and consumes:

- `leaves[]` — the leaves to exit: `{ id, status, valueSats, treeNodeHex }`.
- `nodes[]` — their ancestor tree nodes: `{ id, treeNodeHex }`. **Required for any
  multi-level tree** — Blink's CLI serves these to the SDK offline (via its
  `createBundleSparkClient`) to reconstruct each exit chain with operators gone.
- metadata — `schema`, `createdAt`, `network`, `walletIdentityPublicKey`, etc.

`treeNodeHex` is the canonical `TreeNode` protobuf. **The bundle contains no private
keys** — the refund pays a P2TR address the *seed* re-derives, so a stolen bundle
cannot move funds; only the seed can spend the recovered output. The leaf-vault's
integrity gate refuses to write a bundle unless every leaf reconstructs a complete
exit chain offline (down to a genuine tree root) with its pre-signed txs intact — so
a written bundle is a recoverable one.

## Recovering

Point Blink's tool at your bundle plus a destination address, and fund its CPFP fee
inputs; follow its `docs/recovery-runbook.md` and withdraw guide. Verify your bundle
any time with `npm run leaf-vault -- verify` (exit codes: 0 = ok or nothing to back
up, 1 = broken bundle or funded wallet with no backup, 2 = indeterminate). If
snapshots fail persistently — or the SDK reach-in breaks — a `BROKEN` file is
written beside `current.json`; treat its presence as "no fresh backup".

A **cooperative L1 withdrawal does not trip the marker** while its transaction sits
unconfirmed: during that window the exiting leaves have left the leaf set but
`owned` still counts their sats, which used to read as a shrink and cry BROKEN on
every withdrawal. The snapshot now confirms a pending COOP_EXIT with the SSP,
keeps a union bundle (so even the in-flight leaves retain exit material), and
writes the clean bundle after the exit confirms on L1. A BROKEN marker during a
withdrawal therefore still means something is actually wrong.

## Normal recovery vs Lightning (why the seed is enough — except for this)

For **normal recovery** (operators online) Spark is **stronger than Lightning**, where channel state must be backed up separately (Static Channel Backup / DLP) and channel funds can be lost on data-dir loss even if the seed is safe. With Spark, *as long as the operators are up*, losing the local data directory loses nothing: operators hold leaf state authoritatively, so a fresh install with the same mnemonic recovers the full wallet. Losing the seed loses everything. The one thing local data protects that the seed does **not** is unilateral exit — the leaf-vault bundle this document describes.

Recovery extends the trust model's "moment-in-time" assumption to one additional moment: at re-init, at least one operator must serve the leaf-state query. The same censorship risk that applies to transfers applies here; if recovery is censored, unilateral exit is the fallback.

## Tokens are NOT covered by this

Unilateral exit recovers **BTC only**. The bundle records token balances as
`usdb: { status: "not-covered-by-bitcoin-unilateral-exit" }` — an honest marker, not
an oversight: BTKN/LRC20 balances have no pre-signed L1 exit path, so if the
operators vanish there is no equivalent escape hatch for them.

Say this plainly to anyone holding tokens on Spark. The leaf-vault protects their
sats; it does not protect their tokens, and no backup this skill can make will.
Treat token balances as operator-dependent, and size them accordingly.

## Every leaf has TWO exit routes, and the operators may use theirs

A `TreeNode` carries two independently pre-signed paths to the same output:

- the **CPFP route** (`nodeTx` → `refundTx`) — zero-fee transactions the recovery tool broadcasts with anchor fee-bumps, and
- the **direct route** (`directTx` → `directRefundTx`) — self-fee-paying versions the operators' chainwatcher can broadcast on its own.

They spend the same outputs, so **only one can win**. This matters because the realistic failure is rarely "operators vanish cleanly": it is operators degraded, censoring, or disappearing *partway*. If their chainwatcher completes an exit while your recovery is in flight, your bundle's CPFP chain becomes permanently invalid and every submission fails `bad-txns-inputs-missingorspent`.

**That is not a loss.** The direct refund pays the same seed-derived P2TR address, so the funds still land where only your seed can spend them — you sweep from there instead. But a recovery tool that doesn't recognize the race will resubmit a dead package indefinitely and report nothing useful.

**Use a version of Blink's tool that detects this** (the direct-path pivot, contributed after a live mainnet run hit it). If yours loops on "package disappeared from the mempool (likely evicted)" while the node is actually answering `missingorspent`, it predates the fix — check the node output's spender before assuming anything is stuck.

## What to expect (from Blink's real mainnet exit)

- **Expensive and slow by construction.** A 100k-sat wallet across 22 leaves needed
  253 packages; exiting everything would have cost ~79% of the balance in fees at
  the rate that run faced. With economic triage (skip dust leaves), ~90% reached the
  destination. Treat the ratio, not the rate, as the lesson: it scales with the fee
  market, so price any real exit against the mempool of the day.
- **~2-week timelock.** Each refund carries a ~2,000-block CSV: broadcast the exit
  chains, wait out the timelock, then broadcast the refunds and sweep.
- **Consolidate while you can.** Fewer, larger leaves exit far more cheaply; dust
  from routine payments is often not worth exiting at all.

See Blink's `docs/mainnet-exit-case-study.md` for their full numbers, and
`references/recovery-scenarios.md` for the recovery properties (staleness, justice)
plus measurements from an independent $10 mainnet exit run end to end in 2026-07.
