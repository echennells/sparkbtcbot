# v0.1.3

Cumulative release covering everything since v0.1.0 (the 0.1.2 tag was skipped). This release ships a security fix to the L402 example script, scopes the skill's security claims more honestly, and adds a full repo-health and test-coverage pass.

## Security

Stopped logging the L402 payment preimage. The `l402-paywalls.js` example previously printed a 16-character prefix of the Lightning payment preimage to stdout. The preimage is the L402 authorization secret — it goes directly into the `Authorization` header — and stdout from a Bash-invoked script is captured into an agent's transcript, so even a prefix is a leak. Flagged by Socket's AI code-anomaly scan.

## Changed

Honest security scope in `SKILL.md`. Removed two lines that instructed users to do things the skill provides no help with:

- In-process spending controls — misleading, because anything in a compromised agent process can call `wallet.transfer()` directly and bypass an in-process wrapper. The skill now points to sparkbtcbot-proxy for real, server-enforced per-transaction and daily caps.
- Auto-sweep advice — the skill ships no sweeper. It now says so plainly and describes how to build a listener if you want one.

The model-invocation reasoning in the skill frontmatter was tightened to make the same point: direct-SDK use is full-custody-once-decrypted, and guardrails require the proxy.

## Removed

The `lessonsPath` export was removed from the npm package API (`lib/index.js`, `lib/index.d.ts`), along with the bundled `LESSONS.md`. If you imported `lessonsPath`, drop the reference — `skillPath` and `referencesDir` are unchanged.

## Tooling and tests

- GitHub Actions CI (`.github/workflows/ci.yml`) runs `npm test` on Node 18, 20, and 22 for every push and pull request against `main`.
- 16 new unit tests (72 total, all passing): `skill-content.test.js` covers the content helpers and an anti-drift check against the README; `plugin-manifest.test.js` validates the plugin marketplace manifest; `encrypted-seed.test.js` adds `loadMnemonicFromEnv` and file-format rejection coverage.

## Community health

Added `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1), and `SECURITY.md` with private disclosure to eric@brodie.rocks.

---

Full changelog: https://github.com/echennells/sparkbtcbot-skill/compare/v0.1.0...v0.1.3
