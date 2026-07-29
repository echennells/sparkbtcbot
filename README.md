# sparkbtcbot

[![CI](https://github.com/echennells/sparkbtcbot/actions/workflows/ci.yml/badge.svg)](https://github.com/echennells/sparkbtcbot/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![Node](https://img.shields.io/badge/node-%E2%89%A518-brightgreen.svg)](https://nodejs.org)

Spark Bitcoin L2 wallet skill for AI agents — give an agent its own Bitcoin wallet so it can send and receive money on its own: pay for an API call, get paid for a task, tip, settle up — or buy real-world things (gift cards, eSIMs, VPNs) from Bitcoin-accepting merchants, with guardrails that verify every invoice against its quote before a sat moves.

Built on [Spark](https://docs.spark.money), a Bitcoin Layer 2 with instant, near-zero-fee transfers and native Lightning support — and fully self-custodial, so the agent holds its own keys. Use it in Claude Code as a plugin, or in any other LLM agent framework via the npm package.

> ⚠️ **Handles real Bitcoin.** Mainnet by default, full custody the moment the seed is decrypted, no built-in spending caps — treat the agent like a hot wallet. Use a dedicated wallet with limited funds, or run [sparkbtcbot-proxy](https://github.com/echennells/sparkbtcbot-proxy) for server-enforced per-transaction and daily limits.

**Best for:** autonomous agents that send/receive small amounts — pay per API call, get paid for a task, tip, settle up — plus dev/test on REGTEST and trusted agents you control.
**Not for:** custody of large balances on the direct SDK path, or anything needing hard spending caps or revocable access (use the proxy for those).

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
- **Merchant Purchases** — Buy real-world goods and services (gift cards via [Bitrefill](https://www.bitrefill.com), eSIMs/VPNs/burner numbers via [nadanada](https://nadanada.me)) over Lightning, governed by a shared payment policy: invoice-vs-quote verification, amount ceilings, confirm-before-buy, PII consent, bearer-secret handling. Live-validated with real purchases.
- **Unilateral-Exit Backup** — Auto-maintained `spark.unilateral-exit-bundle.v1` recovery bundle, consumed by Blink's [spark-unilateral-exit](https://github.com/blinkbitcoin/spark-unilateral-exit) tool if the operators ever go dark. Verify with `npm run leaf-vault -- verify`.

## Installation

Two install paths depending on your stack.

### Claude Code

```bash
claude plugin marketplace add https://github.com/echennells/sparkbtcbot
claude plugin install sparkbtcbot
```

Native plugin install. Updates flow through `claude plugin update sparkbtcbot`. Claude reads `SKILL.md` automatically when the skill triggers.

### Any other LLM agent framework (Cursor, LangChain, OpenAI Agents SDK, Aider, etc.)

```bash
npm install sparkbtcbot
```

The package ships both the skill content (so you can load it into your LLM's context) and the encryption library (so generated code can import the helpers). Minimal use:

```javascript
import { getSkillContent, getReference, listReferences } from "sparkbtcbot";

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
import { saveEncryptedMnemonic, loadMnemonicFromEnv } from "sparkbtcbot";

await saveEncryptedMnemonic({ mnemonic, passphrase, path: "./seed.enc" });
const decrypted = await loadMnemonicFromEnv(); // reads SPARK_PASSPHRASE
```

And the unilateral-exit backup (the "leaf-vault") via its subpath export:

```javascript
import { enableLeafVault, snapshotLeafVault, verifyVault } from "sparkbtcbot/leaf-vault";

const vault = enableLeafVault(wallet); // auto-refreshing recovery bundle
// ... later: await vault.dispose();   // flushes a final snapshot if needed
```

The package has zero runtime dependencies beyond Node 18+ built-ins.

### Local clone (for running the example scripts and tests yourself)

```bash
git clone https://github.com/echennells/sparkbtcbot.git ~/.claude/skills/sparkbtcbot
cd ~/.claude/skills/sparkbtcbot
npm install
```

The Quick Start below assumes this path — useful if you want to kick the tires on the example scripts (`npm run example:balance` etc.) before integrating.

## Quick Start

```bash
# Install dependencies (in the cloned skill directory)
cd ~/.claude/skills/sparkbtcbot
npm install

# Copy env template, set SPARK_PASSPHRASE (>=12 chars)
cp .env.example .env
$EDITOR .env

# One-time setup: generate a wallet, encrypt the mnemonic at ~/.spark/seed.enc.
# This also writes a backup file (~/.spark/MNEMONIC_BACKUP_*.txt, mode 0600)
# containing the 12 words; setup prints the path.
npm run setup

# Back up the mnemonic offline (paper / password manager / hardware backup),
# then delete the backup file:
cat ~/.spark/MNEMONIC_BACKUP_*.txt   # confirm path matches what setup printed
rm  ~/.spark/MNEMONIC_BACKUP_*.txt   # AFTER you have a copy offline

# Run the examples
npm run example:balance
npm run example:payments
```

The mnemonic is **never** stored in plaintext anywhere the runtime reads. `npm run setup` writes an encrypted seed file (`~/.spark/seed.enc`, mode 0600); the runtime reads `SPARK_PASSPHRASE` from env and decrypts it once at boot. The backup file from setup is a one-time artifact for the user to copy from — it does not auto-delete; you `rm` it once you have an offline backup. See `skills/sparkbtcbot/references/encrypted-seed.md` for the threat model and recovery scenarios.

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
- Don't bundle `seed.enc` into container images that ship alongside the passphrase
- Use a dedicated wallet with limited funds for each agent
- Use separate `accountNumber` values for different funding tiers
- Back up the **mnemonic** offline — the encrypted seed file is not a substitute for an offline seed backup
- For production with non-trivial balances, run [sparkbtcbot-proxy](https://github.com/echennells/sparkbtcbot-proxy) — keeps the seed on a server you control and gives the agent only HTTP access via revocable scoped tokens

## Resources

- [Spark Docs](https://docs.spark.money)
- [Spark SDK (npm)](https://www.npmjs.com/package/@buildonspark/spark-sdk)
- [Sparkscan Explorer](https://sparkscan.io)

## License

MIT
