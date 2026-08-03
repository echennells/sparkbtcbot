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
// TOTAL fee per speed = userFee (operator's fee) + l1BroadcastFee. Sum both —
// the operator fee was ~30% of the total on a live MAINNET quote.
for (const s of ["Fast", "Medium", "Slow"]) {
  const total = Number(quote[`userFee${s}`]?.originalValue ?? 0)
              + Number(quote[`l1BroadcastFee${s}`]?.originalValue ?? 0);
  console.log(`${s}: ${total} sats`);
}
```

### Execute Withdrawal

```javascript
const result = await wallet.withdraw({
  onchainAddress: "bc1q...",
  exitSpeed: "MEDIUM",  // "FAST" | "MEDIUM" | "SLOW"
  amountSats: 50000,
});
```

Unilateral exit (without operator cooperation) is also possible as a safety mechanism, but cooperative exit is the standard path.

### Fee structure (why size matters)

The total fee is **flat with respect to amount**: `userFee` (operator's fee) + `l1BroadcastFee` (tracks the current feerate). Live MAINNET quote 2026-08-03 (calm mempool): 2,430 sats total at MEDIUM — 750 user + 1,680 L1 — identical for a 1,000-sat and an 8,500-sat withdrawal.

**The fee is deducted from `amountSats`, not charged on top**: the L1 address receives `amount − fee`. Live-validated 2026-08-03: an 8,000-sat withdrawal with a 1,950-sat quote debited exactly 8,000 from Spark and delivered exactly 6,050 on-chain. Tell the user the *net* they'll receive before executing.

| Amount | Fee (MEDIUM, snapshot) | Share |
|---|---|---|
| 5,000 sats | 2,430 | ~49% |
| 25,000 | ~2,430 | ~10% |
| 100,000 | ~2,430 | ~2.4% |
| 1,000,000 | ~2,430 | ~0.24% |

**Discourage withdrawals under 25,000 sats** — the flat fee eats a disproportionate share. Batch small balances into one larger exit instead of several small ones, and always fetch a fresh quote (the L1 component moves with the mempool). Third-party swap routes (Boltz) are no longer a dependable alternative — see SKILL.md's exit-cost section.

## Cleanup

```javascript
await wallet.cleanupConnections();
```

Call when shutting down to release gRPC streams. Long-running agents should keep the connection open and only cleanup on shutdown.
