# Install, configure, load

Load this before running `setup`, writing `.env`, or scaffolding the code that opens the wallet. It covers every path the skill text arrives by (plugin, clone, npm), the one-time bootstrap, `.env`, loading the seed in code, and container gotchas. The three setup scenarios (fresh / migrate / import) in depth and the seed file's threat model are in `references/encrypted-seed.md`.

## Required libraries

```bash
npm install @buildonspark/spark-sdk@^0.12.0 dotenv
```

For token issuance (minting new tokens), additionally:
```bash
npm install @buildonspark/issuer-sdk@^0.1.48
```

### Supply-chain hardening — only when *you* run the install

If you are running `git clone … && npm install` on the user's behalf, load `references/supply-chain.md` first: it says when to offer npm hardening (ask; persistent `~/.npmrc` vs ephemeral `NPM_CONFIG_*`), where the settings live (the `echennells/supply-chain-hardening` repo, never here), and that npm version is best-effort, never a gate on wallet setup. Not applicable to the plugin path or a user's own `npm install`.

## Setup

The mnemonic is **never** stored in plaintext. The skill encrypts it at rest with a passphrase the user provides; the running app reads `SPARK_PASSPHRASE` from env and decrypts the seed file once at boot. There is no plaintext-mnemonic-in-`.env` mode.

### One runtime, however the skill text arrived

This skill text reaches you via the Claude Code plugin, the cloned repo, or the npm package — but the **runtime is always the `sparkbtcbot-skill` package installed in the user's own project**, pinned by their lockfile:

```bash
npm install --ignore-scripts sparkbtcbot-skill # once, in the user's project
npm exec --no -- sparkbtcbot setup            # resolves LOCALLY from node_modules/.bin — one-time bootstrap
npm exec --no -- sparkbtcbot reveal-mnemonic  # USER runs, own terminal
npm exec --no -- sparkbtcbot leaf-vault verify
```

**Local resolution is the point**: `npm exec --no` refuses to install rather than fetching, so the version the user's lockfile pins is the version that runs. An unpinned registry pull at wallet-bootstrap time bypasses that lockfile and any hardening policy — the wrong default for a wallet. `--ignore-scripts` is deliberate: `protobufjs` runs code at *install* time, before anything is imported; the package works without it. Use it with `npm ci` too — plain `npm ci` runs scripts.

> ⚠️ **`npx` does NOT fail closed — and it does not always ask.** If the local bin is missing (package not installed, or you're in the wrong directory — a real risk for the reveal handoff, which happens in a *fresh* terminal), a bare `npx <cmd>` fetches the registry package **named after the command you typed** and runs it. On an interactive terminal it prompts first. **With no TTY — which is how you run commands — there is no prompt: it installs and executes silently.** So the rule is not "refuse the prompt", because you will never see one. The rule is: **never run a bare `npx` for a wallet command.** Use `npm exec --no -- sparkbtcbot <command>` (refuses to install — a metadata 404 or `npx canceled due to missing packages` may print, but nothing executes) or `./node_modules/.bin/sparkbtcbot`, and never pass `-y`/`--yes`. (The pinned `npx --package=` form is for a human at a terminal, not for you — see README.) In a **cloned repo** the `npm run setup` / `npm run reveal-mnemonic` / `npm run leaf-vault` forms are equivalent — and after `npm ci` there, run `npm test` (offline) before wallet code: a red suite means the installed tree isn't the tested one. **NEVER install anything into the plugin cache** (`~/.claude/plugins/cache/...` — versioned, wiped on update) and never point the user's seed/config at it; the cache is skill text only.

### Step 1: Run setup

`npm run setup` (cloned repo) or `npm exec --no -- sparkbtcbot setup` (from the project where `sparkbtcbot-skill` is installed — see above) is the one-time bootstrap. It encrypts a BIP39 mnemonic with the user's passphrase (≥12 chars; prompted on stderr if `SPARK_PASSPHRASE` is unset) and writes `~/.spark/seed.enc` (mode 0600). Three scenarios — full commands and the migration walkthrough are in `references/encrypted-seed.md` → Setup:

- **A) Fresh wallet** (default): the SDK generates a new mnemonic, the script encrypts it.
- **B) Migrate from a pre-existing `SPARK_MNEMONIC` in `.env`**: add `SPARK_PASSPHRASE`, run setup, then delete the `SPARK_MNEMONIC` line. Never pass the mnemonic inline on a command line (shell history).
- **C) Import from paper/hardware backup**: `npm run setup -- --import` — prompts on stderr, no history exposure.

The script verifies by initializing a wallet from the encrypted seed and printing the Spark address — sanity check that the right wallet loaded.

**Fresh-generate mode never writes the mnemonic to disk in plaintext, and never prints it to stdout.** When scenario A runs, the new 12-word mnemonic is stored only inside the encrypted `seed.enc`. It is not printed (stdout from a tool call is captured into the transcript) and no plaintext backup file is written. Backup is on-demand via `reveal-mnemonic`.

