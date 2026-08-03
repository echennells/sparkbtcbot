# Lightning Interop (BOLT11)

Load for any task involving Lightning Network — creating BOLT11 invoices, paying BOLT11 invoices, fee estimation. Spark wallets are fully BOLT11-compatible, so they interoperate with the entire Lightning Network.

Receiving from Lightning costs **0.15%** (charged via route hints). Sending to Lightning costs **0.25% + routing fees**.

## Create Lightning Invoice (Receive)

```javascript
const invoiceRequest = await wallet.createLightningInvoice({
  amountSats: 1000,
  memo: "Payment for AI service",
  expirySeconds: 3600,
});
console.log("BOLT11:", invoiceRequest.invoice.encodedInvoice);
```

Pass `includeSparkAddress: true` to embed a Spark address in the invoice's route hints. Spark-aware payers will then route via Spark (instant, free) instead of Lightning (0.15% + routing).

## Pay Lightning Invoice (Send)

### Estimate Fee First

```javascript
const fee = await wallet.getLightningSendFeeEstimate({
  encodedInvoice: "lnbc...",
});
console.log("Estimated fee:", fee, "sats");
```

For zero-amount invoices, also pass `amountSats`.

### Pay

```javascript
const result = await wallet.payLightningInvoice({
  invoice: "lnbc...",
  maxFeeSats: 10,
  preferSpark: true,  // route via Spark when invoice has embedded Spark address
});
```

### Polling for Async Completion

If `payLightningInvoice` returns immediately with `status === "LIGHTNING_PAYMENT_INITIATED"` and no preimage, poll:

```javascript
let preimage = result.paymentPreimage;
if (!preimage && result.id) {
  for (let i = 0; i < 15; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const status = await wallet.getLightningSendRequest(result.id);
    if (status?.paymentPreimage) { preimage = status.paymentPreimage; break; }
    if (status?.status === "LIGHTNING_PAYMENT_FAILED") throw new Error("Payment failed");
  }
}
```

## Lightning → L1 Off-Ramp (via Spark)

Load this pattern when someone holding sats on Lightning wants them on-chain. With third-party submarine-swap services unreliable (Boltz disabled all swaps indefinitely in August 2026), Spark itself is a self-contained Lightning→L1 bridge: **receive over Lightning into Spark, then cooperative-exit to L1.** The whole route depends only on the Spark operators — no external swap provider.

Route and costs (two legs):

1. **Lightning → Spark**: pay a Spark-created BOLT11 from any Lightning wallet. Fee: 0.15% of the amount.
2. **Spark → L1**: cooperative exit. Fee: flat, amount-independent — live MAINNET quote 2026-08-03 was 2,430 sats at MEDIUM (750 operator + 1,680 L1 broadcast; the L1 part moves with the mempool). See `references/wallet.md` for the full fee table.

Worked example at 100,000 sats: 150 (0.15%) + ~2,430 = ~2,580 sats ≈ **2.6% total**; at 1M sats ≈ **0.4%**. The flat exit fee means this route is uneconomical below ~25,000 sats and cheap at size — batch small amounts before bridging.

```javascript
// Leg 1 — receive from Lightning into Spark
const invoiceRequest = await wallet.createLightningInvoice({
  amountSats: 100_000,
  memo: "bridge to L1",
  expirySeconds: 3600,
});
// Hand invoiceRequest.invoice.encodedInvoice to the Lightning-side payer,
// then wait for the transfer:claimed event (see Events in wallet.md).

// Leg 2 — quote, confirm with the user, then exit to L1
const quote = await wallet.getWithdrawalFeeQuote({
  amountSats: 100_000,
  withdrawalAddress: "bc1q...",
});
// Sum userFee + l1BroadcastFee for the chosen speed and SHOW THE USER
// the total before executing. Then:
const result = await wallet.withdraw({
  onchainAddress: "bc1q...",
  exitSpeed: "MEDIUM",
  amountSats: 100_000,
  feeQuote: quote, // bind the exit to the quote you just showed
});
```

Passing `feeQuote` matters: it pins the executed exit to the fee you previewed instead of letting it be re-priced at broadcast.

## L1 → Lightning On-Ramp (via Spark)

The reverse direction — on-chain sats becoming Lightning spending power without opening a channel (the other job swap services used to do). Two legs: deposit L1 into Spark, then pay out over Lightning.

1. **L1 → Spark**: send to the wallet's static deposit address (`getStaticDepositAddress()`), wait for confirmations, then claim. Costs: your miner fee **plus an SSP claim spread** taken at claim time. The spread cannot be computed in advance — **always preview with `getClaimStaticDepositQuote(txid, vout)` and claim with an explicit `maxFee` you accept**; small deposits are fee-dominated.
2. **Spark → Lightning**: pay any BOLT11. Cost: 0.25% + routing fees.

```javascript
// Leg 1 — deposit, then claim with a previewed fee ceiling
const depositAddress = await wallet.getStaticDepositAddress();
// ... send L1 funds to depositAddress, wait for confirmation ...
const quote = await wallet.getClaimStaticDepositQuote(txid, 0);
// Show the user creditAmountSats vs the deposit before claiming:
const claimed = await wallet.claimStaticDepositWithMaxFee({
  transactionId: txid,
  outputIndex: 0,
  maxFee: /* a ceiling you actually accept, from the quote */,
});

// Leg 2 — pay out over Lightning (0.25% + routing)
await wallet.payLightningInvoice({ invoice: "lnbc...", maxFeeSats: 25 });
```

Slower than the off-ramp direction (leg 1 waits for on-chain confirmations) and its first-leg cost is variable where the off-ramp's is quotable — state both to the user up front.

## Receive on REGTEST

REGTEST Lightning invoices have prefix `lnbcrt` (instead of `lnbc` for mainnet, `lntb` for testnet). The funded REGTEST test wallet can pay these via Spark's hosted REGTEST.
