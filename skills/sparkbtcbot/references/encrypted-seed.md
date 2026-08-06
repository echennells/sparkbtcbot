# Encrypted seed at rest

This is how the skill stores the BIP39 mnemonic. Load this file when the user is configuring a new wallet, debugging a missing-seed error, planning recovery, or asking what `SPARK_PASSPHRASE` and `~/.spark/seed.enc` are for.

## What it does

The mnemonic is encrypted with a passphrase you choose and stored in a single file (default: `~/.spark/seed.enc`, mode 0600). Your application reads `SPARK_PASSPHRASE` from env, decrypts the file once at boot, and uses the mnemonic in memory. The mnemonic itself is never written to `.env` or any other plaintext file the runtime cares about.

## Threat model

What attacks fail vs what still drains the wallet:

| Leak vector | Outcome |
|---|---|
| `.env` accidentally committed to git | Attacker has passphrase only — useless without seed file |
| Env-var dump in logs | Attacker has passphrase only — useless without seed file |
| Casual `cat .env` snooping | Passphrase only, useless |
| Server backup that captures env vars only | Useless without seed file |
| Server backup that captures full disk | Both files — only passphrase strength saves you |
| Memory dump while wallet running | Funds drained (mnemonic is in process memory after decrypt) |

To drain funds an attacker needs **either** the seed file plus the passphrase together, **or** to dump the running process's memory.

## Crypto choices

- **scrypt** for key derivation: N=2^17, r=8, p=1. Memory-hard, OWASP-blessed for password hashing. Roughly 250ms on a modern CPU; intentionally slow to make brute-force expensive.
- **AES-256-GCM** for encryption: 256-bit key, 96-bit IV, 128-bit auth tag. Authenticated — wrong passphrase or tampered ciphertext is detected.
- All from Node's built-in `node:crypto`. Zero extra dependencies.

File format (49+ bytes):
```
1   byte   version (0x01)
1   byte   kdf id (0x01 = scrypt)
1   byte   cipher id (0x01 = aes-256-gcm)
1   byte   reserved (0x00)
16  bytes  salt
12  bytes  iv (gcm nonce)
16  bytes  auth tag
N   bytes  ciphertext
```

The version + KDF id + cipher id at the start means the file is self-describing; future versions can be added without breaking old files.

## Setup

`npm run setup` is the single entry point. Three scenarios depending on where the mnemonic comes from:

**Scenario A — Fresh wallet.** No flag, no `SPARK_MNEMONIC` env var. The SDK generates a new BIP39 mnemonic and the script encrypts it. The words are never printed and never written to disk in plaintext — back them up on demand with `npm run reveal-mnemonic` (below).
```bash
SPARK_NETWORK=MAINNET SPARK_PASSPHRASE="..." npm run setup
```

**Scenario B — Migrate from a pre-existing `SPARK_MNEMONIC` in `.env`.** Intended as a one-time migration path for users coming from a pre-existing plaintext `.env`. Leave the existing `SPARK_MNEMONIC` line in `.env`, add `SPARK_PASSPHRASE`, then run `npm run setup`. dotenv loads both, the script encrypts, and afterward you remove the `SPARK_MNEMONIC` line. Don't pass the mnemonic inline on the command line — it lands in shell history.
```bash
npm run setup
```

**Scenario C — Import an existing mnemonic from paper / hardware backup.** The script prompts on stderr (no shell-history exposure) for the mnemonic. Use this when bringing a mnemonic from a hardware wallet, paper backup, or another machine.
```bash
SPARK_PASSPHRASE="..." npm run setup -- --import
```

The passphrase must be at least 12 characters. If `SPARK_PASSPHRASE` is unset the script prompts on stderr (with confirmation).

> Implementation note: the script checks scenarios in **C → B → A** order (`--import` flag wins over `SPARK_MNEMONIC` env, which wins over fresh-generate). This order doesn't matter for users picking one path deliberately, but it determines what happens if multiple inputs are present.