After running setup, relay this to the user — the words never pass through you:
1. In **their own** terminal, run: `npm run reveal-mnemonic` (cloned repo) or `npm exec --no -- sparkbtcbot reveal-mnemonic` (from the project directory where `sparkbtcbot-skill` is installed and `.env` lives). It decrypts `seed.enc` and prints the 12 words, and refuses to run non-interactively, so it can't be captured into this chat.
2. Copy the words to paper, a password manager, or a hardware-wallet seed backup. This is the only recovery path — the encrypted seed file is **not** a substitute for the offline backup.
3. Nothing to delete — no plaintext file was created.

Default to that flow. If the user explicitly asks you to show them the mnemonic *here* (no separate terminal), see the rules in SKILL.md — and note `reveal-mnemonic` requires a TTY, so the clean options are for them to run it, or to accept the transcript exposure knowingly.

See `references/encrypted-seed.md` for the threat model, file format, and recovery scenarios.

**Compatibility warning:** seed phrases are NOT portable across Spark integrations (different key derivations — e.g. Tether's WDK). If a user provides a seed from another Spark wallet, ask where it was generated before importing; a foreign one yields a different, empty wallet. Detail: `references/encrypted-seed.md` → Seed compatibility.

### Step 2: Configure `.env`

```
SPARK_PASSPHRASE=<the same passphrase used in step 1>
SPARK_NETWORK=MAINNET
# SPARK_SEED_PATH=/custom/path/seed.enc  # optional override
```

**Security warnings:**
- **Never log the mnemonic or the passphrase** — not even during development. To verify the wallet loads, compare *addresses*, never seed words.
- **Never commit `.env`** — add it to `.gitignore` first. The seed file (`~/.spark/seed.enc`) is sensitive too: mode 0600, keep it out of images/backups that travel with the passphrase.
- **REGTEST is available for testing** — point a throwaway mnemonic at REGTEST (`SPARK_NETWORK=REGTEST`) to exercise flows without real funds. For production with real funds, keep the balance to an operational float (see SKILL.md → Custody Model). **⚠️ The same seed is a _different wallet_ on REGTEST vs MAINNET:** the SDK defaults `accountNumber` to 0 on REGTEST and 1 on MAINNET, so if you test then switch networks without setting it explicitly, your MAINNET wallet shows a different address and 0 balance. Set `accountNumber` explicitly to carry the same wallet across networks (see the note below).

**Note on `accountNumber`:** defaults to 1 for MAINNET, 0 for REGTEST. If you reuse the same mnemonic across networks, set `accountNumber` explicitly to avoid address mismatches.

### Step 3: Load the wallet in code

**All the lib helpers ARE published to npm** — `sparkbtcbot-skill` ships `lib/` and exports it: `import { loadMnemonicFromEnv, checkInvoiceAgainstQuote, lightningFeeCap, createSpendLedger } from "sparkbtcbot-skill"`. **When scaffolding a user's project, add the package as a dependency and import from it** — that's the one supported answer on every install path (the Claude Code plugin cache is NOT importable and is wiped on update; never reference it from generated code). This matters most for the guard helpers (`fee-guards`, `bolt11`, `spend-ledger`, the allowlist): hand-rolled or copy-pasted versions rot and re-introduce fixed bugs. Copy a file into the project only as a last resort when adding a dependency is impossible — `lib/encrypted-seed.js` is the least-bad one to copy (no dependencies beyond `node:crypto`), the guards are the worst.

```javascript
import "dotenv/config";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { loadMnemonicFromEnv } from "./lib/encrypted-seed.js";

const mnemonic = await loadMnemonicFromEnv(); // reads SPARK_PASSPHRASE, decrypts seed.enc
const { wallet } = await SparkWallet.initialize({
  mnemonicOrSeed: mnemonic,
  options: { network: process.env.SPARK_NETWORK || "MAINNET" },
});

const address = await wallet.getSparkAddress();
const identityKey = await wallet.getIdentityPublicKey();
const { satsBalance } = await wallet.getBalance();

console.log("Spark Address:", address);
console.log("Identity Key:", identityKey);
console.log("Available:", satsBalance.available.toString(), "sats");

await wallet.cleanup();
```

**One-shot scripts that move value:** after a claim/pay/transfer/withdraw the SDK starts a *detached* background leaf-optimization job. Calling `cleanup()` right away interrupts it — the SDK logs `Claim transfer process was interrupted due to cleanup`. **No funds are lost** (the op already settled; optimization resumes on next init), but for a short-lived script that moves value then exits, initialize it with `options: { network, optimizationOptions: { auto: false } }` so there's nothing to interrupt — or let it settle a few seconds before `cleanup()`. Long-running agents keep the wallet open and don't hit this. See `references/wallet.md` → Cleanup.

Decrypt happens once at boot (~250ms scrypt). Hold the wallet — do not call `loadMnemonicFromEnv()` per request.

### Running setup in sandboxed / constrained environments

Container/sandbox gotchas (run setup from the directory holding `.env` — dotenv resolves from cwd, and a wrong cwd surfaces as "incorrect passphrase"; `~` must be writable or override `SPARK_SEED_PATH`; missing-SDK import errors on the plugin path mean use the npx CLI form above). Full troubleshooting: `references/encrypted-seed.md` → Sandboxed environments.
