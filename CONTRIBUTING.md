# Contributing

Thanks for taking a look. This is a small single-maintainer project, but contributions are welcome.

## Bugs and feature requests

Open an issue at https://github.com/echennells/sparkbtcbot-skill/issues. For bugs, please include:

- What you ran (the exact `npm run …` script or code snippet)
- What you expected
- What happened instead (stack trace, error message)
- `node --version`, OS, and `SPARK_NETWORK` value
- Whether the wallet has funds (for payment/withdrawal bugs — `REGTEST` repros are easier to debug)

**Never paste a mnemonic, passphrase, or the contents of `seed.enc` into an issue.** If a bug requires wallet state to reproduce, use a throwaway `REGTEST` wallet.

## Pull requests

1. Fork and create a branch off `main`.
2. Make your change. Keep the diff focused — one concern per PR.
3. Run the test suite:
   ```bash
   npm test                 # unit tests (fast, no network)
   npm run test:integration # integration tests (REGTEST, no funds required)
   ```
   `test:funded` exercises real-money paths and is not expected for most PRs.
4. If you're changing skill content (`skills/sparkbtcbot/SKILL.md` or `references/*.md`), spot-check that the relevant `npm run example:*` script still works.
5. Open the PR with a short description of *why* the change is needed.

## Scope

The skill teaches LLM agents to use the Spark SDK safely. Changes that fit:

- Bug fixes in the encryption helpers or example scripts
- Clarifications to `SKILL.md` or reference docs when the SDK or Spark behavior changes
- New reference docs for capabilities the SDK gains
- Test coverage

Changes that probably don't fit (open an issue first to discuss):

- New runtime dependencies — the package is intentionally zero-dep beyond Node built-ins
- Wrappers around SDK methods that don't add safety or agent-relevant context
- Support for non-Spark wallets — that belongs in a separate skill

## Security issues

Do **not** open a public issue for security vulnerabilities. Email eric@brodie.rocks instead.