After setup completes:

1. The seed file is at `~/.spark/seed.enc` (override with `SPARK_SEED_PATH`)
2. `SPARK_PASSPHRASE` needs to remain available to the runtime — keep it in `.env` (gitignored) or your deployment's secret manager. If you set it inline only for the setup invocation, add it to `.env` now.
3. **If a fresh mnemonic was generated** (scenario A), the 12 words live only inside `seed.enc` — not printed, not written to disk in plaintext. To back them up, the user runs, **in their own terminal**:
   ```bash
   npm run reveal-mnemonic
   ```
   It decrypts `seed.enc` and prints the words once. It **refuses to run unless both stdin and stdout are real TTYs** (an agent capturing output over the Bash tool, CI, or a pipe is refused) and asks a y/N confirmation first — which stops the *accidental* capture into an agent's transcript. That check is a backstop, not a guarantee: an agent that allocates a full pseudo-terminal could still capture it, and nothing can make "print a secret to a terminal the caller controls" safe. So the real rule is behavioral — **the agent must not run `reveal-mnemonic`; it tells the user to run it.** Copy the words to offline backup (paper / password manager / hardware backup); there is no plaintext file to delete. (Earlier versions wrote a persistent `MNEMONIC_BACKUP_*.txt`; that was removed because it left a plaintext seed on disk until the user manually `rm`'d it.)
4. If you migrated from a plaintext `.env` (scenario B), remove `SPARK_MNEMONIC` from `.env`.

The script verifies by initializing a wallet from the encrypted seed and printing the resulting Spark address — useful as a sanity check that the right wallet loaded.

## Seed-bound policy (v2 seed files)

The guard files are agent-writable — `rm ~/.spark/spend-ledger.json` used to silently restore the full daily budget, and truncating it to an empty ledger was the smarter version of the same attack. Binding the policy to the seed closes that class:

- **The policy lives inside the encrypted payload.** `npx sparkbtcbot-set-policy` (user-run, TTY-gated, needs the passphrase) rewrites `seed.enc` as **v2**: the ciphertext holds `{ mnemonic, policy: { dailyBudgetSats } }`. It inherits the seed's protections — reading needs the passphrase, tampering fails the GCM tag, and deleting it deletes the wallet. The agent can't remove the budget without removing the money. A seed-bound budget **wins over `SPARK_DAILY_BUDGET_SATS` absolutely** (the env var is agent-writable; the boot warns if they disagree).
- **The ledger becomes HMAC-signed.** The signing key derives from the mnemonic via HKDF (its own context — never the AES key). Under a bound policy: missing ledger → throws; unsigned/replaced ledger → throws; edited entries → signature fails → throws. The legitimate reset is `npx sparkbtcbot-reset-ledger` — it needs the passphrase, which is exactly what lets the code tell reset from attack (previously `rm` was both).
- **v1 files are unchanged.** No policy → setup keeps writing v1, env-var budget semantics apply, the ledger stays unsigned. Nothing changes for wallets that don't opt in.

**Honest limits** (the bar moves from `rm` to code execution — not to impossibility): an agent steered into *executing code* can re-derive the key or rebuild an unbound seed (it holds passphrase + mnemonic in-process); **replay** — restoring a snapshotted, validly-signed old ledger — rolls the window back and is undefendable client-side; and guards only bind wrapper calls (raw SDK calls bypass them). The funded balance remains the only cap that survives everything.

## Seed compatibility — not all "Spark wallets" derive the same keys

