# Changelog

## 0.3.1 — 2026-08-03

Docs-only release, prompted by Boltz disabling all swaps indefinitely (August 2026): this skill's standing advice to prefer Boltz for L1 withdrawals pointed at a service that no longer operates.

### Changed

- **Removed the Boltz recommendation; documented the native routes instead.** L1 off/on-ramping is now documented as the two-leg paths that depend only on the Spark operators: **Lightning → L1** (receive over Lightning at 0.15%, then cooperative exit) and **L1 → Lightning** (deposit + claim with a previewed fee ceiling, then pay out at 0.25% + routing) — both new sections in `references/lightning.md`. Boltz remains mentioned only as factual context; no third-party swap is a documented dependency anymore.
- **Real cooperative-exit fee numbers, from a live MAINNET quote (2026-08-03).** The exit fee is flat with respect to amount — 2,430 sats at MEDIUM (750 operator fee + 1,680 feerate-tracking L1 broadcast fee) for a 1,000-sat and an 8,500-sat withdrawal alike. Documented consequences in `SKILL.md` and `references/wallet.md`: withdrawals under 25,000 sats stay discouraged, large exits are cheap (~0.24% at 1M sats), batch small balances, always quote first, and sum **both** quote components — the old example printed only `l1BroadcastFee`, silently omitting the operator's `userFee` (~30% of the real cost).
- **Corrected the unilateral-exit overstatement.** "Spark guarantees you can always exit to L1" implied the seed alone suffices; exiting without operator cooperation additionally requires the pre-signed leaf material operators hand the wallet at claim/transfer time, which is not derivable from the mnemonic.

## 0.3.0 — 2026-05-29

### Added

- **Opt-in outbound recipient allowlist** (`lib/recipients-allowlist.js`). When `~/.spark/recipients.allow` exists with at least one entry, transfers and cooperative withdrawals to any address not on the list fail; a missing or empty/all-comments file leaves the gate unenforced. Spark (`sp1…`) and L1 addresses share one file (one per line, `#` comments allowed), matched as plain strings. New exports `loadRecipientsAllowlist`, `assertRecipientAllowed`, `DEFAULT_ALLOWLIST_PATH`; enforced in `spark-agent.js` on transfer/withdraw (Lightning BOLT11 sends are not gated, since they target node pubkeys). This is an operator-surprise guardrail, **not** a defense against a compromised agent (which can rewrite the file) — `sparkbtcbot-proxy` remains the path for hard-enforced, server-side limits.

### Security

- **Atomic, crash-safe seed writes.** `saveEncryptedMnemonic()` and the mnemonic-backup writer now write via temp file + `fsync` + atomic rename instead of a plain exclusive-create, so a crash mid-write can no longer leave a partial or corrupt `seed.enc`. Exclusive-create semantics (refuses to overwrite) and `0o600` permissions are unchanged.
- **Passphrase env hygiene.** `loadMnemonicFromEnv()` now clears `SPARK_PASSPHRASE` from `process.env` immediately after reading it, on all paths, shrinking the window it lives in process memory (debugger snapshots, child-process inheritance, crash dumps). Opt out with `loadMnemonicFromEnv({ clearEnv: false })` if a later path must re-read it. Crypto primitives unchanged (scrypt N=2¹⁷, AES-256-GCM).

## 0.2.0 — 2026-05-29

### Changed

- **Runtime dependencies are now declared in `dependencies` instead of `devDependencies`.** `@buildonspark/spark-sdk`, `@buildonspark/issuer-sdk`, `dotenv`, and `light-bolt11-decoder` previously lived in `devDependencies`, so installing the package as a project dependency (`npm install sparkbtcbot-skill`) did **not** pull them — the example scripts then failed with `ERR_MODULE_NOT_FOUND` until a separate manual SDK install. They now install automatically. `vitest` remains the only `devDependency`.
- Bumped the Spark SDKs and tooling: `@buildonspark/spark-sdk` `0.7.17 → 0.8.1`, `@buildonspark/issuer-sdk` `0.1.35 → 0.1.37`, `dotenv` `^16 → ^17.4.2`, `vitest` `4.1.5 → ^4.1.7`. Consistent caret (`^`) ranges throughout.

### Security

