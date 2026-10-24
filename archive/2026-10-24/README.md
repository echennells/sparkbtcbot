# Scratch archive, 2026-10-24

Loose work rescued before a dev-container rebuild: files that lived only in
session scratchpads or untracked in the repo root. Nothing here is wired into
the package. This branch is a drawer, not something to merge. The work with a
future got its own branch: `wip/x402-lnbtc-payer`, `wip/token-guards-e2e`,
`wip/companion-treasury-drafts`.

Scripts are kept as they ran, so most import by absolute path from
`/workspace`.

## Contents

- `root-drafts/` — untracked drafts from the repo root: the two
  spark-unilateral-exit PR write-ups (`PR-A-esplora-verdict.md`,
  `PR-B-direct-path-race.md`), a PR body, and release notes for v0.1.3 and
  v0.4.0.
- `flashnet-usdb/` — the 2026-10-02 MAINNET Flashnet try: swap 5,000 sats to
  USDB, then pay a 1,000-sat invoice with USDB. A second payment of the same
  invoice was refused and its tokens rolled back. `run-2026-10-02.json` is the
  step-by-step log. `send-back.mjs` returned the BEPSI test tokens. That wallet
  was swept and emptied on 2026-10-24.
- `setpolicy-tty/` — driving the `set-policy` TTY ceremony from a script
  (`drive.py`), with test policies: valid, a typo'd token id, human amounts,
  an exponent amount, an explicit `decimals`. Public `abandon … about` vector,
  throwaway passphrase.
- `l402/` — the 2026-09-25 L402 per-host token-cache sketch and smoke test
  (superseded by the in-memory L402 recovery that shipped 09-26), and
  `macgen/`, which generates v1/v2 macaroon fixtures with js-macaroon from a
  fixed test root key.
- `mpp-survey/` — probe of the MPP service directory for live 402 endpoints
  and the payment methods they declare (2026-09-26).
- `probe-ln-fee.mjs` — REGTEST probe of what a Lightning payment reports as
  its fee (groundwork for `feeSats`).

## Deliberately left out

Seeds, passphrase files, mnemonic files, audit logs and spend ledgers; L402
macaroons captured from live services; tunnel / broker / test-run logs;
`.bak` / `.fixed` / `.orig` copies of repo files (the commits have them);
generated listings and diffs; third-party clones and copied specs (x402,
ethskills, ethevals, ows-core and others); downloaded tarballs and binaries;
the GitHub API dumps.
