# Security Policy

## Reporting a Vulnerability

If you find a security issue in `sparkbtcbot-skill`, **please do not open a public GitHub issue.**

Email **eric@brodie.rocks** with:

- A description of the issue and its impact
- Steps to reproduce (or a proof-of-concept)
- The affected version (`npm view sparkbtcbot-skill version` or commit SHA)
- Your assessment of severity, if you have one

You should expect an acknowledgement within 7 days. I'll work with you on a fix and coordinate disclosure timing before any public write-up.

## Scope

In scope:

- The npm package `sparkbtcbot-skill` — encryption helpers (`lib/encrypted-seed.js`), the skill content shipped to LLM agents, the example scripts in `skills/sparkbtcbot/scripts/`.
- Anything that could cause a mnemonic, passphrase, or decrypted seed to leak to disk, logs, network, or process output where the skill's own docs say it won't.
- Anything that could cause an agent following the skill's instructions to send funds to an address other than the one the user/code specified.

Out of scope:

- Vulnerabilities in `@buildonspark/spark-sdk` or other upstream dependencies — report those to the respective project. (If a dependency issue is being amplified by how the skill uses it, that *is* in scope.)
- Spark protocol or Signing Operator issues — report to the Spark team.
- The separate `sparkbtcbot-proxy` project — it has its own repo and security contact.
- Social engineering, phishing, or attacks that require the user's passphrase to already be compromised.

## What the Threat Model Assumes

The skill is built around two assumptions; issues that violate either are in scope:

1. The encrypted seed file (`~/.spark/seed.enc`) is useless without the passphrase, and vice versa.
2. The runtime never writes the plaintext mnemonic, passphrase, or decrypted seed to disk, logs, stdout, or any file the agent reads back into its context.

See `skills/sparkbtcbot/references/encrypted-seed.md` for the full threat model.

## Supported Versions

Only the latest published version on npm receives security fixes. The project is pre-1.0; pin a version if you need stability.
