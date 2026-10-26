# Wallet Operations (sats)

Load for any task involving Bitcoin sats — checking balance, generating deposit addresses, claiming L1 deposits, sending Spark-to-Spark, listing transfers, or withdrawing to L1. Also for what it can and can't do on L1: it is not an L1 wallet.

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

> **⚠️ The `SparkAgent` wrapper's `getBalance()` returns a DIFFERENT shape** — normalized `{ sats, tokens }`, where `sats` is `satsBalance.available` **as a string** (the three raw sats figures flattened to the spendable one) and `tokens` is a plain object, not the raw `{ satsBalance, tokenBalances }` (bigint + Map) above. Same method name, not interchangeable — the same wrapper-vs-raw divergence family as `payLightningInvoice` (`references/lightning.md` → Pay). Destructure `{ satsBalance }` from the raw wallet and `{ sats }` from the agent; crossing them yields `undefined`, which reads as a zero balance.

## On L1: what this skill can and can't do

This is a Spark wallet, not an L1 Bitcoin wallet. It doesn't scan or watch the blockchain. It can't show the balance or history of an L1 address, and it can't spend L1 coins that aren't in Spark. What it does on L1 goes through the operators, plus a few lookups the SDK makes to a block explorer (below):

| On L1 | Call | What actually happens |
|---|---|---|
| Receive on-chain bitcoin | `agent.getDepositAddress()` (static, reusable) | The operators issue a taproot address for your key combined with theirs. It is not an ordinary address from the mnemonic. Not a single-use address: see below. |
| See a deposit | `agent.listPendingDeposits()` | Asks the operators which unclaimed UTXOs sit at your deposit addresses, static and single-use, each entry tagged with its `type`. They answer only for deposit addresses they issued; any other address returns an error. |
| Move a deposit into Spark | `agent.claimDeposit({ txid, vout, maxFeeSats })` | After 3 confirmations, with the SSP's spread taken (below). Nothing shows in `getBalance()` until it's claimed. A single-use deposit can't be claimed right now (below). The raw SDK also has SSP-priced instant claims (`getInstantStaticDepositQuote` / `claimInstantStaticDeposit`, 0–1 confirmations). Neither is wrapped or tested here. |
| Return an unclaimed static deposit to L1 | raw `wallet.refundStaticDeposit({ depositTransactionId, destinationAddress, satsPerVbyteFee })` | The operators co-sign and you get the transaction hex; `refundAndBroadcastStaticDeposit` also broadcasts it. Not wrapped. |
| Send to an L1 address | `agent.withdraw({ to, amount })` | A cooperative exit from the Spark balance to any address, including silent payment addresses (below). Flat fee, deducted from the amount. |
| Follow a withdrawal | `result.coopExitTxid`; raw `wallet.getCoopExitRequest(id)` | The txid, and the SSP's record of the request. That's what the operators report, not a chain lookup. |
| Exit without the operators | the leaf-vault backup, then Blink's exit tool | Runs outside this skill: `references/unilateral-exit.md`. |
| Recover a leaf a watchtower exit cut off | raw `wallet.recoverWatchtowerExitedLeaf(...)` | The operators co-sign a spend of the leftover output: `references/unilateral-exit.md`. |
| Broadcast a transaction | raw `wallet.broadcastTx(hex)` | Posts a transaction you already have to the SDK's block explorer (below). It builds nothing. |

**What it can't do:**