- The `@buildonspark/spark-sdk` 0.8.0 bump enables **signing-operator TLS certificate verification by default**. Earlier SDK versions defaulted to `rejectUnauthorized: false` (TLS-encrypted but certificate-unverified) for signing-operator connections unless a `certPath` was supplied — which this skill never did — leaving that channel open to an active man-in-the-middle. 0.8.x verifies by default; disabling now requires an explicit `SPARK_DANGEROUSLY_DISABLE_TLS_VERIFICATION` flag and is restricted to local (`localhost`/`*.minikube.local`) hostnames.
- The SDK bump also pulled patched transitive dependencies (`protobufjs`, `ws`), clearing two moderate-severity advisories. `npm audit` is now clean.

## 0.1.3 — 2026-05-22

### Security

- `skills/sparkbtcbot/scripts/l402-paywalls.js` no longer logs the Lightning payment preimage. The preimage is the L402 authorization secret (it goes directly into the `Authorization` header); printing even a prefix of it to stdout risked leaking it into an agent's captured transcript.

## 0.1.2 — 2026-05-19

Repo-health and test-coverage release. Published-package contents unchanged from 0.1.0 (no runtime, API, or shipped-file changes).

### Added

- Community-health files: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md` (Contributor Covenant v2.1), `SECURITY.md` with private disclosure to eric@brodie.rocks.
- GitHub Actions CI (`.github/workflows/ci.yml`) running `npm test` on Node 18, 20, and 22 for push and PR against `main`.
- 16 new unit tests (total now 72):
  - `tests/unit/skill-content.test.js` — covers `getSkillContent`, `getReference`, `listReferences`, `skillPath`, `referencesDir`, including a reference-doc anti-drift check against the names promised in the README.
  - `tests/unit/plugin-manifest.test.js` — validates `.claude-plugin/marketplace.json` JSON shape and that every referenced skill path resolves to a real `SKILL.md`.
  - `tests/unit/encrypted-seed.test.js` — adds tests for `loadMnemonicFromEnv` (env-reading + missing-passphrase) and for the unsupported version/kdf/cipher byte rejection paths plus the too-short-file guard.

## 0.1.0 — 2026-05-10

Initial public release.

### Added

- **Encrypted-at-rest BIP39 mnemonic storage** (`lib/encrypted-seed.js`) using scrypt (N=2^17) + AES-256-GCM, zero npm runtime dependencies.
- **Library API** (`import ... from "sparkbtcbot-skill"`):
  - `saveEncryptedMnemonic({ mnemonic, passphrase, path? })`
  - `loadMnemonic({ passphrase, path? })`
  - `loadEncryptedMnemonic` (alias of `loadMnemonic`)
  - `loadMnemonicFromEnv()` — reads `SPARK_PASSPHRASE` / `SPARK_SEED_PATH`
  - `writeMnemonicBackupFile(mnemonic, { dir? })` — writes the one-time mnemonic backup file used by setup
  - `DEFAULT_SEED_PATH` constant (`~/.spark/seed.enc`)
- **Skill-content helpers** for non-Claude LLM frameworks:
  - `getSkillContent()` — returns the always-loaded `SKILL.md` body
  - `getReference(name)` — loads a specific reference doc by name
  - `listReferences()` — lists all available reference doc names
  - `skillPath`, `referencesDir`, `lessonsPath` constants
- **Claude Code plugin marketplace manifest** (`.claude-plugin/marketplace.json`) so the skill is installable via `claude plugin marketplace add` + `claude plugin install`.
- **Skill content** under `skills/sparkbtcbot/`: SKILL.md, LESSONS.md, and 9 reference docs covering architecture, wallet ops, Lightning, tokens, Spark invoices, L402 paywalls, the SparkAgent class, and encrypted-seed setup.
- **Example scripts** under `skills/sparkbtcbot/scripts/` for setup, balance/deposits, payment flow, token operations, the SparkAgent class, and L402 paywalls.
- **Test suite** (vitest, 56 unit tests) covering the encryption library and round-trip behavior.
- TypeScript declarations (`lib/index.d.ts`).

### Security

- File-handoff for fresh-generated mnemonics: the setup script writes the new mnemonic to a persistent file (`~/.spark/MNEMONIC_BACKUP_<random>.txt`, mode 0600) instead of stdout, so Bash-captured stdout from agent contexts doesn't leak the words into conversation transcripts. The user reads, copies offline, and `rm`s the file.
- `wx` flag on encrypted-seed writes — refuses to overwrite an existing seed file.
- Strict mnemonic validation in setup script: exact word counts (12/15/18/21/24), lowercase-alphabetic words only, SDK round-trip verify before any file is written.
- `light-bolt11-decoder` pinned to exact 3.2.0 (single-maintainer dep; pin protects against malicious upstream patch releases).