Seed phrases are not portable across all Spark integrations. The Spark SDK uses its own internal key derivation, while other implementations (e.g., Tether's WDK) use custom BIP-44 derivation paths (`m/44'/998'/...`). Importing a mnemonic generated by a different Spark wallet integration will produce different keys and a different wallet — the funds won't appear. If a user provides a seed phrase, ask where it was generated. If it came from a Tether/WDK-based wallet, it won't work here — they need to transfer funds to a wallet created with the Spark SDK directly.

## Running setup in sandboxed / constrained environments

A few rough edges that bite agents running in containers, devcontainers, or sandboxes:

- **Working directory matters.** The setup script's `dotenv/config` import resolves `.env` relative to `process.cwd()`, not the script's location. Run from the project root (the directory containing `.env`). If you `cd` somewhere else first, `.env` won't load and `SPARK_PASSPHRASE` will be empty — the symptom is "incorrect passphrase or corrupted seed file".
- **`~` must be writable.** The default seed path is `~/.spark/seed.enc`. In some sandboxes `$HOME` is read-only or set to an unexpected location (e.g., `HOME=/workspace` with `/workspace/.spark/` not writable). If the default fails, override with `SPARK_SEED_PATH=/tmp/spark/seed.enc` (or any writable path).
- **Module resolution.** Node walks up from the script's file path looking for `node_modules`. If the SDK imports fail (`Cannot find module '@buildonspark/spark-sdk'`), the script is being run from outside a tree that has the dependencies installed. On the **plugin path this is guaranteed** — the plugin cache ships no `node_modules` — so run the CLI from the user's project where `sparkbtcbot-skill` is installed (`npx sparkbtcbot-setup` — local resolution). On a cloned repo, run from the repo (where `npm install` already ran) or install the deps in the target project first.

## App usage

```javascript
import "dotenv/config";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { loadMnemonicFromEnv } from "./lib/encrypted-seed.js";

const mnemonic = await loadMnemonicFromEnv(); // reads SPARK_PASSPHRASE
const { wallet } = await SparkWallet.initialize({
  mnemonicOrSeed: mnemonic,
  options: { network: process.env.SPARK_NETWORK || "MAINNET" },
});
// `mnemonic` falls out of scope; only `wallet` is retained
```

The decrypt happens once at boot (~250ms scrypt). After that, performance is identical to in-memory mnemonic loading. Do not call `loadMnemonicFromEnv()` per request — decrypt once, hold the wallet.

## Recovery scenarios

| Scenario | What's needed | Action |
|---|---|---|
| Lose passphrase | Mnemonic backup | Re-run setup with `--import`, paste mnemonic, choose new passphrase |
| Lose `seed.enc` | Mnemonic backup | Re-run setup with `--import`, paste mnemonic |
| Lose entire machine | Mnemonic backup | Install on new machine, re-run setup with `--import` |
| Lose mnemonic backup | Have passphrase + `seed.enc` | Decrypt to recover mnemonic, save offline this time |
| Lose all three | None | Funds gone |

Restoring from the mnemonic recovers **cooperative** access (operators online). The unilateral-exit path additionally needs the wallet's local leaf material — the pre-signed transactions operators hand out at claim/transfer time — which is not derivable from the mnemonic. See SKILL.md's exit-cost section.

The mnemonic remains the ultimate backup. Encryption defends the seed file at rest; it doesn't replace offline backup of the seed words.

## What this does not do

- **Doesn't protect against memory dumps** of the running process — the mnemonic is in memory after `loadMnemonicFromEnv()` returns. To attack this an attacker needs shell on the host with the same UID as the agent.
- **Doesn't protect against the host being compromised** while running — same as above.
- **Doesn't provide scoped or revocable access.** Encryption-at-rest is all-or-nothing: whoever can decrypt the seed has full custody, and access can't be revoked without sweeping to a new wallet.

## When this skill alone is not enough

Encryption-at-rest is the minimum bar this skill enforces, and it has **no server-side variant** — no scoped tokens, no server-enforced caps, no shared wallet views, no audit log. If any of these describe your setup, this skill alone is not sufficient custody infrastructure; keep the balance here to an operational float and hold the rest elsewhere:

- Non-trivial balances (rule of thumb: more than you'd lose without changing your day)
- Multiple agents needing access to the same funds
- A need for revocable or role-scoped access instead of all-or-nothing custody
- A need for spending caps that survive a compromised agent process
- A need for an audit trail of every wallet operation