- **Read any other L1 address.** That includes addresses another wallet app derives from this same mnemonic: Spark's keys sit at `m/8797555'/…`, and nothing here scans the paths ordinary wallets use. It also includes a withdrawal's destination once the coins land, and the SDK's `getTokenL1Address()`, which nothing reads or spends. The SDK's one address lookup, the deprecated `getLatestDepositTxId`, is a block-explorer query: see below.
- **Spend L1 coins outside Spark.** There is no coin selection, PSBT or signing for arbitrary UTXOs. To use on-chain coins here, send them to the deposit address and claim them.
- **Estimate on-chain fees** beyond the SSP's quotes for withdrawals and claims.
- **Watch the chain.** Nothing alerts on incoming coins except deposits the operators report.

**The SDK's block-explorer calls.** For a few jobs the SDK skips the operators and queries one Esplora server (a block-explorer API) itself: `mempool.space` on MAINNET, and a regtest explorer built into the SDK on REGTEST. Wallet methods use the `electrsUrl` wallet option instead when it's set; the two standalone helpers at the bottom of the table below always use the built-in server. Each request shows that server your IP and the txid or address asked about.

| Call | What it asks the explorer |
|---|---|
| `agent.claimDeposit` (via `claimStaticDepositWithMaxFee`), single-use `claimDeposit(txid)`, `claimMultiUtxoDeposit`, `refundStaticDeposit` | The deposit transaction, by txid, every time |
| `getClaimStaticDepositQuote`, `claimStaticDeposit`, `getInstantStaticDepositQuote` | The same, but only when called without a `vout`. The wrapper always passes one. |
| `broadcastTx`, `refundAndBroadcastStaticDeposit` | Posts the transaction |
| `getWatchtowerExitedLeaves`, `recoverWatchtowerExitedLeaf` | Which transaction spent an output, and transaction hex |
| standalone `constructUnilateralExitFeeBumpPackages` | Whether each exit transaction is already known (`isTxBroadcast`) |
| standalone, deprecated `getLatestDepositTxId(address)` | The newest transaction at any address, Spark or not |

Balance, transfers, Lightning, withdrawals and `listPendingDeposits()` don't touch it, and nothing asks it for a balance, a UTXO list, confirmations or a fee rate.

**`getLatestDepositTxId` is not an L1 balance check.** Despite the name, it takes any address (checked on REGTEST against an ordinary P2WPKH address). It returns one txid, with no amount, confirmations or history. It returns `null` when the address is unused, when its newest transaction spends from it rather than paying it, and when the server answers with an error (seen on REGTEST for a busy address), so a `null` never means nothing arrived. Calling it is a block-explorer lookup like any other: the user's call, not something to run quietly. The SDK will remove it in a future release.

**What to tell people:**

- **Anyone paying on-chain gets the deposit address**, from `getDepositAddress()`. Never derive or hand out another L1 address from the mnemonic.
- **Coins sent to any other address don't show up here.** Say the agent can't see that address. Don't report that nothing arrived, and don't quietly look it up on an explorer, `getLatestDepositTxId` included.
- **"Did my withdrawal land?"** Give the `coopExitTxid`; the recipient's wallet or a block explorer shows it. Looking it up on an explorer is the user's call, since the explorer learns what was asked.
- **Watching L1 addresses or spending L1 coins** needs a separate Bitcoin wallet with its own chain source. This skill doesn't include one.

## Generate Deposit Address

```javascript
// Static (reusable) — receives multiple deposits to the same address
const staticAddr = await wallet.getStaticDepositAddress();
```

> **⚠️ Don't use single-use deposit addresses.** The operators currently refuse the step that claims them: `finalize_deposit_tree_creation` answers `UNAVAILABLE` on MAINNET and REGTEST (2026-10-26), and a real 2,000-sat mainnet deposit was refused. Coins sent to one stay at the address, visible but unclaimable until the operators switch the claim back on, and the SDK has no refund path for single-use deposits. `agent.getSingleUseDepositAddress()` refuses (`SINGLE_USE_DEPOSITS_UNAVAILABLE`); the raw `wallet.getSingleUseDepositAddress()` still hands one out, so don't call it. The SSP still answers a claim quote for a single-use deposit, then refuses the claim ("Static deposit address … not found"). That quote prices a claim the SSP won't make, so it is no proof a deposit can be claimed, and its number says nothing about what a single-use deposit will credit: never quote one to a user. `agent.claimDeposit` asks the operators where the deposit sits before it quotes, dry runs included. `tests/integration/funded/single-use-deposit.test.js` fails the day claims work again.

**One address per order or per customer?** The static address is one reusable address per wallet; there is no claimable per-payer on-chain address. To tell payers apart, give each order its own invoice from `agent.createTrackedInvoice(amountSats, memo)` (an amount is required): keep the `id` it returns with the order, and read `agent.getInvoiceStatus(id)`. Put only the order number in the memo; the payer's wallet shows it.

| `state` | Meaning | What the shop does |
|---|---|---|
| `unpaid` | Nobody has paid yet | Wait; once `canReinvoice` is true, a new invoice is safe |
| `in_progress` | The payment is arriving | Wait. Never re-invoice |
| `received` | The customer has paid; the sats are on their way to this wallet | Treat as paid; don't re-invoice |
| `paid` (`paid: true`) | The sats are in this wallet | Done |
| `failed` | It failed before the customer was charged | Not paid. Re-invoice only once `canReinvoice` is true |
| `failed_after_payment` | The customer was charged, but the sats didn't reach this wallet | Don't re-invoice; take it up with Spark |
| `unknown` | A status this SDK can't name | Treat as in progress |

`canReinvoice` turns true only two minutes after the invoice expired, and only while `unpaid` or `failed`. An early failure may not be final: the SSP may retry while the payer's payment is still held, and the payer can pay again until the invoice expires. A new invoice before then could charge the customer twice. These state meanings are inferred from the order of a receive (the SSP's schema and the operators' code in the Spark repo), not documented by Spark. On hosted REGTEST (2026-10-26) a paid invoice went from `INVOICE_CREATED` to `TRANSFER_COMPLETED` between two polls 150 ms apart, a payment made while the shop wallet was closed read `TRANSFER_COMPLETED` as soon as it reopened, and no in-between status was ever seen. An expired invoice stayed `INVOICE_CREATED`, and paying it is refused (`INVOICE_EXPIRED`, `references/lightning.md`).

- **Not `createLightningInvoice`.** Its invoice carries a Spark fallback by default, and a Spark wallet then pays it with a plain transfer: the money arrives, but the invoice never shows as paid (hosted REGTEST, 2026-10-26). `createTrackedInvoice` leaves the fallback out, so every payer pays over Lightning, with the routing fee on the payer.
- **Not the on-chain address.** Everyone gets the same address, and its transactions are public on the chain, so a txid a customer sends you proves nothing: anyone can name someone else's payment. Take order payments over Lightning. Use the deposit address only where it doesn't matter who paid (topping up the wallet), or settle such payments by hand with the payer.

**Coins already at a single-use address** (handed out by an older version of this skill, or by the raw SDK): `listPendingDeposits()` shows them as `type: "single-use"`, and `claimDeposit` refuses them with the reason. Tell the user they arrived and are waiting on the operators, never that nothing arrived, and two things:

- **Back up the recovery words now** if they haven't, in their own terminal: `npm exec --no -- sparkbtcbot reveal-mnemonic` (installed package) or `npm run reveal-mnemonic` (cloned repo). The address belongs to this wallet's key together with the operators', so if the operators switch the claim back on, only this wallet can claim the coins.
- **Follow the operators' answer** at [buildonspark/spark#165](https://github.com/buildonspark/spark/issues/165).

`listPendingDeposits()` finds them through the operators' list of unused deposit addresses, which dropped the funded mainnet address once in two hours of retries (the SDK then said "Deposit address has already been used"), so one empty answer about a single-use address isn't conclusive either. For the same reason `claimDeposit`'s `DEPOSIT_NOT_FOUND` means "not claimable here now", never "the coins went somewhere else".

The static address is P2TR (`bc1p...` on mainnet, `bcrt1p...` on regtest) — an **L1 on-chain** address, NOT a Spark (`sp1...`) address. Deposits require 3 L1 confirmations before they can be claimed on Spark (the SSP refuses to even quote before then). **Claiming is manual — there is no auto-claim** (the funds sit unclaimed at the address until you claim them).

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
// Optional preview: how much will be credited? Only for a deposit at your
// STATIC address: the SSP also quotes a single-use deposit it won't claim.
const quote = await wallet.getClaimStaticDepositQuote(txId, vout);
console.log("credit:", quote.creditAmountSats, "sats");

// Claim with a SERVER-ENFORCED fee ceiling — rejected if the SSP fee > maxFee.
const result = await wallet.claimStaticDepositWithMaxFee({
  transactionId: txId,
  maxFee: 5000, // absolute sats; the claim fails if the fee exceeds this
  outputIndex: vout,
});
```

