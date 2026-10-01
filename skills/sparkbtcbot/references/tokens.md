# Token Operations (BTKN / LRC20)

Load for any task involving Spark-native tokens — checking token balances, transferring, batch transfers. Spark supports tokens via the BTKN (LRC20) standard — they can represent stablecoins, points, or any fungible asset.

**Note on issuance:** the `@buildonspark/spark-sdk` (`SparkWallet`) only handles tokens you *receive* and *transfer*. Token *creation* (minting new tokens) requires `@buildonspark/issuer-sdk` (`IssuerSparkWallet`). See `references/extras.md` for issuance.

## Check Token Balances

```javascript
const { tokenBalances } = await wallet.getBalance();

for (const [id, info] of tokenBalances) {
  const meta = info.tokenMetadata;
  console.log(`${meta.tokenName} (${meta.tokenTicker}): ${info.ownedBalance.toString()}`);
  console.log(`  decimals:   ${meta.decimals}`);
  console.log(`  max supply: ${meta.maxSupply.toString()}`);
  console.log(`  available:  ${info.availableToSendBalance.toString()}`);
}
```

Each entry has `ownedBalance` (total) and `availableToSendBalance` (excludes pending outbound). For "what can I spend right now," use `availableToSendBalance`.

## Transfer Tokens

```javascript
const txId = await wallet.transferTokens({
  tokenIdentifier: "btkn1...",     // bech32m token id (btknrt1... on regtest)
  tokenAmount: 100n,               // BigInt
  receiverSparkAddress: "sp1p...",
});
console.log("Token transfer:", txId);
```

## Batch Transfer Tokens

Multiple recipients in a single transaction:

```javascript
const txIds = await wallet.batchTransferTokens([
  { tokenIdentifier: "btkn1...", tokenAmount: 50n, receiverSparkAddress: "sp1p..." },
  { tokenIdentifier: "btkn1...", tokenAmount: 50n, receiverSparkAddress: "sp1p..." },
]);
```

> **⚠️ `wallet.transferTokens()` and `wallet.batchTransferTokens()` have NO
> `dryRun` and NO guardrails — these calls SEND, immediately.** The allowlists,
> the sealed `tokenLimits`, the spend ledger and `dryRun` exist only on the
> `SparkAgent` wrapper, below. For sends on behalf of an operator, use the wrapper.

## Guarded sends through `SparkAgent`

```javascript
import { loadMnemonicFromEnv } from "sparkbtcbot-skill";
import { SparkAgent } from "sparkbtcbot-skill/agent";

const { agent } = await SparkAgent.create(await loadMnemonicFromEnv()); // reads SPARK_PASSPHRASE

// amount is BASE UNITS (bigint, or a number below 2^53) — for a 6-decimal
// token, 1_500_000n is 1.50 tokens. Read decimals from agent.getBalance().
const preview = await agent.transferTokens({ tokenIdentifier: "btkn1...", amount: 1_500_000n, to: "spark1...", dryRun: true });
// → { dryRun: true, operation: "token_transfer", from, to, tokenIdentifier, amount: "1500000", unit: "tokens", ... }
// show it, confirm, then call again without dryRun

const batch = await agent.batchTransferTokens(
  [
    { tokenIdentifier: "btkn1...", tokenAmount: 500_000n, receiverSparkAddress: "spark1..." },
    { tokenIdentifier: "btkn1...", tokenAmount: 500_000n, to: "spark1..." }, // `to` / `amount` aliases work too
  ],
  { dryRun: true }, // → { entries, totals: [{ tokenIdentifier, amount: "1000000" }], ... }
);

await agent.cleanup();
```

A token send through the wrapper gets the same checks as a sats send, per token:

- **Recipients** — `~/.spark/recipients.allow` and the sealed `allowedRecipients`, on every receiver (one bad entry blocks the whole batch). Enforced in dry-run mode too.
- **`tokenLimits`** (sealed) — per-token `maxPerTx` and rolling-24h `dailyBudget` as token amounts (`"25.50"`), converted with the decimals the wallet reads from the token's metadata at send time. Once sealed, a token it doesn't list is refused. So is a token whose decimals can't be read, or whose limit is more precise than the token; limits are never rounded. A batch is one transaction, so the cap sees each token's total, not each entry. Spark invoices that pay tokens (`fulfillInvoice`) are capped and counted the same way. `await agent.policy()` shows the sealed limits; `(await agent.spendStatus()).tokens` shows spent / budget / remaining per token, in token amounts. Shape and rules: `references/security.md` → Policy engine.
- **Input checks** — the identifier must decode as a token on this wallet's network (a `btknrt1…` id on a mainnet wallet is refused before anything else runs), and the amount must be a positive integer. Unknown option keys throw.
- **Failure outcome** — an SDK error that proves nothing was sent (e.g. `Insufficient token amount`) refunds the budget and rethrows. Any other failure leaves the spend counted and throws `PaymentCommittedError` (`PAYMENT_COMMITTED`). Check the token balance before sending again; a new transfer is a second payment.

A denial throws `PolicyDeniedError { rule: "tokenLimits", reason }`, or `SPEND_BUDGET_EXCEEDED` for a token's daily budget. Relay the reason and **never split the send to fit under the cap**.

## Token Identifiers

Token identifiers are bech32m-encoded:
- Mainnet prefix: `btkn1...`
- Regtest prefix: `btknrt1...`

Decode programmatically with `decodeBech32mTokenIdentifier` from the SDK's exports.

## Token Optimization

Spark tokens consist of multiple outputs that can fragment over time. The wallet has a periodic optimizer that consolidates these:

```javascript
await wallet.optimizeTokenOutputs(); // manual consolidation
wallet.startPeriodicTokenOptimization(); // auto on a schedule
```

For most agent use cases the periodic optimizer is fine — manual calls are only needed for unusual usage patterns.

## Token Allowances — delegated, operator-enforced spending (SDK ≥0.10)

Spark-sdk 0.10.0 added a delegated-spending primitive for tokens: an **owner** wallet grants a **spender** key bounded pull authority with `createTokenAllowance({ spenderPublicKey, tokenIdentifier, perTransaction, total, expiryTime, recipientAllowlist })`; the spender — authenticating as its *own* wallet — pulls funds within those bounds via `startAllowancePull` / `commitAllowancePull`; the owner can `revokeTokenAllowance` at any time (a permanent tombstone) and audit with `queryTokenAllowances`. The caps, expiry, and recipient allowlist are enforced **by every signing operator independently** — the SDK's client-side checks are preflight only.

Why this matters here: it is the first **server-enforced** spend bound anywhere in Spark this skill can point at. Everything in this skill's guardrail stack (fee caps, `maxAmountSats`, `recipients.allow`, the spend budget) lives in the agent's own process and dies with its compromise — SKILL.md says so plainly. A token allowance does not: an agent holding only a *spender* key under an allowance from a treasury wallet is bounded by the allowance even if fully compromised, because the operators refuse the over-cap pull. The trade-offs: **tokens only** (sats spend still has no server-enforced cap — the funded balance remains the only compromise-surviving bound for BTC), the treasury wallet's mnemonic must live somewhere safer than the agent, and enforcement trust shifts to the operator federation (`references/architecture.md` for that model).
