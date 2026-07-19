# Eval status

These evals now live **with the skill** on the release branch. They previously
lived on a separate `evals` branch whose SKILL.md/references had drifted to a
pre-0.4.0 version (plaintext-mnemonic model; `agent-class.md` still taught the
deprecated top-level `balance` and `cleanupConnections()`). Evals orphaned on a
stale branch silently test an old skill — so they belong next to the current one.

## What's here

- `evals.json` — **output / behavioral** evals (8): 6 SDK-correctness + 2
  security-behavior. Each carries checkable `assertions`. These test what the
  skill *produces*.
- `trigger-eval.json` — 20 description-**triggering** queries (10 should-trigger,
  10 should-not). Kept as an asset, but see "Triggering" below: it is not
  reliably measurable in this environment.

## How to run (the method that works here)

Triggering can't be measured reliably here, but **output evals run cleanly via
subagents.** From a Claude Code session, for each eval spawn two subagents:

- **with-skill**: "read /workspace/skills/sparkbtcbot/SKILL.md and its
  references, then do <prompt>; write the code to a file." (No execution needed —
  these are graded as code.)
- **baseline**: "do NOT read any file under /workspace/skills and do NOT consult
  any Spark skill; answer from your own knowledge. Do <prompt>; write the code."

Then grade each produced file against that eval's `assertions` (grep/read). The
signal is the **delta**: where with-skill satisfies an assertion the baseline
misses, that is the skill's value.

Two caveats to keep honest:
- **The baseline isn't a true zero-knowledge baseline.** This repo is public, so
  the model has likely absorbed its patterns in training — which *understates*
  the skill's measured value. A weaker model, or one without the repo in
  training, would do worse at baseline.
- **Security assertions read the produced code + the run's final message** for a
  leaked mnemonic / plaintext storage.

## Last run (release/0.4.0 skill, Opus, subagents)

SDK-correctness: **skill 4 wins, 2 ties, 0 losses.** The no-skill baseline
reached for deprecated or hallucinated APIs and the skill corrected each:

| Eval | with-skill | baseline | winner |
|---|---|---|---|
| 1 balance | `satsBalance.available` | deprecated `.balance` | skill |
| 2 tokens | `ownedBalance` | `balance` | skill |
| 3 sign/verify | SDK `validateMessageWithIdentityKey` | hand-rolled `secp256k1.verify` | skill |
| 4 L402 | payLightningInvoice + cache | payLightningInvoice + cache | tie |
| 5 transfer | transfer + poll | transfer + poll | tie |
| 6 mint/create | `createToken` + `mintTokens({...})` | `announceTokenL1` + positional `mintTokens(n)` | skill |

Security-behavior: **tie (2).** Both with-skill and baseline encrypted the seed
at rest, never printed the mnemonic, and verified by address. On this model the
security rules are insurance (they'd matter on a weaker model), not a
differentiator. The skill's clear, robust value is SDK currency.

## Triggering — not reliably measurable here

`run_eval.py` / `run_loop.py` (skill-creator) measure triggering by writing a
stub command to `.claude/commands/` and spawning a single-shot `claude -p` per
query, then watching for a `Skill`/`Read` tool call. In this setup it scored
`trigger_rate = 0.00` on **all** queries — positives and negatives alike — i.e.
the harness never detected a trigger at all. Causes: a single-shot headless
`claude -p` tends to answer directly rather than orchestrate a skill, and the
harness registers a content-free slash-command stub rather than a real skill.
So the number carries no information about the description.

Do not re-run it expecting signal. If triggering must be measured, judge the 20
queries qualitatively, or build a subagent-based check (a subagent per query,
skill available, graded on whether it used the Skill tool) — a better proxy than
single-shot `claude -p`.
