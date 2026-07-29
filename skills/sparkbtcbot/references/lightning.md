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
  maxFeeSats: 30,     // size to the payment — Spark→Lightning is ~0.25% PLUS a
                      // flat component (a live 4,464-sat send estimated 25 sats),
                      // so a flat 10 rejects mid-size sends and a pure 0.5% can
                      // too. Rule of thumb: max(25, ceil(amountSats * 0.005)),
                      // or better, estimate first and cap at estimate + headroom.
  preferSpark: true,  // route via Spark when invoice has embedded Spark address
});
```

**Zero-amount (amountless) invoices:** the raw call above takes `amountSatsToSend` — NOT `amountSats` — and the SDK enforces it both ways: it throws `"must specify amountSatsToSend"` for a zero-amount invoice without it, and throws `"can only specify amountSatsToSend"` if you pass it for an invoice that already carries an amount. (Note the estimate call above uses a *different* name, `amountSats`.) The `SparkAgent` wrapper takes `amountSats` in both cases and forwards `amountSatsToSend` only when the invoice is amountless.

The `SparkAgent` wrapper sizes `maxFeeSats` automatically (`lib/fee-guards.js` → `lightningFeeCap`) and, on a dry run, reports `withinCap` / `capReason` so an over-cap send is previewed rather than failing opaquely.

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
