# PR B — branch `pr/direct-path-race`

**Title:** `feat(auto-exit): detect the operator's direct path exit and pivot to its refund`

**Base:** `main`

> Note for the description or a first comment: this touches `src/auto-exit.ts`, which #16 also modifies (the `errMessage` hoist). I resolved that one line against current `main`; happy to rebase whichever of the two lands second.

---

## Body

Every Spark `TreeNode` carries two pre signed routes to the same output: the CPFP chain this tool broadcasts (zero fee transactions plus anchor fee bumps), and a self fee paying **direct** route (`directTx`, then `directRefundTx` after a CSV delay) that the operators' chainwatcher can broadcast on its own.

The two routes conflict by construction. When the chainwatcher completes an exit while a recovery is in progress, the bundle's CPFP chain becomes permanently invalid: every submission fails `bad-txns-inputs-missingorspent`, and `auto-exit` deferred and resubmitted the dead package forever.

### Observed on mainnet

A recovery this month exited two leaves. While their CPFP refunds waited out the CSV, the operators' chainwatcher completed both exits via the direct route (`directTx` confirmed at blocks 959034 and 959710), which spent the same node outputs the bundle's chain needed. From then on the tool could not make progress and could not say why. Combined with the swallowed `submitpackage` verdict (separate PR), it reported an endless eviction loop.

### The change

On a `missingorspent` rejection, resolve which of the two meanings applies by looking up who spent the head transaction's first input:

- **unspent** — the parent is simply unconfirmed. Existing defer and retry, unchanged.
- **spent by the leaf's known `directTx`** — the race is lost. Pivot: record the direct refund in the sweep compatible packages output, defer while its CSV matures, and broadcast it as a plain transaction once mature (its fee is baked in, so there is no anchor child to fund). `sweep` needs no changes; the direct refund pays the same seed derived script.
- **spent by anything else** — fail the leaf loudly instead of retrying. The bundle no longer describes reality and a human needs to look.

Detection runs through injectable deps (`fetchOutspend`, `directPathOf`, `inputOutpointOf`) matching the rest of the orchestrator, backed by `GET /tx/:txid/outspend/:vout`, the `TreeNode` protobuf, and the same txid byte order candidates `relativeHeightLock` already uses.

### Validation

Live, against the affected mainnet recovery:

- **Detect and defer** — the run named both operator `directTx` ids and computed both direct refund maturities (blocks 960260 and 960484), replacing the infinite loop with two correct statuses in a single round.
- **Detect and track** — after the first refund matured, the chainwatcher broadcast it within minutes; the tool recognized it, marked the leaf `exit-broadcast`, and pointed the packages file at the direct refund. That refund confirmed at block 960261 and the funds are recoverable by `sweep`.

Unit tests cover all four outcomes including the two the live runs could not reach:

- pivot to a timelocked direct refund (maturity computed, dead package never submitted)
- broadcast a matured direct refund as a plain transaction
- report completion when the direct refund is already on chain
- fail loudly on an unknown spender, and still defer an ordinary unconfirmed dependency

### On the branch that has no live coverage

With operators alive the chainwatcher wins the broadcast race every time, so the "broadcast the matured direct refund ourselves" path cannot be exercised on a live network. That path is the operators gone case, and it is covered by unit tests only.

Worth noting for anyone trying to reproduce this locally: the pinned local operator stack does not populate `directTx` / `directRefundTx` on leaves at all (only `directFromCpfpRefundTx`), verified on a freshly claimed deposit and after a full amount transfer. The direct path race is therefore structurally unreproducible on that stack, which is why it survived until a mainnet run found it. If the pinned commit is ever advanced to a build that creates the direct route, an E2E for the broadcast branch becomes possible.

`tsc --noEmit` clean, unit suite green (171 passing).

---

## Review response (2026-08-14, drafted, NOT yet posted)

Branch state: rebased onto upstream main `4abb1e8` (#20), feature commit now `edcd327`, review fixes in `f7816df` on top. Typecheck clean, 183 unit tests passing. Push blocked on missing GitHub auth in the container.

Draft reply to openoms's changes-requested review:

> Addressed in the follow-up commit, and the branch is rebased on current main.
>
> The retry bug: `resolveDirectPathRace` now retains the last lookup error and rethrows it when no candidate produced a definitive response. A 404/null on the first byte order candidate still falls through to the second, and a definitive answer from either candidate outweighs a retained error from the other. On the caller side the propagated error is counted through `recordLeafError` rather than logged and deferred, so a persistent lookup outage fails the leaf after `MAX_LEAF_FAILURES` instead of retrying forever. Unknown chain state is no longer treated as unspent.
>
> Coverage: added the two requested orchestrator cases (both candidates error, which under the old code would have spun to the round cap, and first candidate 404 with the second succeeding), plus an error-then-success case pinning that a definitive answer wins. Boundary tests: `getOutspend` now has direct 200/404/5xx tests in `test/esplora.test.ts` asserting the `/tx/:txid/outspend/:vout` URL, and `firstInputOutpoint` has a real transaction test (non palindromic prev txid, nonzero vout) asserting both byte order candidates and agreement with `relativeHeightLock`'s candidates.
>
> The non blocking smell as well: the duplicated byte order construction is extracted into a shared `txidByteOrderCandidates` helper used by both `relativeHeightLock` and `firstInputOutpoint`.
>
> `npm run typecheck` and the unit suite are green locally (183 passing).
