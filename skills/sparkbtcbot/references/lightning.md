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
  maxFeeSats: 25,     // size to the payment — Spark→Lightning is ~0.25%, so a
                      // flat 10 silently rejects any send over ~4,000 sats.
                      // Rule of thumb: max(10, ceil(amountSats * 0.005)).
  preferSpark: true,  // route via Spark when invoice has embedded Spark address
});
```

The `SparkAgent` wrapper sizes this automatically (`lib/fee-guards.js` → `lightningFeeCap`) and, on a dry run, reports `withinCap` / `capReason` so an over-cap send is previewed rather than failing opaquely.

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

## Receive on REGTEST

REGTEST Lightning invoices have prefix `lnbcrt` (instead of `lnbc` for mainnet, `lntb` for testnet). The funded REGTEST test wallet can pay these via Spark's hosted REGTEST.
