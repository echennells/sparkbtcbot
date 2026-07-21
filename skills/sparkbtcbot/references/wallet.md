# Wallet Operations (sats)

Load for any task involving Bitcoin sats — checking balance, generating deposit addresses, claiming L1 deposits, sending Spark-to-Spark, listing transfers, or withdrawing to L1.

## Check Balance

```javascript
const { balance, satsBalance, tokenBalances } = await wallet.getBalance();

// Three sats values exposed in 0.7.x:
console.log("available:", satsBalance.available); // immediately spendable
console.log("owned:    ", satsBalance.owned);     // available + locked in pending outgoing
console.log("incoming: ", satsBalance.incoming);  // pending inbound, not yet claimed

// `balance` (top-level) is deprecated; prefer satsBalance.available.

for (const [id, token] of tokenBalances) {
  console.log(`${token.tokenMetadata.tokenTicker}: ${token.ownedBalance.toString()}`);
}
```

`tokenBalances` is a `Map<Bech32mTokenIdentifier, { ownedBalance, availableToSendBalance, tokenMetadata }>`.

## Generate Deposit Address

```javascript
// Static (reusable) — receives multiple deposits to the same address
const staticAddr = await wallet.getStaticDepositAddress();

// Single-use — one-time deposit address
const singleAddr = await wallet.getSingleUseDepositAddress();
```

Both are P2TR (`bc1p...` on mainnet, `bcrt1p...` on regtest). Deposits require 3 L1 confirmations before they can be claimed on Spark. The wallet's background loop auto-claims static deposits once confirmed.

## Claim a Deposit

If auto-claim is disabled or you want explicit control. **Bound the fee** — the SSP charges a spread for sweeping the deposit UTXO on-chain, and you don't want an over-priced claim accepted blind. The SDK enforces this server-side: `claimStaticDepositWithMaxFee` rejects the claim if the fee exceeds `maxFee`.

```javascript
// Optional preview: how much will be credited?
const quote = await wallet.getClaimStaticDepositQuote(txId, vout);
console.log("credit:", quote.creditAmountSats, "sats");

// Claim with a SERVER-ENFORCED fee ceiling — rejected if the SSP fee > maxFee.
const result = await wallet.claimStaticDepositWithMaxFee({
  transactionId: txId,
  maxFee: 5000, // absolute sats; the claim fails if the fee exceeds this
  outputIndex: vout,
});
```

Note: `getUtxosForDepositAddress` returns only `{ txid, vout }` (no amount) and the quote carries only `creditAmountSats`, so there is **no** reliable client-side gross deposit amount to compute a percentage fee against — use the SDK's absolute `maxFee` ceiling above, not a client-side check. The `SparkAgent` wrapper bundles this: `agent.claimDeposit({ txid, vout, maxFeeSats, dryRun })`.

To list unclaimed UTXOs at your registered deposit addresses:

```javascript
const addrs = await wallet.queryStaticDepositAddresses();
for (const addr of addrs) {
  const utxos = await wallet.getUtxosForDepositAddress(addr, 100, 0, true);
  // utxos[i] has { txid, vout } only (no amount/value field)
}
```

## Transfer Bitcoin (Spark-to-Spark)

```javascript
const transfer = await wallet.transfer({
  receiverSparkAddress: "sp1p...",
  amountSats: 1000,
});
console.log("Transfer ID:", transfer.id);
```

Spark-to-Spark transfers are instant and zero-fee.

> **⚠️ `wallet.transfer()` has NO `dryRun` option — this call SENDS, immediately.**
> Passing `dryRun: true` (or any unknown key) does nothing: JavaScript drops it
> silently and the transfer signs and broadcasts anyway. `dryRun` exists only on
> the `SparkAgent` wrapper (`references/agent-class.md`), which is also the only
> layer that enforces the recipient allowlist and fee guards. For sends on behalf
> of an operator, prefer the wrapper; if you must use the raw SDK, never claim a
> preview happened — there is no such mode here.

## List Transfers

```javascript
const { transfers } = await wallet.getTransfers(10, 0); // limit, offset
for (const tx of transfers) {
  console.log(`${tx.id}: ${tx.totalValue} sats — ${tx.status}`);
}
```

## Withdrawal (Cooperative Exit to L1)

Move funds from Spark back to a regular Bitcoin L1 address.

### Get Fee Quote

```javascript
const quote = await wallet.getWithdrawalFeeQuote({
  amountSats: 50000,
  withdrawalAddress: "bc1q...",
});
// Total fee per speed = userFee + l1BroadcastFee — both are CurrencyAmount, read
// .originalValue (sats). Reporting only l1BroadcastFee under-states what you pay.
const totalFee = (s) =>
  (quote[`userFee${s}`]?.originalValue ?? 0) + (quote[`l1BroadcastFee${s}`]?.originalValue ?? 0);
console.log("fast:  ", totalFee("Fast"), "sats");
console.log("medium:", totalFee("Medium"), "sats");
console.log("slow:  ", totalFee("Slow"), "sats");
```

The `SparkAgent` wrapper and `lib/fee-guards.js` → `withdrawalTotalFee(quote, speed)` do this sum for you.

### Execute Withdrawal

```javascript
const result = await wallet.withdraw({
  onchainAddress: "bc1q...",
  exitSpeed: "MEDIUM",  // "FAST" | "MEDIUM" | "SLOW"
  amountSats: 50000,
});
```

Unilateral exit (without operator cooperation) is also possible as a safety mechanism, but cooperative exit is the standard path. **Discourage withdrawals under 25,000 sats** — fixed fees eat a disproportionate share. For smaller amounts route through Boltz (Spark → Lightning → L1).

## Cleanup

```javascript
await wallet.cleanup();
```

Call when shutting down to release gRPC streams. Long-running agents should keep the connection open and only cleanup on shutdown.
