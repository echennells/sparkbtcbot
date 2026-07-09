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

## Exits are expensive and slow
From Blink's real mainnet exit: a dusty 100k-sat / 22-leaf wallet needed 253 packages,
and exiting everything at 1 sat/vB would have paid ~79% of the balance in fees;
economic triage (skip dust) recovered ~90%. Each refund then waits a ~2,000-block
(~2-week) CSV. **Consolidate leaves while operators are cooperative**, and treat the
exit path as a fire escape, not a door. Full numbers: Blink's
`docs/mainnet-exit-case-study.md`.
