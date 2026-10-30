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

Each entry has `ownedBalance` (total) and `availableToSendBalance` (excludes pending outbound). For "what can I spend right now," use `availableToSendBalance`; the agent's `getBalance().tokens[id]` gives both, as `balance` and `available`. Neither figure proves a send left (after a send in doubt, `balance` can read unchanged): `getTokenTransactions()` is the check.

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
