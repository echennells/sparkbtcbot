# Token guards: REGTEST end-to-end harness + eval outputs (2026-09-30)

Rescued from a session scratchpad on 2026-10-24 so it survives a container
rebuild. The results are written up in `skills/sparkbtcbot/evals/NOTES.md`
(evals 43–48 and the end-to-end run); this is the harness and raw output
behind them.

## Harness

`e2e.py` drives the shipped entry points with `HOME` sandboxed, so every
`~/.spark` default is real: setup → fund → `set-policy` (TTY) → `--show` (TTY)
→ agent program → `reset-ledger` (TTY) → agent again → sweep.

- `agent-run.mjs` — the "agent program", written the way the docs tell a user
  to: the package's own imports (`sparkbtcbot-skill`, `sparkbtcbot-skill/agent`),
  the seed opened with `loadMnemonicFromEnv` via `SPARK_PASSPHRASE_FILE`.
- `fund.mjs` — funds the e2e wallet with sats + SKILL tokens from the shared
  REGTEST test wallet (`SPARK_TEST_MNEMONIC` in `.env`).

Kept exactly as it ran, so the paths are the original ones: the CLI at
`/workspace/skills/sparkbtcbot/scripts/cli.js`, and `agent-run.mjs` /
`fund.mjs` in `/workspace/.e2e-tmp/`, a scratch npm project with the packed
package (`npm pack`) installed so the package imports resolve. The passphrase
in `e2e.py` is a throwaway for the sandboxed REGTEST wallet.

## Eval outputs

`eval-outputs/` — raw replies from the 2026-09-30 runs: `eNN-with` is with the
skill loaded, `eNN-base` is the no-skill baseline (run only for 43 and 47).
