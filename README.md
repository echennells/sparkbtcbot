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
npm install sparkbtcbot-skill
```

The package ships both the skill content (so you can load it into your LLM's context) and the encryption library (so generated code can import the helpers). Minimal use:

```javascript
import { getSkillContent, getReference, listReferences } from "sparkbtcbot-skill";

// Always-loaded skill body — pass to your framework's system-prompt mechanism
const instructions = await getSkillContent();

// On-demand reference docs by name
console.log(await listReferences());
// → ['agent-class', 'architecture', 'encrypted-seed', 'extras', 'l402',
//    'lightning', 'recovery-scenarios', 'security', 'spark-invoices',
//    'tokens', 'unilateral-exit', 'wallet']
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

The package also ships the setup/backup CLIs (0.4.2+), so npm consumers and Claude Code plugin users never need the cloned repo — install the package into your project, then the commands resolve **locally** (your lockfile governs what runs; no unpinned registry fetch):

```bash
npm install sparkbtcbot-skill      # once, in your project
npx sparkbtcbot-setup              # one-time wallet bootstrap
npx sparkbtcbot-reveal-mnemonic    # user-run seed backup (refuses non-interactive)
npx sparkbtcbot-leaf-vault verify
```

### Local clone (for running the example scripts and tests yourself)

```bash
git clone https://github.com/echennells/sparkbtcbot.git ~/sparkbtcbot
cd ~/sparkbtcbot
npm ci     # lockfile-exact install; fails loudly on any drift
```

Don't clone directly into `~/.claude/skills/` — this repo nests the skill at `skills/sparkbtcbot/`, so the clone would put `SKILL.md` a level too deep and Claude Code won't discover it. If you want the clone to double as a personal skill (instead of the plugin install), symlink the inner skill directory:

```bash
ln -s ~/sparkbtcbot/skills/sparkbtcbot ~/.claude/skills/sparkbtcbot
```

The Quick Start below assumes this path — useful if you want to kick the tires on the example scripts (`npm run example:balance` etc.) before integrating.

## Quick Start

```bash
# Install dependencies (in the cloned repo; lockfile-exact)
cd ~/sparkbtcbot
npm ci

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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `SPARK_PASSPHRASE` | Yes | Passphrase (≥12 chars) that decrypts the seed file at boot. Set during `npm run setup`. |
| `SPARK_NETWORK` | No | `MAINNET` (default), `REGTEST`, `TESTNET`, `SIGNET` |
| `SPARK_SEED_PATH` | No | Override for the encrypted-seed file location. Defaults to `~/.spark/seed.enc`. |
| `SPARK_ACCOUNT_NUMBER` | No | BIP32 account index. Defaults: 1 (MAINNET), 0 (REGTEST) |

## Dependencies

```bash
npm install @buildonspark/spark-sdk dotenv light-bolt11-decoder
```

## Security

**Passphrase + seed file = full wallet access.** Either alone is useless; both together control all funds. There is no permission scoping, no spending limits, no read-only mode in the SDK.

Recommendations:
- Never expose the mnemonic or passphrase in code, logs, or version control
- Treat `SPARK_PASSPHRASE` like any production secret (deployment secret manager, `.env` in `.gitignore`, etc.)
- **Use a current npm (`npm install -g npm@latest`).** Prefer **v12+** — it disables package install/lifecycle scripts by default, killing the `postinstall` supply-chain attack class (needs Node `^22.22.2 || ^24.15.0 || >=26`); otherwise **11.10.0+** is the floor where the package-cooldown age-gate (`min-release-age`) enforces at all (fine on Node 20, which can't run npm 12). Distro-packaged npm (Ubuntu `apt` ships ~9.x even alongside Node 22 LTS) runs years behind and silently ignores hardening keys, so upgrade rather than trust the system npm. The hardening config itself lives in the [`supply-chain-hardening`](https://github.com/echennells/supply-chain-hardening) repo.
- Don't bundle `seed.enc` into container images that ship alongside the passphrase
- Use a dedicated wallet with limited funds for each agent
- Use separate `accountNumber` values for different funding tiers
- Back up the **mnemonic** offline — the encrypted seed file is not a substitute for an offline seed backup
- No server-enforced limits exist on this path: the funded balance is the hard cap. Keep it small and sweep earnings out regularly

## Resources

- [Spark Docs](https://docs.spark.money)
- [Spark SDK (npm)](https://www.npmjs.com/package/@buildonspark/spark-sdk)
- [Sparkscan Explorer](https://sparkscan.io)

## License

MIT
