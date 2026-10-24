=== REPLY ===
No, that needs changing. `tokenLimits` takes **token amounts, not base units**, so leave the decimals out of it. For a 25 USDB cap, write:

```json
"tokenLimits": {
  "btkn1<full USDB identifier>": { "maxPerTx": "25" }
}
```

As you wrote it, `25000000` is read as **25,000,000 USDB per transaction**. The worst part is that nothing warns you. It's a valid positive amount, so `set-policy --file` accepts it, the confirmation screen shows `"maxPerTx": "25000000"`, and after you type `yes` you'd have a sealed cap that never triggers.

You don't need the 6 at all. Decimals aren't part of the policy (a `decimals` key is refused). At each send, `SparkAgent` reads USDB's decimals from the wallet's own token metadata and converts `"25"` exactly, to 25,000,000 base units. If you ever want a fractional cap like `"25.50"`, that works too. A limit with more decimal places than the token has is refused, never rounded.

A few other things to check in the same file:

- **Use the string form** (`"25"`), as the docs do. A plain JSON number is accepted, but a string can't be mangled into a float or exponent form.
- **The key must be USDB's exact bech32m identifier** (`btkn1…`, copied from the token's balance entry). `set-policy` checks the checksum and refuses a bad one.
- **Sealing `tokenLimits` also makes it the token allowlist.** Once it's sealed, a send of any token that isn't listed is refused. Add an entry for every token the agent should be able to move.
- **`maxPerTx` alone doesn't stop a loop.** The agent could still send 25 USDB again and again. `SPARK_DAILY_BUDGET_SATS` and `dailyBudgetSats` count sats only, never tokens, so to bound the total add a rolling-24h `dailyBudget`, e.g. `{ "maxPerTx": "25", "dailyBudget": "100" }`. A batch or multi-invoice payment counts as one transaction, so the cap applies to the total across its entries.
- **`--file` seals the whole object.** If you already have sealed rules (a sats budget, `allowedOps`, recipients), anything missing from this file is dropped. Run `sparkbtcbot set-policy --show > policy.json` first, add `tokenLimits` to that, then `--file` it back. Run it in your own terminal: it asks for the passphrase and I don't run it for you.

After you've sealed it, I can check it from the agent: `agent.policy()` should list the USDB limit, and `spendStatus().tokens` should show it as 25 with `decimals: 6`.

=== NEXT ACTIONS ===
- Nothing to run now. `set-policy` is the operator's TTY ceremony: I don't run it, `rekey` or `rotate`, and I don't handle the passphrase.
- Once the user says it's sealed, and only if they want it checked, read-only verification through `SparkAgent`:
  - `await agent.policy()`: confirm `tokenLimits` shows the USDB identifier with `maxPerTx: "25"`, plus `dailyBudget` if they added one, and `tokens: { limited: true }`.
  - `(await agent.spendStatus()).tokens`: confirm USDB shows `budget` in token amounts with `decimals: 6`, which checks the conversion.
  - Optionally a `dryRun: true` `transferTokens` of just over the cap (e.g. 26 USDB = 26_000_000n base units) to one of their own allowed recipients. Expect a `PolicyDeniedError { rule: "tokenLimits" }`. Nothing is signed in dry-run and the exec hook doesn't fire.
- If they seal it without a `dailyBudget`, say plainly when stating limits that per-transaction is the only USDB bound. Relay any `agent.policy()` note about uncapped tokens word for word.
