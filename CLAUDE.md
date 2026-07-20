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
10. **Unilateral-Exit Backup** — Continuously-fresh `spark.unilateral-exit-bundle.v1` recovery bundle (the "leaf-vault"), consumed by Blink's [spark-unilateral-exit](https://github.com/blinkbitcoin/spark-unilateral-exit) tool if the operators ever vanish

## Structure

```
lib/
  atomic-file.js                      # the one atomic writer (temp+fsync+link/rename+dir-fsync)
  encrypted-seed.js                   # scrypt + AES-256-GCM seed file helper
  leaf-vault.js                       # SDK-free recovery-bundle persistence + shape validation
  fee-guards.js                       # fee/amount ceilings for sends, claims, withdrawals
  recipients-allowlist.js             # opt-in outbound allowlist guardrail
  index.js / index.d.ts               # npm entry (also exports ./leaf-vault subpaths)
skills/
  sparkbtcbot/
    SKILL.md                          # Always-loaded skill body (security, setup, navigator)
    references/                       # Detail loaded on demand (SDK API, agent class, L402, etc.)
      encrypted-seed.md               # Threat model, setup modes, recovery
      unilateral-exit.md              # The leaf-vault backup + Blink's exit tool
      recovery-scenarios.md           # Recovery properties (staleness, justice, economics)
    scripts/                          # Runnable example scripts
      setup-encrypted-seed.js         # `npm run setup` — one-time bootstrap
      leaf-vault.js                   # snapshotLeafVault / verifyVault / enableLeafVault (library)
      leaf-vault-cli.js               # `npm run leaf-vault [-- verify]` — snapshot/verify CLI
      balance-and-deposits.js
      payment-flow.js
      token-operations.js
      spark-agent.js
      l402-paywalls.js
    evals/                            # Skill-quality evals (does the skill make Claude produce correct/safe code?)
      evals.json                      # Output evals: SDK-correctness + security-behavior, with checkable assertions
      trigger-eval.json               # Description-triggering queries (see NOTES: not measurable via claude -p here)
      NOTES.md                        # How to run (subagent output evals, with-skill vs baseline) + last results
tests/                                # vitest suite for the LIBRARY code (unit, integration, funded tiers)
.env.example                          # Environment variable template
```

**Two testing surfaces, don't conflate them:** `tests/` (vitest) verifies the
**library code** — `lib/` helpers, SDK export/shape regressions, REGTEST flows.
`skills/sparkbtcbot/evals/` verifies the **skill itself** — whether loading it
makes Claude write correct, current-SDK, security-following code versus a no-skill
baseline. The evals are run by subagents from a Claude Code session, not by
`npm`; see `skills/sparkbtcbot/evals/NOTES.md`.

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
# SPARK_LEAF_VAULT=off                    # opt out of the automatic recovery-bundle backup
# SPARK_LEAF_VAULT_PATH=/custom/path.json # recovery-bundle location (default ~/.spark/leaf-vault/current.json)
```

## Security Note

The mnemonic is encrypted at rest in `~/.spark/seed.enc` (scrypt + AES-256-GCM). The runtime reads `SPARK_PASSPHRASE` from env and decrypts at boot — there is no plaintext-mnemonic-in-`.env` path. Both passphrase and seed file together grant full wallet access (no permission scoping like NWC). Use dedicated wallets with limited funds for agents.

Fresh-wallet setup writes the new mnemonic to a backup file (`~/.spark/MNEMONIC_BACKUP_<random>.txt`, mode 0600) instead of printing it to stdout — that's deliberate, since stdout from a Bash-invoked setup gets captured by the agent's transcript. The user is expected to read+offline-copy+`rm` the file themselves; the agent does not read it unless the user explicitly asks. See SKILL.md for full security guidance.
