# Spark Native Invoices

Load when working with Spark's native invoice format (distinct from BOLT11 Lightning invoices). Spark invoices can request payment in sats or in tokens.

> **⚠️ Who can pay these: only other Spark-SDK wallets, via `fulfillSparkInvoice`.**
> No consumer wallet (Xverse, Lightning wallets, on-chain wallets) can pay a native
> Spark invoice today. The invoice is address-*shaped* — same bech32m `spark1…`
> prefix as a bare Spark address, roughly 3× longer, with a signed payment request
> embedded — which makes it easy to hand to a human as "an address" that nothing
> they have can pay. For receiving from people (rather than from other SDK agents),
> see SKILL.md's "Receiving: which artifact to hand out" — the default is a BOLT11
> Lightning invoice with `includeSparkAddress: true`. Note the SDK enforces the
> split on the payer side too: `wallet.transfer()` to an invoice-bearing address
> throws — invoices are payable only with `fulfillSparkInvoice`.

## Create Sats Invoice

```javascript
const invoice = await wallet.createSatsInvoice({
  amount: 1000,
  memo: "Spark native payment",
});
```

## Create Token Invoice

```javascript
const invoice = await wallet.createTokensInvoice({
  amount: 100n,
  tokenIdentifier: "btkn1...",
  memo: "Token payment request",
});
```

## Fulfill (Pay) a Spark Invoice

`fulfillSparkInvoice` accepts an array — one or many invoices in a single batch:

```javascript
// Invoices use the CURRENT address encoding: "spark1..." on mainnet
// ("sparkrt1..." regtest) — the legacy short "sp1..." prefix is not a valid
// invoice and the SDK rejects it here.
const result = await wallet.fulfillSparkInvoice([
  { invoice: "spark1...", amount: 1000n },
]);

for (const success of result.satsTransactionSuccess) {
  console.log("Paid:", success.invoice);
}
for (const err of result.satsTransactionErrors) {
  console.log("Failed:", err.invoice, err.error.message);
}
```

For token invoices the result has `tokenTransactionSuccess` / `tokenTransactionErrors` arrays of the same shape.

## Spark Invoice Embedded in BOLT11

When you create a Lightning invoice with `includeSparkAddress: true`, the resulting BOLT11 carries the Spark address in route hints. Spark-aware payers can detect this and route via Spark (instant, free) instead of paying Lightning routing fees. The recipient can call `getLightningReceiveRequest(id)` and read `sparkInvoice` to get the embedded Spark invoice directly without decoding the BOLT11 manually.
