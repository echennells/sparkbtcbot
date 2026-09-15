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

### A watchtower exit can also strand a leaf while the wallet still works (SDK ≥0.10)

The race above has a quieter cousin that needs no recovery tool: the operators' chainwatcher confirms an ancestor transaction on L1 and the leaf **silently stops being spendable on Spark** — it drops out of the balance and `getLeaves` with nothing telling you it needs attention. As of spark-sdk 0.10.0 the live wallet can find and repair these itself: `getWatchtowerExitedLeaves()` lists each stranded leaf with the on-chain output that still holds its value, and `recoverWatchtowerExitedLeaf({ leafId, destinationAddress, satsPerVbyteFee })` co-signs a sweep of that output with the SE (`recoverAndBroadcastWatchtowerExitedLeaf` also publishes it). Mind the trust line: this route needs the operators **alive and co-signing** — it is a live-wallet repair, not a replacement for the leaf-vault, which exists for when they are gone. Two gotchas from the SDK's own doc comments: recovered leaves stay in the list forever (the SE never sees your broadcast, so check the chain — not the list — to confirm a recovery landed), and re-calling with a higher fee *replaces* a slow recovery, since every attempt spends the same output.

## What to expect (from Blink's real mainnet exit)

### Some direct-route transactions cannot relay at all (the dust-fee class, SDK 0.12 fixes one size)

The direct chain carries no fee-bumping anchor: each direct transaction pays a **flat 955-sat fee out of the parent amount**, fixed at signing time. Nothing in the protocol checks that against Bitcoin Core's relay policy — the operators' validation recomputes the same fee and checks equality, but no node is in the loop until a watchtower or recovery tool calls `sendrawtransaction`. So a leaf whose parent is small enough that `parent − 955` lands **below the 330-sat P2TR dust floor** has a direct transaction that is validly signed and **unrelayable**: it will never be broadcast, and the watchtower defence for that leaf does not exist. Spark-sdk 0.12.0 fixed exactly one member of the class: a **1,024-sat** parent (fee capped to 694 so the output is exactly 330). Verified against the real signing binding on 2026-09-15, the class is wider — a **2,048-sat** parent's direct *refund* still leaves 138 sats, dust; every parent ≤ 512 sats has a zero-fee direct chain (watchtower-blind by construction); and any output ≤ 329 sats is dust on every path. Two consequences for this backup: **upgrading the SDK does not repair existing leaves** — the fee is baked into the signed transaction, and only a transfer, claim or timelock refresh re-signs it (the last signer's SDK version wins), so a leaf-vault snapshot after the bump carries the same unrelayable direct txs until the leaf next moves; and Blink's tool never constructs these transactions itself, only uses their txids, so a re-signed leaf shows up as a stale bundle (`unexpected spender`), which the vault's refresh cadence is what covers. The default leaf optimizer keeps a 1, 2, 4, … ladder, so nearly every wallet over ~2,000 sats holds a 1,024-sat leaf. The honest reading of the watchtower fix is "one denomination now relays", not "the direct route is defended".

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
