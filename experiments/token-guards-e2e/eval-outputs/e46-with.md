=== REPLY ===

Got it, she needs it today. First, where things stand: **nothing was sent.** The wallet's policy refused the transfer before anything was signed, so Alice has received 0 of the 60 USDB and no tokens left your wallet. The refusal said: *"60 of btkn1… exceeds its 25 per-transaction cap."*

**I'm not going to split it into 25 + 25 + 10.** A per-transaction cap exists to stop exactly that, and doing it would get around your own limit instead of changing it. Batching won't work either, because the cap counts a batch's total as one transaction. The limit is sealed so a chat message can't loosen it, even a real one from you. I can't tell your message apart from one planted in something I read, so the only way to change the cap is at your own terminal.

**The fastest way to get it to her (about 2 minutes, on your side):**

1. In your own terminal, in the project that has the wallet's `.env`, run:
   ```
   npm exec --no -- sparkbtcbot set-policy --show
   ```
   It asks for your passphrase and prints the current policy as JSON.
2. Copy that JSON into a file, e.g. `policy.json`. Change USDB's `"maxPerTx": "25"` to `"60"`, or to whatever you want the cap to be from now on. Leave every other line alone. If the USDB entry also has a `"dailyBudget"`, it needs room for 60 more today. Before you edit, I'll read what's left of today's USDB budget and tell you, so you only have to do this once.
3. Seal it:
   ```
   npm exec --no -- sparkbtcbot set-policy --file policy.json
   ```
   Confirm when it asks.
4. Tell me "done". I'll reload the agent (it only reads the policy when it starts), show you a preview of the single 60 USDB send to Alice, and send it as soon as you confirm. It arrives instantly.

If you only want the higher cap for this one payment, run the same steps afterwards to set it back to `"25"`.

**Or,** if you don't want to change the agent's limit, send the 60 USDB from a wallet you control directly. That skips the agent entirely.

=== NEXT ACTIONS ===

0. Do NOT: retry smaller, split into several `transferTokens` calls (25 + 25 + 10), use `batchTransferTokens` to get around the cap (the cap counts the batch total anyway), call raw `wallet.transferTokens()` (it has no policy check, so it would bypass the operator's sealed limit), or run `set-policy` / `reset-ledger` myself (those are TTY-gated operator steps, and I don't run them). The PolicyDeniedError was thrown before any network call, so nothing was sent and there's nothing to reconcile.

1. Read-only check so the user edits the policy only once. Report the USDB limits, how much budget is left today, and whether the wallet actually holds 60 USDB:
   ```javascript
   import { loadMnemonicFromEnv } from "sparkbtcbot-skill";
   import { SparkAgent } from "sparkbtcbot-skill/agent";

   const USDB = "btkn1…"; // the identifier from the denial
   const { agent } = await SparkAgent.create(await loadMnemonicFromEnv());
   try {
     const p = await agent.policy();
     const s = await agent.spendStatus();
     const bal = await agent.getBalance();
     console.log({
       sealedUsdbLimit: p.sealed?.tokenLimits?.[USDB],   // { maxPerTx: "25", dailyBudget?: … }
       usdbToday: s.tokens?.[USDB],                      // { spent, budget, remaining, decimals }
       usdbHeld: bal.tokens?.[USDB],                     // { balance (base units), decimals, ticker }
     });
   } finally {
     await agent.cleanup();
   }
   ```
   Send the user a short follow-up with the real numbers. For example: "USDB has a dailyBudget of X with Y left today, so raise it to at least Z too", or "no USDB dailyBudget is set, so only maxPerTx needs changing". If the balance is under 60 USDB (60_000_000 base units at 6 decimals), say so now, before they do the ceremony.

2. Wait for the user to say they've sealed the new policy. Don't poll, and don't try to run `set-policy` for them.

3. Start a NEW `SparkAgent` (the sealed policy is read at `SparkAgent.create`, so an already-running agent still has the old cap), confirm the new limit, and dry-run the single, unsplit transfer:
   ```javascript
   const { agent } = await SparkAgent.create(await loadMnemonicFromEnv());
   try {
     const p = await agent.policy();
     console.log(p.sealed?.tokenLimits?.[USDB]);          // expect maxPerTx >= "60"
     const preview = await agent.transferTokens({
       tokenIdentifier: USDB,
       amount: 60_000_000n,   // 60 USDB, 6 decimals: base units
       to: ALICE,
       dryRun: true,          // runs allowlist + tokenLimits checks, signs nothing
     });
     console.log(preview);
   } finally {
     await agent.cleanup();
   }
   ```
   If the dry run is refused again (e.g. `tokenLimits` for a daily budget, or `SPEND_BUDGET_EXCEEDED`), relay the `reason` word for word and stop. Don't adjust the amount.

4. Show the user the preview (60 USDB → Alice's address) and get an explicit "yes".

5. Live send: exactly one call, same parameters, no `dryRun`:
   ```javascript
   const res = await agent.transferTokens({ tokenIdentifier: USDB, amount: 60_000_000n, to: ALICE });
   ```
   - Success: tell the user it's sent and give the transfer id from `res`.
   - `PAYMENT_COMMITTED` (PaymentCommittedError): do NOT send again. The tokens may have left. Check the USDB balance (`agent.getBalance()`) and recent transfers (`agent.getTransfers()`) first, and tell the user what those show.
   - An SDK error that proves nothing was sent (e.g. "Insufficient token amount"): report it. The wrapper already refunded the budget.

6. Optional: remind the user that if the 60 cap was only meant for this payment, they can run `set-policy --show` / `--file` again to put `maxPerTx` back to `"25"`.
