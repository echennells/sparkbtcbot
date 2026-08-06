# Security & Operational Practices

Load when hardening a deployment, deciding how much value to hold, or advising a user on custody. The always-loaded behavioral rules for Claude live in `SKILL.md` ("Rules for Claude"); this is the fuller operational guidance behind the in-body summary.

## The agent has full wallet access

Any process that holds **both the passphrase and the seed file** has **unrestricted control** over the wallet — it can check balance, create invoices, and send every sat to any address. There is no permission scoping, no spending limits, no read-only mode in the SDK itself. Encryption-at-rest raises the bar against `.env` leaks and env-var dumps; it does not scope what the running agent can do.

This means:
- If the passphrase and seed file both leak, all funds are at risk immediately.
- If an agent process is compromised while running, the attacker has the same full access (the mnemonic is in process memory after decrypt).
- There is no way to revoke access without sweeping funds to a new wallet.

## Protect the mnemonic and passphrase

1. **Back up the seed phrase offline** — write it down on paper or use a hardware backup. If you lose the mnemonic, the funds are gone permanently. The encrypted seed file is **not** a substitute for an offline seed backup.
2. **Never expose the mnemonic or the passphrase** in code, logs, git history, or error messages.
3. **Treat `SPARK_PASSPHRASE` like any production secret** — keep it out of source, out of build images, out of CI logs. A deployment secret manager is fine; `.env` in `.gitignore` is fine; a screenshot in a Slack thread is not.
4. **Restrict the seed file** — `~/.spark/seed.enc` is mode 0600. Don't bundle it into container images that ship alongside the passphrase.
5. **Add `.env` to `.gitignore`** — prevent accidental commits of secrets.

## Don't accumulate large balances

Even with encryption-at-rest, a compromised host with passphrase + seed file = full custody — treat it as a hot wallet.

- Regularly sweep earned funds to a more secure wallet (hardware wallet, cold storage, or a separate wallet you control directly).
- Only keep the minimum operational balance the agent needs on Spark.
- Use `wallet.transfer()` or `wallet.withdraw()` to move funds out periodically. This skill does not ship an automated sweeper — sweep manually as part of your operations rhythm, or build the listener yourself if you want it on autopilot (`transfer:claimed` event + balance check + `wallet.transfer()`).

## Operational security

1. **Use separate mnemonics** for different agents — never share a mnemonic across agents. Each agent runs its own setup and has its own seed file + passphrase.
2. **Use separate `accountNumber` values** if you need multiple wallets from one mnemonic.
3. **Monitor transfers** via event listeners for unexpected outgoing activity (see `extras.md`).
4. **Call `cleanup()`** when the wallet is no longer needed.
5. **Use REGTEST** for development and testing, MAINNET only for production.
6. **There are no hard spending limits on this path.** `SPARK_DAILY_BUDGET_SATS` and the wrapper's fee/amount ceilings bound mistakes and runaway loops, but anything in the agent's process can call `wallet.transfer()` directly past them — no in-process control survives a compromised process. The funded balance is the only cap that does: size it as a loss you can absorb, and sweep earnings out regularly. **To raise the bar for the budget specifically**, bind it into the encrypted seed (`npx sparkbtcbot-set-policy`, user-run): the ledger becomes HMAC-signed and deleting/editing it fails closed — defeating the budget then requires executing code, not `rm` (see `encrypted-seed.md` → Seed-bound policy; replay and raw-SDK calls remain the documented residuals).

## What the allowlist does and does not bound

The optional recipient allowlist (`~/.spark/recipients.allow`) gates Spark transfers, token transfers, and L1 withdrawals to addresses on the list. It does **not** gate Lightning or L402 payments — those pay a node pubkey embedded in a BOLT11 invoice, not an address, so there is no address for the allowlist to check. There is no hard cap on Lightning/L402 outflow — the wrapper's `maxAmountSats` ceiling and `SPARK_DAILY_BUDGET_SATS` bound it in-process only, so the funded balance is the ultimate limit.
