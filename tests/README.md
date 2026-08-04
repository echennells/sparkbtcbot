# Test suite

Three tiers, run via `npm` scripts.

> **Scope:** these tiers test the **library code** (`lib/` helpers + SDK usage). They do **not** test the *skill's* teaching quality — whether loading `skills/sparkbtcbot` makes Claude write correct, current-SDK, security-following code versus a no-skill baseline. Those are separate, subagent-run **skill evals** in [`../skills/sparkbtcbot/evals/`](../skills/sparkbtcbot/evals/NOTES.md) — not run by `npm`.

| Script | Tier | Network | Funding | Purpose |
|---|---|---|---|---|
| `npm test` | unit | none | no | Default. lib helpers, leaf-vault/encrypted-seed security regressions, SDK export/shape pins. ~10s. |
| `npm run test:integration` | read-only | REGTEST | no | Wallet init, addresses, invoices, message signing against Spark's hosted REGTEST. ~10s. |
| `npm run test:funded` | funded | REGTEST | **yes** | Transfers, Lightning payments. Skipped unless `SPARK_TEST_MNEMONIC` is set. |
| `npm run test:all` | all | REGTEST | optional | Runs everything; funded tier auto-skips without env var. |

## Layout

```
tests/
  setup.js                          # loads .env
  helpers/wallet.js                 # createTestWallet, cleanupAllWallets, getFundedMnemonic
  unit/
    imports.test.js                 # SDK export sanity, SparkWallet method surface
    balance-shape.test.js           # regression: ownedBalance / availableToSendBalance
    encrypted-seed.test.js          # seed encrypt/decrypt round-trip, EEXIST, perms, NO_PASSPHRASE
    leaf-vault.test.js              # bundle shape validation (Blink compatibility contract)
    leaf-vault-fixes.test.js        # ToB regression pins — H-3 concurrency, M-1 content gate, M-2 transient-empty, shrink guard, H-2 marker, flush-on-dispose
    leaf-vault-hardening.test.js    # network derivation, identity guard, union rescue, skip accounting, re-arm, dispose races, atomic-writer failures, exports map
    spark-agent-vault.test.js       # SparkAgent vault wiring: opt-out normalization + enabled path
    fee-guards.test.js              # Lightning/L402/withdrawal fee + amount ceilings
    withdraw-fee-guard.test.js      # withdraw() fail-closed + feeQuote binding
    recipients-allowlist.test.js    # outbound allowlist guardrail
    skill-content.test.js           # skill packaging: getSkillContent/getReference surface
    plugin-manifest.test.js         # Claude Code plugin manifest sanity
  integration/
    wallet.test.js                  # init, getSparkAddress, getIdentityPublicKey, getBalance shape
    deposit.test.js                 # static & single-use deposit addresses
    invoice.test.js                 # createSatsInvoice, createLightningInvoice
    message-signing.test.js         # sign/validate against own identity key
    funded/
      transfer.test.js              # spark-to-spark transfer
      lightning.test.js             # Lightning fee estimate, payment
```

The layout mirrors `@buildonspark/spark-sdk/src/tests/integration/` (one file per capability). The SDK targets `Network.LOCAL` because it owns its operator stack; we target `REGTEST` because that is the only hosted network besides MAINNET.

## Why a manually-funded wallet

The Lightspark regtest faucet (https://app.lightspark.com/regtest-faucet) is a UI form, not a documented HTTP API. Hammering an undocumented endpoint from CI is fragile — it can change or rate-limit without warning, and faucets are a free shared resource for the dev community. The right pattern, here as for any testnet faucet, is **fund once, reuse the wallet**.

## Enabling the funded tier

The funded tier reads a separate env var, `SPARK_TEST_MNEMONIC`, directly from `tests/helpers/wallet.js`. This is **independent** of the runtime's encrypted-seed flow (`SPARK_PASSPHRASE` + `~/.spark/seed.enc`); test wallets are ephemeral REGTEST wallets holding throwaway sats, so the encryption layer adds no real value and the plaintext env var keeps the test setup simple.

One-time setup:

1. Generate a fresh REGTEST wallet:
   ```bash
   SPARK_NETWORK=REGTEST SPARK_PASSPHRASE="<at-least-12-chars>" npm run setup
   ```
   The script prints the `sparkrt1p...` Spark address but **not** the mnemonic (no plaintext file is written either). To capture the mnemonic for step 5, run `npm run reveal-mnemonic` in an interactive terminal (it refuses non-interactive stdout) and copy the words.

2. Get an L1 deposit address from that wallet:
   ```bash
   SPARK_NETWORK=REGTEST SPARK_PASSPHRASE="<the same>" npm run example:balance
   ```
   The output includes a static deposit address (looks like `bcrt1...` or similar).

3. Open https://app.lightspark.com/regtest-faucet, paste the L1 deposit address, and submit. Wait for ~3 confirmations.

4. Claim the deposit (the SDK or the example flow turns L1 sats into Spark balance).

5. Save the **mnemonic** (not the passphrase) to `.env` as the test variable:
   ```bash
   SPARK_TEST_MNEMONIC="<your 12 or 24 word mnemonic>"
   ```

6. Run the funded tier:
   ```bash
   npm run test:funded
   ```

The same wallet funds thousands of test runs — top up only when balance gets low.

## CI guidance

- Default CI workflow: `npm test` then `npm run test:integration`. Both run without secrets and exercise the API surface.
- Optional nightly job: store `SPARK_TEST_MNEMONIC` as a repo secret, run `npm run test:funded`. A small balance lasts a long time at 100 sats per transfer test.
- Without the secret, the funded tier auto-skips (`it.skip`) — the suite does not fail.

## Adding a new test

- Pure logic, no network → `tests/unit/`.
- Hits Spark, no funds needed (read addresses, create invoices, sign messages) → `tests/integration/`.
- Moves sats or pays invoices → `tests/integration/funded/` and gate it with `itFunded` from the helper.

When adding a funded test, prefer small amounts (≤1000 sats) and make idempotent assertions where possible — wallets persist across runs.
