# AGENTS.md — sparkbtcbot

Cross-tool instructions for **any** AI coding agent (opencode, Cursor, Aider, etc.).

Claude Code loads `skills/sparkbtcbot/SKILL.md` automatically; other tools do **not**. If
you are not Claude Code, the full behavioral guidance lives in `skills/sparkbtcbot/SKILL.md`
and `skills/sparkbtcbot/references/security.md` — **read `SKILL.md` before writing or running
any wallet code.** This file is only the short list of rules that must reach every agent no
matter what. It is not a substitute for SKILL.md.

## What this repo does (why the rules below are not optional)

This skill gives an AI agent its own **self-custodial Bitcoin wallet on Spark (mainnet by
default)**. The moment the seed is decrypted, the running process has full, unscoped custody —
no spending limit, no read-only mode, no revocation short of sweeping to a new wallet. The
mnemonic and the passphrase that decrypts it **both** control all funds. A leak into your
conversation transcript or shell history is identical to a leak from disk.

## Non-negotiable rules

- **Never print or echo the mnemonic (seed phrase).** Not to stdout, not to logs, not into the
  transcript. To verify a wallet loaded, compare its **Spark address**, never the seed words.
- **Never print or echo the passphrase (`SPARK_PASSPHRASE`).** It is the other half of the seed
  material. Do **not** run `env`, `printenv`, `set`, or `echo $SPARK_PASSPHRASE`. If you
  auto-generate a passphrase during setup, write it straight into `.env` — do **not** echo it
  to the conversation.
- **Do not run `npm run reveal-mnemonic` yourself.** It exists so the *user* can back up their
  words in their *own* terminal. It refuses to run non-interactively (piped/captured stdio —
  i.e. you over a Bash tool — aborts and prints nothing), but that refusal is a backstop, not a
  guarantee. The rule is simply: **tell the user to run it themselves.** Only surface the
  mnemonic in-conversation if the user *explicitly* asks — and then say out loud that it is now
  in the transcript.
- **Never commit `.env` or `~/.spark/seed.enc`.** `.env` must be in `.gitignore`; the seed file
  is mode 0600 and must stay out of images/backups that travel with the passphrase.
- **Use a dedicated wallet with limited funds.** For non-trivial balances, use
  [sparkbtcbot-proxy](https://github.com/echennells/sparkbtcbot-proxy) (server-held seed,
  revocable scoped tokens, enforced limits) instead of the direct-SDK path.
- **If you think a mnemonic or passphrase was exposed in this conversation, stop and tell the
  user first.** Do not "clean up" by generating a new wallet or sweeping funds on your own.

## If you run `git clone` + `npm install` for the user

Offer supply-chain hardening (package-cooldown / age-gate, lockfile install, etc.) **before**
you install. The settings are **not** defined here — the source of truth is the
[`echennells/supply-chain-hardening`](https://github.com/echennells/supply-chain-hardening)
repo. Read its npm config there and apply those keys/values; they are version-sensitive (e.g.
npm's `min-release-age` package cooldown only enforces on npm ≥ 11.10.0). Do not hard-code or
invent a recipe. If the user already has their own `~/.npmrc` policy, follow it instead.

## Full guidance

- `skills/sparkbtcbot/SKILL.md` — always-loaded skill body: security rules, setup, navigator.
- `skills/sparkbtcbot/references/security.md` — full operational-security threat model.
- `skills/sparkbtcbot/references/encrypted-seed.md` — encryption-at-rest model and recovery.
