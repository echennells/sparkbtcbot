# Recovery behavior & economics

Operatorless recovery to L1 is performed by Blink's tool
([blinkbitcoin/spark-unilateral-exit](https://github.com/blinkbitcoin/spark-unilateral-exit));
this skill keeps the recovery bundle fresh (see `unilateral-exit.md`). The
properties below shape what recovery can and cannot do — useful when reasoning about
what the leaf-vault protects.

Timelock constants (from the SDK): `INITIAL_SEQUENCE = 2000`, `TIME_LOCK_INTERVAL = 100`,
`DIRECT_TIMELOCK_OFFSET = 50`. A fresh leaf's refund carries a relative-timelock (CSV)
of ~2,000 blocks; each transfer hands the new owner a **shorter** one.

## The backup is a floor, not a gamble
Whatever is in a current, complete bundle and still yours is recoverable — you cannot
lose it. The leaf-vault's integrity gate refuses to write a bundle unless every leaf
reconstructs a complete exit chain offline (to a genuine tree root, with its
pre-signed txs), so **a written bundle is an exitable one**.

## Staleness costs only the delta
A stale bundle recovers the leaves you still hold that were captured at snapshot time.
It **cannot** reclaim leaves you've since **sent** (you no longer own them), and it is
**blind** to leaves you've since **received** (simply not in it). A stale bundle = a
stale balance. This is why the leaf-vault auto-refreshes on every balance change.

## The justice / decrementing-timelock caveat
The decrementing CSV means a **current** owner's exit matures before a **prior**
owner's — but only if the defense fires within the window (~`DIRECT_TIMELOCK_OFFSET`
blocks). While operators are up, their watchtower auto-defends you; unilateral exit is
the operators-gone case, so **that auto-defender is gone too** — for received leaves
you'd need your own watchtower or to be actively watching. **Self-deposited funds have
no prior owner**, so nobody can mount this attack on them.

## Measured on a real $10 mainnet exit (2026-07-12 → 2026-08-01)

A deliberate end-to-end test of this whole recovery path — a 16,000-sat wallet across 19 leaves, exited with Blink's tool and swept to L1. What it added to the numbers above:

- **Being accepted by the network is not the same as being mined.** Bitcoin Core v30 lowered the *relay* floor (to 0.1 sat/vB), so an exit package can propagate perfectly and still sit unmined indefinitely, because miners apply their own, higher threshold. We confirmed both halves of this live: one run relayed fine and was never mined in 14 days before expiring, while a run at a higher rate confirmed within hours. **Do not size an exit from any fixed sat/vB figure — including the ones in this paragraph.** Quote against the mempool at the time (`/api/v1/fees/recommended` or your own node's `estimatesmartfee`) and price to land in a near-term block. Nothing is lost if you undershoot: an unmined package expires from the mempool after ~14 days and its inputs become spendable again, so the failure mode is delay, not loss.
- **Dust dominates.** 11 of 19 leaves were uneconomical and skipped automatically; only the largest few were worth exiting at all. The consolidate-first advice is not theoretical.
- **Timelocks are shorter than "a fresh leaf" implies, because they decrement.** The refunds here carried **550** and **1,450** block CSVs, not ~2,000 — the decrementing-timelock scheme in action, since these leaves had prior owners. Plan for weeks regardless: first broadcast to swept funds was **20 days** in this run.
- **The operators finished it, not us.** Their chainwatcher completed both leaves via the direct route (see `unilateral-exit.md`) and later broadcast both direct refunds within minutes of maturity. The recovery still succeeded — the direct refunds paid the seed-derived addresses and were swept normally — but every broadcast race with a live operator is one you lose. Expect your role to be **detect, track, and sweep** unless the operators are genuinely gone.
- **Direct refunds are self-paying.** The operator signs them with the fee already inside the transaction, so that path needs no CPFP funding UTXO at all — only the CPFP route does. You take whatever rate they baked in, which is fixed at signing time and may be under- or over-priced for the mempool you meet.
- **The bundle under test was this skill's own.** The recovery consumed a leaf-vault bundle (`appVersion: sparkbtcbot`), not one produced by Blink's `refresh-bundle`, so the full chain — leaf-vault snapshot → Blink's tool → funds on L1 — is proven end to end on mainnet, not just each half separately.
- **Fund one UTXO per leaf.** Without `--fan-out`, a multi-leaf run consumes one funding UTXO per leaf; a second run can quietly eat the reserve you set aside for the first one's refunds.

## Exits are expensive and slow
From Blink's real mainnet exit: a dusty 100k-sat / 22-leaf wallet needed 253 packages,
and exiting everything would have paid ~79% of the balance in fees at the rate that
run faced; the ratio moves with the fee market, so re-derive it from current rates;
economic triage (skip dust) recovered ~90%. Each refund then waits a ~2,000-block
(~2-week) CSV. **Consolidate leaves while operators are cooperative**, and treat the
exit path as a fire escape, not a door. Full numbers: Blink's
`docs/mainnet-exit-case-study.md`.