Note: `getUtxosForDepositAddress` returns only `{ txid, vout }` (no amount) and the quote carries only `creditAmountSats`, so there is **no** reliable client-side gross deposit amount to compute a percentage fee against — use the SDK's absolute `maxFee` ceiling above, not a client-side check. The `SparkAgent` wrapper bundles this: `agent.claimDeposit({ txid, vout, maxFeeSats, dryRun })` checks with the operators that the deposit sits at the static address, then claims with a ceiling of `maxFeeSats`, or by default the lower of `maxFeePct` (10%) of the quoted credit and 25,000 sats.

### "Did my deposit arrive?" — check status, don't trust the balance

`getBalance()` returns **claimed Spark balance only** — a deposit that confirmed on L1 but hasn't been claimed yet is **invisible** there, so an agent that answers "did it arrive?" from `getBalance()` says "no" for funds sitting unclaimed at the address. To actually check, list the confirmed-but-unclaimed UTXOs at your deposit addresses. The `SparkAgent` wrapper bundles this:

```javascript
const pending = await agent.listPendingDeposits();
// -> [{ address, txid, vout, type }, ...]  (empty array = nothing landed yet)
for (const d of pending.filter((d) => d.type === "static")) {
  // claimDeposit checks with the operators itself and refuses a single-use one
  await agent.claimDeposit({ txid: d.txid, vout: d.vout, maxFeeSats });
}
```

Under the hood it's the two raw-SDK calls (use these directly if you're not on the wrapper):

