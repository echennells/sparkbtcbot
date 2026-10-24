# x402 `exact` on Lightning (`lnbtc`): payer prototype

Status: prototype, 2026-09-25. Not wired into `SparkAgent`. Rescued from a
session scratchpad on 2026-10-24 so it survives a container rebuild.

sparkbtcbot is the **payer** only (Eric, 2026-09-25). Spark wallets cannot be
safe `lnbtc` receivers: invoices from unrelated Spark wallets are signed by the
same SSP node key, and `createLightningInvoice` accepts an arbitrary
`descriptionHash`, so any Spark user can mint an invoice that passes every
facilitator check for someone else's resource while holding the preimage.
`probes/spark-payee-probe.mjs` is the REGTEST check that showed it (two fresh,
never-funded wallets).

Spec: `specs/schemes/exact/scheme_exact_lnbtc.md` in the x402 repo (PR #2861).

## Files

- `lnbtc.mjs` — the payer core: JCS request binding (`http:1`, `mcp:1`),
  strict BOLT11 decode with signature/payee recovery, exact-msat amount checks,
  the error codes the spec names.
- `vectors.mjs` — every published vector plus negatives. `node vectors.mjs`
  → 37 passed.
- `roundtrip.mjs` — HTTP roundtrip against a local spec-shaped server with a
  mock payer, in the shape `agent.fetchX402` would take (paid retry re-presents
  the proof, duplicate settlement, hostile price / binding refused before
  paying). `node roundtrip.mjs` → 10 passed.
- `probes/` — `bolt11-payee.mjs` (payee recovery), `check-vector.mjs` (the
  spec's description hash), `spark-payee-probe.mjs` (the receiver finding).

Deps (`@noble/curves`, `@scure/base`, `@noble/hashes`) are only transitive via
`@buildonspark/spark-sdk`; shipping this would need direct pins.

## If it ships

`agent.fetchX402` paying through `payAndSettle`, so it inherits the policy,
budget, fee cap, dedup, audit log and preimage check. `settled: false` means in
flight, not failed. Spark pays mainnet only (no testnet `lnbtc`); refuse
sub-sat msat amounts; set the bound headers explicitly (undici sends its own
`accept`, and a mismatch fails closed). No token reuse: every request pays.
