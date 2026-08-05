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

Both are P2TR (`bc1p...` on mainnet, `bcrt1p...` on regtest) — an **L1 on-chain** address, NOT a Spark (`sp1...`) address. Deposits require 3 L1 confirmations before they can be claimed on Spark (the SSP refuses to even quote before then). **Claiming is manual — there is no auto-claim** (the funds sit unclaimed at the address until you claim them).

> **⚠️ Sizing the deposit when it's funding a payment — the #1 on-ramp mistake.** If you are depositing to then pay something (a Lightning invoice, a merchant), **the amount you deposit is NOT the amount that lands on Spark.** Claiming takes an SSP spread, so `credited = deposited − spread` (live: 297 sats on 10,350; ~396 on ~10,100 — feerate-dependent, hundreds of sats). Telling the user to send "invoice + Lightning fee" **under-funds every time** and forces a second deposit. Use the helper — it sums all three legs (invoice + Lightning routing + claim-spread buffer + slack):
>
> ```javascript
> import { estimateOnrampDeposit } from "sparkbtcbot-skill";
> const { depositSats } = estimateOnrampDeposit({
>   invoiceSats: 10_000,
>   lightningFeeSats: /* agent.estimateLightningFee(bolt11), or omit for the cap */,
> });
> // → ~10,700; tell the user to send AT LEAST depositSats, never "invoice + fee".
> ```
>
> Then pay from the **actual credited balance** after claiming (`quote.creditAmountSats`), not the number you quoted. Full flow + the invoice-expiry precheck: `references/lightning.md` → "L1 → Lightning On-Ramp".

## Claim a Deposit

**Bound the fee** — the SSP charges a spread for sweeping the deposit UTXO on-chain, and you don't want an over-priced claim accepted blind. The SDK enforces this server-side: `claimStaticDepositWithMaxFee` rejects the claim if the fee exceeds `maxFee`. Live-measured 2026-08-04: a 10,350-sat deposit quoted a **297-sat spread**, honored exactly at claim (~150 vB at the moment's feerate — consistent with the SSP pricing its future sweep, i.e. flat-ish and feerate-tracking, not a percentage). The claim credit is **asynchronous**: the call returns a transferId and the balance lands ~30 seconds later — an unchanged balance right after claiming is not a failure, so never re-claim on sight of it.

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

Two caveats about quoting: it is **not read-only** — if the wallet's leaves don't exactly match the requested amount, the quote call triggers an SSP swap that permanently restructures the leaf set (no fee, but not side-effect-free). And quotes **expire** (`quote.expiresAt`) — execute promptly after showing the user.

### Execute Withdrawal

```javascript
const feeSats = withdrawalTotalFee(quote, "MEDIUM");
const result = await wallet.withdraw({
  onchainAddress: "bc1q...",
  exitSpeed: "MEDIUM",  // "FAST" | "MEDIUM" | "SLOW"
  amountSats: 50000,
  feeQuoteId: quote.id,   // bind the exit to the quote you just showed...
  feeAmountSats: feeSats, // ...and the exact fee you previewed
});
```

Binding `feeQuoteId` + `feeAmountSats` pins the executed exit to the previewed fee instead of letting it be re-priced at broadcast (the older `feeQuote` object param does the same but is deprecated). The `SparkAgent` wrapper does this for you.

### Fee structure (why size matters)

The total fee is **flat with respect to amount**: `userFee` (operator's fee — 750 sats flat on every live 2026-08 quote) + `l1BroadcastFee` (tracks the current feerate). And it is **deducted from `amountSats`, not charged on top**: the L1 address receives `amount − fee` (live-validated: an 8,000-sat exit with a 1,950-sat quote delivered exactly 6,050 on-chain). That's the SDK default — `deductFeeFromWithdrawalAmount: true`; pass `false` to charge the fee on top instead. Tell the user the *net* they'll receive before executing.

| Amount | Fee (MEDIUM, calm-mempool snapshot) | Share |
|---|---|---|
| 5,000 sats | ~2,430 | ~49% |
| 25,000 | ~2,430 | ~10% |
| 100,000 | ~2,430 | ~2.4% |
| 1,000,000 | ~2,430 | ~0.24% |

Unilateral exit (without operator cooperation) is also possible as a safety mechanism — see `references/unilateral-exit.md` — but cooperative exit is the standard path. **Discourage withdrawals under 25,000 sats** and batch small balances into one larger exit. Third-party swap routes (Boltz) are no longer a dependable alternative — Boltz disabled all swaps indefinitely in August 2026.

## Cleanup

```javascript
await wallet.cleanup();
```

Call when shutting down to release gRPC streams. Long-running agents should keep the connection open and only cleanup on shutdown.

### One-shot scripts that move value: don't race the leaf optimizer

After any balance-changing op (claim, pay, transfer, withdraw) the SDK kicks off a **detached** background job — `autoOptimizeIfNeeded` — that rebalances your internal UTXO "leaves." It is *not* awaited by the call that returned. If you call `cleanup()` immediately afterward, you tear down the gRPC streams mid-optimization and the SDK logs:

```
Failed to claim transfer after all retries.
Error: Claim transfer process was interrupted due to cleanup
```

**This does not lose funds.** The value-moving op itself already completed on-chain/on-Spark; only the internal leaf-consolidation was interrupted, and it resumes on the next `SparkWallet.initialize`. But it's alarming in logs and leaves leaf state half-reconciled (you'll see the balance settle over a few re-inits), and — for this skill specifically — a leaf-vault snapshot flushed at that moment can capture a mid-swap leaf set. It's deterministic: any one-shot script that moves value and then cleans up in the same process hits it.

Two ways to avoid it, in order of preference:

1. **Disable auto-optimization for the one-shot** (deterministic — nothing to interrupt). Optimization is a denomination-consolidation nicety, not a correctness requirement; deferring it to the next long-running session costs nothing:
   ```javascript
   const { wallet } = await SparkWallet.initialize({
     mnemonicOrSeed: mnemonic,
     options: { network, optimizationOptions: { auto: false } },
   });
   ```
2. **Let it settle before cleanup** if you *want* the optimization to happen in-process — a few seconds is usually enough, but it's a timing guess, not a guarantee (a multi-swap optimization can take longer):
   ```javascript
   await new Promise((r) => setTimeout(r, 5000));
   await wallet.cleanup();
   ```

**Long-running agents don't need either** — keep the wallet open, let optimization run continuously, and only `cleanup()` on shutdown. The interruption at shutdown is a one-time event that resumes on next boot. This whole hazard is specific to short-lived, value-moving scripts.