```javascript
const statics = await wallet.queryStaticDepositAddresses();
// Unclaimed single-use addresses too: coins an older version sent there have arrived.
const singles = (await wallet.getUnusedDepositAddresses()).filter((a) => !statics.includes(a));
for (const addr of [...statics, ...singles]) {
  const utxos = await wallet.getUtxosForDepositAddress(addr, 100, 0, true); // excludeClaimed=true
  // utxos[i] has { txid, vout } only (no amount/value field). Claim only the static
  // ones (claimStaticDepositWithMaxFee); a single-use one can't be claimed now.
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

> **⚠️ Pass sats amounts to the raw SDK as a `Number`, not a `BigInt`.** The SDK validates every amount with `Number.isSafeInteger()`, which returns **`false` for all BigInts** — so `amountSats: 8258n` throws a misleading `"Sats amount must be less than 2^53"` even for tiny values, while `amountSats: 8258` works. This bites because `getBalance()` returns balances as **`bigint`**, so it's natural to pass one straight back into `transfer`/`withdraw`. Convert first: `amountSats: Number(balance.available)` (real sats are always < 2^53, so the cast is lossless). The `SparkAgent` wrapper handles this for you — its amount methods accept number *or* bigint and normalize — but the raw SDK does not.

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
  // valueReceivedByWallet / valueSentByWallet (SDK ≥0.12) are THIS wallet's share of a
  // transfer; `totalValue` is deprecated — the whole transfer across every receiver.
  // Both derive from leaves the operators return under include_all_participants; an
  // operator too old to honor the flag projects the transfer down to this wallet and
  // valueSentByWallet silently under-reports (the response is indistinguishable).
  console.log(`${tx.id}: ${tx.valueReceivedByWallet || tx.valueSentByWallet} sats — ${tx.status}`);
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

### Silent payment addresses (spark-sdk ≥ 0.14)

`withdraw` and `getWithdrawalFeeQuote` also accept a version 0 BIP-352 silent payment address as the destination: `sp1q…` on MAINNET, `tsp1q…` on testnet/signet, `sprt1q…` on REGTEST. It is the same call, the same quote, and the same flat fee. Through the wrapper, nothing changes:

```javascript
const preview = await agent.withdraw({ to: "sp1q…", amount: 50_000, dryRun: true }); // fee guard applies as usual
const result = await agent.withdraw({ to: "sp1q…", amount: 50_000 });
console.log(result.coopExitTxid); // hand this to the recipient (see below)
```

What the SDK checks: before it signs anything, it verifies the SSP's proof that the exit transaction's output 0 pays the address for at least `amount − fee`. A mismatch, or an address for another network, fails the withdrawal before any leaf moves.

What to know:

- **The address does not appear on chain.** The output is a taproot output derived from the address and the exit transaction's inputs. An explorer search for the `sp1q…` string finds nothing. Give the recipient `result.coopExitTxid`; their silent-payment wallet finds the output by scanning. Don't tell a user the withdrawal "isn't showing" because the address has no history.
- **The txid is not proof of who was paid.** The SDK checks the SSP's proof that output 0 pays the address, then discards it; `withdraw` returns the exit's txid, not the proof. The recipient's wallet finds the payment by scanning, but nobody else can confirm from the chain that the output pays that address. In a dispute, the recipient's scan is the only check.
- **The recipient's wallet must support receiving silent payments.** Only such a wallet produces these addresses, so this mostly comes up when a user pastes one.
- **`sp1…` is also the legacy Spark address prefix.** `sp1q…` / `sprt1q…` (a `q` right after the `1`) is a silent payment address, an L1 destination for `withdraw`. `sp1p…` is a legacy Spark address, for `transfer`. Don't route by prefix alone. A Spark `transfer` to a silent payment address fails before anything moves, and its `dryRun` preview now refuses it too, pointing to `withdraw`.
- **Allowlist entries match exactly.** Put the whole address on one line of `~/.spark/recipients.allow`. These addresses are long (116+ characters).
- **Not supported for `refundStaticDeposit()` or `recoverWatchtowerExitedLeaf()`.** Both throw an explicit unsupported-operation error; use a regular address there.

Tested on REGTEST through `SparkAgent.withdraw` (`tests/integration/funded/silent-payment-withdraw.test.js`). The exit's output 0 carried exactly `amount − quoted fee`, and an independent BIP-352 scan, checked against the BIP's test vectors, matched it to the receiver's keys and no others.

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
     options: sparkWalletOptions(network, { optimizationOptions: { auto: false } }), // from sparkbtcbot-skill; ladders off
   });
   ```
2. **Let it settle before cleanup** if you *want* the optimization to happen in-process — a few seconds is usually enough, but it's a timing guess, not a guarantee (a multi-swap optimization can take longer):
   ```javascript
   await new Promise((r) => setTimeout(r, 5000));
   await wallet.cleanup();
   ```

**Long-running agents don't need either** — keep the wallet open, let optimization run continuously, and only `cleanup()` on shutdown. The interruption at shutdown is a one-time event that resumes on next boot. This whole hazard is specific to short-lived, value-moving scripts.
