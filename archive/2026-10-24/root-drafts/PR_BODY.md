## The problem

`auto-exit` / `make recover` stops one step short of a unilateral exit: once a leaf's exit chain is on chain it reports "all transactions broadcast" and marks the leaf done — but it never broadcasts the leaf's CSV-timelocked **refund**. The funds stay stranded in the unspent node output, and the destination sweep can never run.

It's easy to miss because on a live network the Spark operators' chainwatcher broadcasts the refund for you — so the gap only appears in the operators-gone case the tool exists for. Reproduced on a regtest/LOCAL stack with the operators stopped: the node tx confirms, `auto-exit` reports success, and the node output stays unspent past the CSV — even on a re-run after maturity.

## Root cause

The SDK's `constructUnilateralExitFeeBumpPackages` skips any node already on chain and only emits a leaf's refund alongside that leaf's *still-un-broadcast* node. So once the exit chain is broadcast it returns an empty package list — dropping the refund, which is a separate transaction that must be broadcast ~2000 blocks later. `auto-exit` reads the empty list as "complete." (The existing unit tests miss this because their mocked `constructPackages` keeps the refund in the list until it confirms — the contract the real SDK doesn't honor; the E2E uses the manual `package`→`broadcast` flow, which captures the refund up front.)

## The fix

`constructSparkPackages` re-attaches a leaf's refund when its exit chain is broadcast but no refund variant is on chain yet — rebuilding the CPFP fee-bump from the current funding UTXO via the SDK's own `constructFeeBumpTx`. `auto-exit`'s existing waiting-timelock loop then defers it and broadcasts it at maturity, and `package` emits it too. `auto-exit.ts` logic is unchanged (comments only).

Also handled: completion is detected via either the CPFP or the self-fee-paying direct refund variant; a non-JSON 404 from the esplora endpoint (which `.json()` throws on) is treated as not-on-chain and re-attached; each refund is funded from its own UTXO (refund fee-bumps are v3/TRUC and can't chain through one UTXO's change).

## Testing

- Unit tests for the re-attach, completion, throw-tolerance, and per-UTXO funding paths; full suite + `tsc --noEmit` green.
- Validated end-to-end on a regtest/LOCAL stack with the operators stopped: `auto-exit` broadcasts the node, defers the refund as `waiting-timelock`, and on re-run after CSV maturity re-attaches and broadcasts the refund (verified as the actual spender of the node output); a final `sweep` lands the funds at the destination. The unfixed code on the same leaf reports "all transactions broadcast" and never sends the refund.

## Notes

- The root gap is in the SDK's `constructUnilateralExitFeeBumpPackages`; this is a wrapper-level fix and likely deserves an upstream SDK fix too.
- Multi-leaf `package` runs want one UTXO per pending refund (documented in-code); `auto-exit` (one leaf per call) is unaffected.
- The mainnet 404-throw path is validated at the seam + unit level, not through a full mainnet run.
