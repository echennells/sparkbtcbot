# Changelog

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
