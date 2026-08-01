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

- **Fee rates, measured against real miners.** 0.5 sat/vB confirmed within hours. **0.1 sat/vB relayed fine and was never mined in 14 days**, then expired from the mempool and the inputs became spendable again. Bitcoin Core v30 lowered the *relay* floor to 0.1 sat/vB, but relay is not mining — size an exit well above the relay floor or it simply never happens. (Nothing is lost when it doesn't: expiry returns the funds.)
- **Dust dominates.** 11 of 19 leaves were uneconomical and skipped automatically; only the largest few were worth exiting at all. The consolidate-first advice is not theoretical.
- **Timelocks are shorter than "a fresh leaf" implies, because they decrement.** The refunds here carried **550** and **1,450** block CSVs, not ~2,000 — the decrementing-timelock scheme in action, since these leaves had prior owners. Plan for weeks regardless: first broadcast to swept funds was **20 days**.
- **The operators finished it, not us.** Their chainwatcher completed both leaves via the direct route (see `unilateral-exit.md`) and later broadcast both direct refunds within minutes of maturity. The recovery still succeeded — the direct refunds paid the seed-derived addresses and were swept normally — but every broadcast race with a live operator is one you lose. Expect your role to be **detect, track, and sweep** unless the operators are genuinely gone.
- **Direct refunds are self-paying.** Their fee is baked in (~8.6 sat/vB here), so that path needs no CPFP funding UTXO at all — only the CPFP route does.
- **Fund one UTXO per leaf.** Without `--fan-out`, a multi-leaf run consumes one funding UTXO per leaf; a second run can quietly eat the reserve you set aside for the first one's refunds.

## Exits are expensive and slow
From Blink's real mainnet exit: a dusty 100k-sat / 22-leaf wallet needed 253 packages,
and exiting everything at 1 sat/vB would have paid ~79% of the balance in fees;
economic triage (skip dust) recovered ~90%. Each refund then waits a ~2,000-block
(~2-week) CSV. **Consolidate leaves while operators are cooperative**, and treat the
exit path as a fire escape, not a door. Full numbers: Blink's
`docs/mainnet-exit-case-study.md`.
