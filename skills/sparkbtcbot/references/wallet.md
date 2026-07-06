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

If auto-claim is disabled or you want explicit control:

```javascript
const quote = await wallet.getClaimStaticDepositQuote(txId, vout);
const result = await wallet.claimStaticDeposit({
  transactionId: txId,
  creditAmountSats: quote.creditAmountSats,
  sspSignature: quote.signature,
  outputIndex: vout,
});
```

To list unclaimed UTXOs at your registered deposit addresses:

```javascript
const addrs = await wallet.queryStaticDepositAddresses();
for (const addr of addrs) {
  const utxos = await wallet.getUtxosForDepositAddress(addr, 100, 0, true);
  // utxos[i] has { txid, vout, amount, ... }
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
console.log("fast:  ", quote.l1BroadcastFeeFast?.originalValue, "sats");
console.log("medium:", quote.l1BroadcastFeeMedium?.originalValue, "sats");
console.log("slow:  ", quote.l1BroadcastFeeSlow?.originalValue, "sats");
```

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
