# sparkbtcbot

Claude Code skill for setting up Spark Bitcoin L2 wallet capabilities for AI agents.

**Installation:** Clone to `~/.claude/skills/sparkbtcbot`

## What This Skill Does

Teaches Claude Code how to give AI agents Bitcoin capabilities using the Spark L2:

1. **Initialize Wallet** — Create or import a BIP39 mnemonic-based wallet
2. **Check Balance** — Query BTC and token balances
3. **Receive Deposits** — Generate L1 Bitcoin deposit addresses
4. **Transfer BTC** — Instant, zero-fee Spark-to-Spark transfers
5. **Lightning Invoices** — Create and pay BOLT11 invoices (Lightning Network interop)
6. **Spark Invoices** — Native Spark invoices payable in sats or tokens
7. **Token Operations** — Transfer BTKN/LRC20 tokens natively
8. **Withdraw to L1** — Cooperative exit back to on-chain Bitcoin
9. **Message Signing** — Sign and verify messages for identity proof

## Structure

```
lib/
  encrypted-seed.js                   # scrypt + AES-256-GCM seed file helper
skills/
  sparkbtcbot/
    SKILL.md                          # Always-loaded skill body (security, setup, navigator)
    references/                       # Detail loaded on demand (SDK API, agent class, L402, etc.)
      encrypted-seed.md               # Threat model, setup modes, recovery
    scripts/                          # Runnable example scripts
      setup-encrypted-seed.js         # `npm run setup` — one-time bootstrap
      balance-and-deposits.js
      payment-flow.js
      token-operations.js
      spark-agent.js
      l402-paywalls.js
tests/                                # vitest suite (unit, integration, funded tiers)
.env.example                          # Environment variable template
```

## Trigger Phrases

Activates when user mentions: "Spark wallet", "Spark Bitcoin", "Spark L2", "BTKN tokens", "Spark SDK", "Spark payment", "Spark transfer", "Spark invoice", "Bitcoin L2 wallet", "agent wallet on Spark"

## Dependencies

```bash
npm install @buildonspark/spark-sdk dotenv
```

## Environment Variables

```bash
SPARK_PASSPHRASE=<at least 12 chars — decrypts ~/.spark/seed.enc at boot>
SPARK_NETWORK=MAINNET
# SPARK_SEED_PATH=/custom/path/seed.enc   # optional override
```

## Security Note

The mnemonic is encrypted at rest in `~/.spark/seed.enc` (scrypt + AES-256-GCM). The runtime reads `SPARK_PASSPHRASE` from env and decrypts at boot — there is no plaintext-mnemonic-in-`.env` path. Both passphrase and seed file together grant full wallet access (no permission scoping like NWC). Use dedicated wallets with limited funds for agents.

Fresh-wallet setup writes the new mnemonic to a backup file (`~/.spark/MNEMONIC_BACKUP_<random>.txt`, mode 0600) instead of printing it to stdout — that's deliberate, since stdout from a Bash-invoked setup gets captured by the agent's transcript. The user is expected to read+offline-copy+`rm` the file themselves; the agent does not read it unless the user explicitly asks. See SKILL.md for full security guidance.
