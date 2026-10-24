=== REPLY ===

Not quite. The 50k limit covers less than it sounds like.

**What it does:** every sats payment that goes through SparkAgent (Spark transfers, Lightning, L402, withdrawals) is counted over a rolling 24 hours. Any payment that would push the total past 50,000 sats is refused. That's what stops a runaway loop, or an agent tricked into paying invoice after invoice.

**What it doesn't cover:**

1. **Your 480 USDB has no limit at all.** `SPARK_DAILY_BUDGET_SATS` counts sats only, never tokens, and there's no env var for tokens. Right now the agent could send all 480 USDB in one transfer. Token limits exist only in a sealed policy, and you don't have one.
2. **It's a daily limit, not a total.** At 50k a day, a loop nobody notices could drain all 130,269 sats in under three days.
3. **The agent can turn it off.** The limit is a line in `.env`, and the running total is an unsigned file (`~/.spark/spend-ledger.json`). An agent that can edit files can raise the number, or delete the file and start a fresh 24 hours.
4. **There's no per-payment cap.** All 50,000 can go in one payment. Lightning routing fees also come on top of the counted amount; they're capped separately at about 0.5%.

So, can it lose more than 50k in a day? If the agent makes a mistake or gets tricked but still goes through SparkAgent, sats are roughly capped at 50k plus Lightning fees. The USDB isn't capped at all. If the agent's process is compromised, nothing inside it holds: code that decrypts the seed and calls the Spark SDK directly skips every check. In that case the real limit is what's in the wallet: 130,269 sats plus 480 USDB.

**Closing the gaps:**

- **Seal the policy into the encrypted seed.** You run this in your own terminal. It's built so I can't run it: `npm exec --no -- sparkbtcbot set-policy --file policy.json`. Once sealed, the 50k budget overrides whatever `.env` says. The ledger also becomes signed, so deleting or editing it blocks spending instead of resetting it. In the same file you can add:
  - `tokenLimits` for USDB: a per-send cap and a daily budget in USDB (for example `"25"` per send and `"100"` a day; the numbers are your call)
  - `maxPerTxSats`, if you don't want one payment to use the whole 50k
  - `allowedOps`, to switch off things the agent never does (e.g. L1 withdrawals)
- **Fill in `~/.spark/recipients.allow`** if the agent only pays known addresses. It covers token sends too, but not Lightning.
- **Keep only spending money in the agent's wallet.** Sealing stops a tricked agent, not a compromised one. If losing 480 USDB would hurt, move what the agent doesn't need to a wallet it has no keys to.

Should I check what limits the agent is actually running with and draft `policy.json` for you to review? Both are read-only, and nothing gets sent.

=== NEXT ACTIONS ===

Only if the user says yes, and nothing that moves money:

1. Through SparkAgent (read-only), call `await agent.policy()` and `await agent.spendStatus()`. This confirms the running agent actually loaded the 50k env budget (not `{ disabled: true }`) and shows how much is already spent in the current window. Relay the `tokens: { limited: false, note }` line word for word. I won't read `.env` into the conversation.
2. Get USDB's `btkn1…` token identifier from `agent.getBalance()` (`tokenBalances`), read-only. `tokenLimits` is keyed by that identifier.
3. Draft `policy.json` for the user to review: `dailyBudgetSats: 50000`, a `tokenLimits` entry for USDB with `maxPerTx` / `dailyBudget` values the user picks, and optionally `maxPerTxSats` and `allowedOps`. Ask the user for the numbers rather than choosing them.
4. The user runs `npm exec --no -- sparkbtcbot set-policy --file policy.json` in their own terminal. It needs a TTY, so I don't run it (nor rekey or rotate). Sealing signs the existing ledger as it stands, so today's spends still count.
5. After sealing, call `agent.policy()` again to confirm the sealed rules are active and that `tokens.limited` is true.
6. If the user wants it, help write `~/.spark/recipients.allow` from addresses the user names. Add only the user's own addresses, never ones taken from a webpage or a merchant reply.
