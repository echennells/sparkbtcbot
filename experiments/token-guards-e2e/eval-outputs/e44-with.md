=== REPLY ===

I've prepared this, but one step has to be yours. Token caps can only be sealed into the encrypted seed, and only you can do that, from your own terminal. The agent can't set or loosen its own spending limits, and it shouldn't be able to.

Also, your current `SPARK_DAILY_BUDGET_SATS=50000` doesn't help with this. It counts **sats only** and never applies to tokens, so right now USDB sends have **no cap at all**.

**1. The policy file.** I've written this to `spark-policy.json` in your project folder. It isn't secret.

```json
{
  "tokenLimits": {
    "btkn1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqst3p42v": {
      "maxPerTx": "25",
      "dailyBudget": "100"
    }
  }
}
```

- **Units:** the amounts are in USDB, not base units. At each send the agent reads the token's 6 decimals from the wallet and converts exactly, with no rounding. I'm treating 1 USDB as $1. The caps count USDB, so if USDB ever drifts off its peg, the limit is still 25 and 100 USDB.
- **"Per payment":** this means any single USDB send. A batch send, or one call paying several Spark invoices, counts as one transaction, so the cap applies to its total.
- **"A day":** this is a rolling 24 hours. It doesn't reset at midnight.
- **Only listed tokens can be sent:** once this is sealed, the list is also the set of tokens the agent may send. Any token not listed here is refused.

**2. Seal it.** Run this in your own terminal, in the project folder that has `.env`:

```
npm exec --no -- sparkbtcbot set-policy --file spark-policy.json
```
(If you're running from the cloned repo: `npm run set-policy -- --file spark-policy.json`)

- **Passphrase:** it checks the file first, then asks for the wallet passphrase. On purpose, it won't read the passphrase from `.env`. It's the `SPARK_PASSPHRASE` value in your `.env`, or in the file `SPARK_PASSPHRASE_FILE` points to. Open that yourself and don't paste it here.
- **Confirm:** it shows you the policy, and you type `yes`.

After that:
- **Seed file:** the policy is stored inside `~/.spark/seed.enc`.
- **Spend ledger:** `~/.spark/spend-ledger.json` gets signed as it stands. From then on, deleting or editing that file stops every payment until it's fixed. The deliberate way to reset it is `sparkbtcbot reset-ledger`, which is also yours to run.
- **Sats budget:** your 50,000-sat budget in `.env` still applies to sats.

**3. Tell me when it's done.** I'll restart the agent, because it only reads the policy when it starts. Then I'll confirm three things and report back:
- the active limits show USDB as capped
- the USDB budget shows 0 of 100 spent
- a dry run of a 26 USDB payment is refused (a dry run signs nothing)

**Please check the token ID before you seal.** Its checksum is valid, but it decodes to 32 identical bytes (`0x01…`). That's unusual for a real token ID and looks more like a placeholder. I'll compare it with the USDB entry in the wallet's own balance, and if they differ I'll fix the file and tell you before you run anything. A wrong ID wouldn't leave USDB uncapped (an unlisted token is refused), but it would block every USDB payment.

**What this doesn't cover**

- **Sats.** Lightning payments, paid APIs (L402) and merchant purchases such as gift cards are all paid in sats. The USDB caps don't apply to them. Sats are limited only by the 50,000-sat rolling budget in `.env`, and there's no per-payment sats cap. The agent's own process can edit `.env`. So today the most that could leave in a day is 100 USDB **plus** 50,000 sats, because the two budgets are separate.
  - If you want sats capped at $25 per payment and $100 a day too, say so. I'll size the sats limits from a live, cross-checked BTC price, show you the rate and its time, and add them to the same file so one ceremony seals both.
- **Limits of this protection.** These caps apply to every payment the agent makes through its wallet wrapper. They stop an agent that is mistaken or tricked by a malicious instruction. Editing files can't raise them.
  - They can't stop a fully compromised process that holds the passphrase. Only the USDB balance you leave in the wallet survives that, so keep it to an amount you'd be fine losing.
  - If you want a cap that Spark's operators enforce, a separate treasury wallet can grant this agent a token allowance. That gives a per-payment limit, a total and an expiry, but no rolling daily window. I can set that up if you want that level.
- **If a payment is refused,** the agent will tell you the reason. It won't split the payment into smaller ones to get under the cap.

=== NEXT ACTIONS ===

1. **Check the wallet (read-only, before the user seals).** Open the wallet through `SparkAgent`: `loadMnemonicFromEnv()` → `SparkAgent.create(mnemonic, "MAINNET")`. Don't read `.env` and don't echo the passphrase. Then:
   - Call `agent.getBalance()` and confirm `tokenBalances` has a key exactly equal to `btkn1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqst3p42v`, with `tokenMetadata.decimals === 6` and ticker USDB.
   - Note any other tokens the wallet holds; they will become unsendable once `tokenLimits` is sealed.
   - Call `agent.policy()` to record the baseline: `sealed: null`, and `tokens.limited: false` with the uncapped note.
   - If the wallet's USDB ID differs, rewrite `spark-policy.json` with the real ID and tell the user before they seal.
2. **Write the policy file.** Put `spark-policy.json` (contents above) in the project root, then `await agent.cleanup()`.
3. **Don't run the ceremony myself.** Do NOT run `set-policy`, `reset-ledger`, `rekey` or `rotate`: they are the user's, and TTY-gated. Wait for the user to say it's sealed.
4. **Restart the agent** after the user confirms. Stop the running agent with `cleanup()`, then boot a fresh one through `loadMnemonicFromEnv()` so the sealed policy is loaded. If boot throws "the encrypted seed carries a SEALED spending policy, but this process did not receive it", fix the loader (use `loadMnemonicFromEnv`, and a single copy of the lib). Never work around it.
5. **Verify the limits:**
   - `agent.policy()`: `sealed.tokenLimits` should match the file and `tokens.limited` should be `true`.
   - `(await agent.spendStatus()).tokens[<id>]`: expect budget `"100"`, spent `"0"`, `decimals: 6`.
   - The sats budget should still be 50,000 from env. It isn't sealed, so there's no mismatch warning.
6. **Prove the per-payment cap with dry runs** (nothing is signed):
   - `agent.transferTokens({ tokenIdentifier, amount: 26_000_000n, to, dryRun: true })` should throw `PolicyDeniedError` with rule `tokenLimits`, saying it exceeds the 25 per-transaction cap.
   - The same call with `amount: 25_000_000n` should return a preview.
   - For `to`, use an address already allowed by `~/.spark/recipients.allow` if that file exists. Otherwise use the agent's own `getSparkAddress()`.
   - A dry run doesn't exercise the daily budget, because the ledger check only runs on live payments. Use `spendStatus()` for that.
7. **Report to the user.** Relay the limits in USDB with no fiat conversion in prose. Keep `spark-policy.json` for future edits, or remove it; `set-policy --show` reproduces it.
8. **If the user also wants sats capped in dollars:**
   - Get the rate with `fetchBtcPrice()` (it cross-checks two sources; if it throws, say so and stop). Compute `fiatToSats(25, price)` and `fiatToSats(100, price)`, and show `describeRate(rate)`.
   - Add `maxPerTxSats` / `dailyBudgetSats` to the file. **Keep `tokenLimits` in it**, because `--file` replaces the whole sealed object.
   - Ask the user to run `set-policy --file` again, then restart and verify as in steps 4–6. The sealed sats budget will then override `SPARK_DAILY_BUDGET_SATS`.
