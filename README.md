# sparkbtcbot

[![CI](https://github.com/echennells/sparkbtcbot/actions/workflows/ci.yml/badge.svg)](https://github.com/echennells/sparkbtcbot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)

Spark Bitcoin L2 wallet skill for AI agents — give an agent its own Bitcoin wallet so it can send and receive money on its own: pay for an API call, get paid for a task, tip, settle up — or buy real-world things (gift cards, eSIMs, VPNs) from Bitcoin-accepting merchants, with guardrails that verify every invoice against its quote before a sat moves.

Built on [Spark](https://docs.spark.money), a Bitcoin Layer 2 with instant, near-zero-fee transfers and native Lightning support — and fully self-custodial, so the agent holds its own keys. Use it in Claude Code as a plugin, or in any other LLM agent framework via the npm package.

> ⚠️ **Handles real Bitcoin.** Mainnet by default, full custody the moment the seed is decrypted, no server-enforced spending caps — treat the agent like a hot wallet. Use a dedicated wallet holding only an operational float, set `SPARK_DAILY_BUDGET_SATS`, and populate the recipient allowlist; the funded balance is the only limit that survives a compromised process.

> 🤖 **If you are an AI agent, read [`AGENTS.md`](./AGENTS.md) before running any wallet code.** Non-negotiables: never print or echo the mnemonic **or** the passphrase (both control all funds); never run `npm run reveal-mnemonic` yourself; and if you `git clone`/`npm install` for the user, offer supply-chain hardening **first**. Full behavioral guidance is in [`SKILL.md`](./skills/sparkbtcbot/SKILL.md).

**Best for:** autonomous agents that send/receive small amounts — pay per API call, get paid for a task, tip, settle up — plus dev/test on REGTEST and trusted agents you control.
**Not for:** custody of large balances, or anything needing hard server-enforced spending caps or revocable access — no such enforcement exists on this path.

## What is Spark?

Spark is a Bitcoin Layer 2 that lets you send and receive Bitcoin instantly with low fees. Spark-to-Spark transfers are free, and Lightning interop costs 0.15–0.25%. It is fully self-custodial — you hold your own keys via a BIP39 mnemonic — and fully interoperable with the Lightning Network. Spark currently has a small number of infrastructure providers (Signing Operators), so there is some risk of downtime, and it requires trusting that at least one operator behaves honestly during transfers.

## Why Spark for Agents?

- **Simple setup** — Generate a mnemonic and you have a wallet. No accounts, no API keys, no approval process.
- **No server required** — The SDK connects directly to the Spark network. No node to run, no infrastructure to maintain.
- **No channel management** — Unlike Lightning, there are no channels to open, fund, or rebalance. Just send and receive.
- **Low fees** — Spark-to-Spark transfers are free. Lightning payments cost 0.15–0.25%. Compare that to on-chain fees of 200+ sats or card processing at 2–3%.

## Capabilities

- **Wallet Setup** — Generate or import wallets from a BIP39 mnemonic
- **BTC Balance & Deposits** — Check balance, generate L1 deposit addresses, claim deposits
- **Spark Transfers** — Instant, zero-fee BTC transfers between Spark wallets
- **Lightning Invoices** — Create and pay BOLT11 invoices for Lightning compatibility
- **Spark Invoices** — Native invoices payable in sats or BTKN tokens
- **Token Operations** — Transfer BTKN/LRC20 tokens, batch transfers, token invoices
- **Withdrawal** — Cooperative exit back to L1 Bitcoin with fee estimation
- **Message Signing** — Prove identity via cryptographic signatures
- **L402 Paywalls** — Pay-per-request APIs via Lightning. Preview costs, pay invoices, cache tokens.
- **Merchant Purchases** — Buy real-world goods and services (gift cards via [Bitrefill](https://www.bitrefill.com), eSIMs/VPNs/burner numbers via [nadanada](https://nadanada.me), 10,500+ brands including flights and hotels via [Cryptorefills](https://www.cryptorefills.com)) over Lightning, governed by a shared payment policy: invoice-vs-quote verification, amount ceilings, confirm-before-buy, PII consent, bearer-secret handling. Live-validated with real purchases at all three.
- **First Spend** — The path for someone who doesn't know Bitcoin: a fiat-denominated Lightning invoice their friend can pay (live rate from two cross-checked sources), then a country-aware gift card sized under the balance with fees counted (`references/first-spend.md`)
- **Wallet Privacy** — Spark wallets are publicly readable by default (balance + full history by address); setup and every boot enable the per-wallet privacy setting (`SPARK_PRIVACY=off` opts out; token balances stay public)
- **Unilateral-Exit Backup** — Auto-maintained `spark.unilateral-exit-bundle.v1` recovery bundle, consumed by Blink's [spark-unilateral-exit](https://github.com/blinkbitcoin/spark-unilateral-exit) tool if the operators ever go dark. Verify with `npm run leaf-vault -- verify`.

## Installation

Two install paths depending on your stack.

**Tested setups.** No lock-in to one model or harness — the wallet, merchant, and bridge flows have been run end-to-end on real mainnet sats under both:

- **[Claude Code](https://claude.com/claude-code)** (recommended) — native plugin install below; `SKILL.md` loads automatically.
- **[opencode](https://opencode.ai)** running **GLM-5.2 via [OpenRouter](https://openrouter.ai)** — clone-the-repo path; opencode picks up the rules in [`AGENTS.md`](./AGENTS.md) automatically.

Anything that can load the skill content should work the same way (Cursor, LangChain, OpenAI Agents SDK, your own harness — see the npm package below); those two are the stacks we've validated with real purchases and withdrawals.

### Claude Code

```bash
claude plugin marketplace add https://github.com/echennells/sparkbtcbot
claude plugin install sparkbtcbot
```

Native plugin install. Updates flow through `claude plugin update sparkbtcbot`. Claude reads `SKILL.md` automatically when the skill triggers.

### Any other LLM agent framework (Cursor, LangChain, OpenAI Agents SDK, Aider, etc.)

```bash
npm install --ignore-scripts sparkbtcbot-skill
```

The package ships both the skill content (so you can load it into your LLM's context) and the encryption library (so generated code can import the helpers). Minimal use:

```javascript
import { getSkillContent, getReference, listReferences } from "sparkbtcbot-skill";

// Always-loaded skill body — pass to your framework's system-prompt mechanism
const instructions = await getSkillContent();

// On-demand reference docs by name
console.log(await listReferences());
// → ['agent-class', 'architecture', 'bitrefill', 'cryptorefills',
//    'encrypted-seed', 'extras', 'first-spend', 'l402', 'lightning',
//    'merchant-spending', 'nadanada', 'recovery-scenarios', 'security',
//    'spark-invoices', 'supply-chain', 'tokens', 'unilateral-exit', 'wallet']
const l402Doc = await getReference("l402");
```

Generated code (or your own glue) can also import the encryption helpers:

```javascript
import { saveEncryptedMnemonic, loadMnemonicFromEnv } from "sparkbtcbot-skill";

await saveEncryptedMnemonic({ mnemonic, passphrase, path: "./seed.enc" });
const decrypted = await loadMnemonicFromEnv(); // reads SPARK_PASSPHRASE
```

And the unilateral-exit backup (the "leaf-vault") via its subpath export:

```javascript
import { enableLeafVault, snapshotLeafVault, verifyVault } from "sparkbtcbot-skill/leaf-vault";

const vault = enableLeafVault(wallet); // auto-refreshing recovery bundle
// ... later: await vault.dispose();   // flushes a final snapshot if needed
```

(The SDK-free persistence/validation core behind it is also exported directly as `sparkbtcbot-skill/leaf-vault/core`, for code that handles bundles without a wallet instance.)

The package also ships a single `sparkbtcbot` CLI (0.6.1+; subcommands replaced the five per-command bins), so npm consumers and Claude Code plugin users never need the cloned repo — install the package into your project, then the command resolves **locally** (your lockfile governs what runs; no unpinned registry fetch):

```bash
npm install --ignore-scripts sparkbtcbot-skill    # once, in your project
npm exec --no -- sparkbtcbot setup                # one-time wallet bootstrap
npm exec --no -- sparkbtcbot reveal-mnemonic      # user-run seed backup (refuses non-interactive)
npm exec --no -- sparkbtcbot leaf-vault verify
npm exec --no -- sparkbtcbot viewer grant <pubkey> # one read-only key for a private wallet (asks y/N; spark-sdk ≥0.12)
npm exec --no -- sparkbtcbot help                 # full subcommand list
```

`--no` is deliberate: plain `npx sparkbtcbot ...` falls back to **fetching the registry package named after the command you typed** if the local bin isn't found (wrong directory, package not installed). Since 0.6.1 the name `sparkbtcbot` is project-owned — a reservation stub that only prints an error — so even that fallback can't run a stranger's code; before the 0.6.0 collapse, the five per-command bin names were five separate unregistered names, and they remain decommissioned and unclaimed (see [SECURITY.md](./SECURITY.md)). `npm exec --no` is the right form because it fails instead of fetching (npm may still make a registry *metadata* request — you'll see a 404 or "npx canceled due to missing packages" — but nothing is installed and nothing executes; verified on npm 10 and 12).

Do not rely on refusing npx's install prompt: **npx only prompts on an interactive terminal.** With no TTY — a CI job, a script, or an AI agent running commands for you — it installs and executes silently. That is why the safe forms are `npm exec --no` and `./node_modules/.bin/sparkbtcbot` rather than a rule about answering "no".

`--ignore-scripts` is deliberate too: one production dependency (`protobufjs`) runs code at install time, before your code imports anything. The package and the Spark SDK both work fully without it. In a project that already has a lockfile, prefer `npm ci --ignore-scripts` — `npm ci` runs the full install lifecycle just like `npm install`, so the flag is required there too.

After `sparkbtcbot setup`, persist the passphrase you chose: the runtime reads `SPARK_PASSPHRASE` from its environment at boot (dotenv loads the `.env` in the directory your app runs from). Setup deliberately writes it nowhere — the encrypted seed lands in `~/.spark/seed.enc`, and keeping the passphrase out of that directory is the point.

### Local clone (for running the example scripts and tests yourself)

```bash
git clone https://github.com/echennells/sparkbtcbot.git ~/sparkbtcbot
cd ~/sparkbtcbot
npm ci --ignore-scripts   # lockfile-exact install; fails loudly on any drift
npm test   # offline unit suite — verifies the resolved tree matches the one we live-tested
```

Don't clone directly into `~/.claude/skills/` — this repo nests the skill at `skills/sparkbtcbot/`, so the clone would put `SKILL.md` a level too deep and Claude Code won't discover it. If you want the clone to double as a personal skill (instead of the plugin install), symlink the inner skill directory:

```bash
ln -s ~/sparkbtcbot/skills/sparkbtcbot ~/.claude/skills/sparkbtcbot
```

The Quick Start below assumes this path — useful if you want to kick the tires on the example scripts (`npm run example:balance` etc.) before integrating.

## Quick Start

```bash
# Install dependencies (in the cloned repo; lockfile-exact), then verify:
cd ~/sparkbtcbot
npm ci --ignore-scripts
npm test   # offline; a red suite means the installed tree isn't the tested one — stop there

# Copy env template, set SPARK_PASSPHRASE (>=12 chars)
cp .env.example .env
$EDITOR .env

# One-time setup: generate a wallet, encrypt the mnemonic at ~/.spark/seed.enc.
# The 12 words are NOT printed and NOT written to disk in plaintext.
npm run setup

# Back up the mnemonic offline. Run this in YOUR OWN terminal (it refuses to run
# non-interactively so it can't be captured into an agent's transcript):
npm run reveal-mnemonic          # decrypts seed.enc, prints the 12 words once
# copy them to paper / password manager / hardware backup. No file to delete.

# Run the examples
npm run example:balance
npm run example:payments
```

The mnemonic is **never** stored in plaintext anywhere the runtime reads. `npm run setup` writes an encrypted seed file (`~/.spark/seed.enc`, mode 0600); the runtime reads `SPARK_PASSPHRASE` from env and decrypts it once at boot. To back up the words offline, run `npm run reveal-mnemonic` in your own terminal — it decrypts the seed and prints the mnemonic once, and **refuses to run non-interactively** so it can't be captured into an AI agent's transcript. See `skills/sparkbtcbot/references/encrypted-seed.md` for the threat model and recovery scenarios.

## Example Scripts

| Script | npm script | Purpose |
|--------|------------|---------|
| `setup-encrypted-seed.js` | `npm run setup` | Generate wallet, encrypt mnemonic at rest |
| `balance-and-deposits.js` | `npm run example:balance` | Check balance (BTC + tokens), get deposit addresses |
| `payment-flow.js` | `npm run example:payments` | Lightning invoices, Spark invoices, fee estimation |
| `token-operations.js` | `npm run example:tokens` | BTKN token balances, transfers, batch operations |
| `l402-paywalls.js` | `npm run example:l402` | Access L402 pay-per-request APIs via Lightning |
| `spark-agent.js` | `npm run example:agent` | Complete `SparkAgent` class with all capabilities |

The `npm run` shortcuts exist only in the cloned repo. npm-package consumers get the same scripts under `node_modules/sparkbtcbot-skill/skills/sparkbtcbot/scripts/` — run them directly, e.g. `node node_modules/sparkbtcbot-skill/skills/sparkbtcbot/scripts/balance-and-deposits.js`.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SPARK_PASSPHRASE` | Yes | Passphrase (≥12 chars) that decrypts the seed file at boot. Set during `npm run setup`. |
| `SPARK_NETWORK` | No | `MAINNET` (default), `REGTEST`, `TESTNET`, `SIGNET` |
| `SPARK_SEED_PATH` | No | Override for the encrypted-seed file location. Defaults to `~/.spark/seed.enc`. |

## Dependencies

```bash
npm install --ignore-scripts sparkbtcbot-skill   # brings the pinned SDK + helpers with it
```

## Security

**Passphrase + seed file = full wallet access.** Either alone is useless; both together control all funds. There is no permission scoping, no spending limits, no read-only mode in the SDK.

Recommendations:
- Never expose the mnemonic or passphrase in code, logs, or version control
- Treat `SPARK_PASSPHRASE` like any production secret (deployment secret manager, `.env` in `.gitignore`, etc.)
- Dependencies are **pinned to exact versions** — you get the tree we live-tested (the recovery backup reaches into SDK internals validated per-version). Tradeoff, stated plainly: upstream security patches reach you when *we* cut a release, not immediately; Dependabot watches this repo, and `npm audit` runs in CI on every push.
- **Use a current npm (`npm install -g npm@latest`).** Prefer **v12+** — it disables package install/lifecycle scripts by default, killing the `postinstall` supply-chain attack class (runs on Node `^22.22.2 || ^24.15.0 || >=26`, but **no Node bundles it** — upgrade explicitly); otherwise **11.10.0+** is the floor where the package-cooldown age-gate (`min-release-age`) enforces at all. **On Node 20 install `npm@11` explicitly** — `npm@latest` resolves to 12 regardless of your Node and installs anyway (engine mismatches are only a warning), leaving you on an npm your Node doesn't support. Distro-packaged npm (Ubuntu `apt` ships ~9.x even alongside Node 22 LTS) runs years behind and silently ignores hardening keys, so upgrade rather than trust the system npm. The hardening config itself lives in the [`supply-chain-hardening`](https://github.com/echennells/supply-chain-hardening) repo.
- Don't bundle `seed.enc` into container images that ship alongside the passphrase
- Use a dedicated wallet with limited funds for each agent
- Use separate `accountNumber` values for different funding tiers
- Back up the **mnemonic** offline — the encrypted seed file is not a substitute for an offline seed backup
- No server-enforced limits exist on this path: the funded balance is the hard cap. Keep it small and sweep earnings out regularly

## Resources

- [Spark Docs](https://docs.spark.money)
- [Spark SDK (npm)](https://www.npmjs.com/package/@buildonspark/spark-sdk)
- [Sparkscan Explorer](https://sparkscan.io)

## Disclaimer

This software is provided **as is, without warranty of any kind**, express or implied — see [`LICENSE`](./LICENSE) for the full text. Running it is your decision and your risk.

- **It moves real money, irreversibly.** Bitcoin transactions cannot be reversed, cancelled, or charged back. A wrong address, a lost passphrase, or a compromised host means the funds are gone, and no one — including the author — can recover them.
- **No custody, no access, no recourse.** The author never holds your keys, seed, passphrase, or funds, runs no service on your behalf, and has no ability to freeze, refund, or reverse anything. This is a client-side library, not a financial service, an exchange, or a money transmitter.
- **The guardrails are best-effort, not security boundaries.** `SPARK_DAILY_BUDGET_SATS`, the recipient allowlist, invoice-vs-quote verification, and the TTY refusal in `reveal-mnemonic` lower the odds of a bad outcome. They do not enforce anything against a determined attacker or a confused agent — LLMs are non-deterministic and can be prompt-injected, and any process holding the decrypted seed has full spending authority.
- **Third parties are outside our control.** The Spark protocol and its Signing Operators, the SSP, the Lightning Network, and merchants such as Bitrefill, nadanada, and Cryptorefills each carry their own risk of downtime, censorship, fee changes, loss, or shutdown. Integration here is not endorsement, and no ongoing diligence is performed on any of them.
- **Nothing here is financial, investment, tax, or legal advice.** Whether running an autonomous Bitcoin wallet is lawful where you are — and how what it does gets reported and taxed — is yours to determine.
- **Pre-1.0.** APIs, file formats, and defaults change between releases. Pin a version.

Fund the wallet with an operational float you can afford to lose entirely, and no more.

## License

MIT
