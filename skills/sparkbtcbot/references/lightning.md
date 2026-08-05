# Lightning Interop (BOLT11)

Load for any task involving Lightning Network — creating BOLT11 invoices, paying BOLT11 invoices, fee estimation. Spark wallets are fully BOLT11-compatible, so they interoperate with the entire Lightning Network.

Receiving from Lightning costs **0.15%** (charged via route hints) — though a live 6,500-sat mainnet receive (2026-08-03) was credited in full with no fee taken; treat 0.15% as the worst case, not a guarantee of the charge. Sending to Lightning costs **0.25% + routing fees** (live-measured 0.32% all-in on a 5,000-sat send).

**When the payee is also Spark-backed, a BOLT11 settles Spark-direct: instant and free.** Live-measured: a 10,000-sat invoice from a Spark-backed wallet cost exactly 0 (the 26-sat Lightning estimate was never charged). The payment then completes as a *Spark transfer* — `getLightningSendRequest` has **no record of it**, so a missing send-request is not a failed payment; check the balance delta or transfer list before concluding failure (and never retry-pay on that evidence alone).

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

A BOLT11 is **time-bounded** — it carries an expiry (default 3600s from creation; often shorter). Paying an expired invoice fails at the SDK, but the real hazard is a flow that spends time or money *before* the pay call (the L1 on-ramp below, a confirm-with-the-user pause, a queued job): the invoice can lapse in that gap. Cheap insurance — decode the remaining life and refuse early rather than after you've committed:

```javascript
import { invoiceSecondsRemaining, invoiceIsExpired } from "sparkbtcbot-skill";
if (invoiceIsExpired(bolt11)) throw new Error("invoice already expired — ask for a fresh one");
// or, when a delay is coming, gate on a buffer: invoiceSecondsRemaining(bolt11) < BUFFER
```

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

## Lightning → L1 Off-Ramp (via Spark)

Load this pattern when someone holding sats on Lightning wants them on-chain. With third-party submarine-swap services unreliable (Boltz disabled all swaps indefinitely in August 2026), Spark itself is a Lightning→L1 bridge: **receive over Lightning into Spark, then cooperative-exit to L1.**

> **Who actually moves the funds — say this plainly, don't overclaim.** This is **not** a trustless atomic swap. The **SSP** (the Spark Service Provider / Signing Operators — currently Lightspark and Flashnet) is the party that credits your deposit and co-signs your cooperative exit. You rely on them for the cooperative path: they can **delay or censor** a transfer, but they **cannot steal** — your fallback is **unilateral exit** (which needs the locally-backed-up leaf material; see `references/unilateral-exit.md`). So "no external swap provider" means there's no third-party swap *service* that can go down mid-route (the Boltz failure mode) — it does **not** mean "no trusted party." Spark's trust model is **1-of-n honest operators**, not trustlessness (`references/architecture.md`). Don't tell a user this route is trustless or has "no third party"; tell them it depends on the Spark operators, whom they don't have to trust *not to steal* (exit protects that) but do depend on for cooperative speed and liveness.

Route and costs (two legs):

1. **Lightning → Spark**: pay a Spark-created BOLT11 from any Lightning wallet. Fee: 0.15% worst case (see above).
2. **Spark → L1**: cooperative exit. Fee: flat, amount-independent — see `references/wallet.md` for the fee structure, the quote-first pattern, and the `feeQuoteId` binding. Live 2026-08 quotes: ~2,000–2,700 sats at MEDIUM, deducted from the amount.

Worked example at 100,000 sats: ~150 + ~2,430 ≈ **2.6% total**; at 1M sats ≈ **0.4%**. The flat exit fee makes this route uneconomical below ~25,000 sats and cheap at size — batch small amounts before bridging. Use the `SparkAgent` wrapper for both legs (`createLightningInvoice`, then `withdraw` with its built-in quote vetting, allowlist, and spend-budget gates).

## L1 → Lightning On-Ramp (via Spark)

The reverse direction — on-chain sats becoming Lightning spending power without opening a channel (the other job swap services used to do). **This is also the flow for the very common case "the Spark wallet is empty; fund it from L1, then pay."** Whenever you're about to tell a user how much on-chain BTC to send in order to cover a downstream payment, you are in this section — size the deposit with `estimateOnrampDeposit` (below), not "invoice + fee".

**This is FUNDING, not a swap — and it is the wrong tool for paying a specific time-bounded invoice from cold L1.** The on-ramp waits ~3 confirmations, which is a *variable* 10–90+ minutes (block times are random). The BOLT11 you mean to pay is a **depreciating asset**: its expiry clock started when it was created, before you ever send the deposit. Most invoices default to a 1-hour expiry and interactive/POS ones are often 10 minutes or less — so the common outcome of "pay this invoice from on-chain via Spark" is: you send L1, wait for confirmations, and **the invoice expires mid-flow, leaving you with miner fees spent and sats stranded in Spark against a dead invoice.**

**So the FIRST step is a precheck, before you hand out any deposit address:**

```javascript
import { invoiceSecondsRemaining } from "sparkbtcbot-skill";

const remaining = invoiceSecondsRemaining(bolt11); // seconds; null if undecodable
// Refuse (or loudly warn) if the invoice can't survive a worst-case confirmation
// window. 3 L1 confirmations can take well over an hour; require a real buffer.
const SAFE_BUFFER_SECONDS = 2 * 60 * 60; // 2h — 3 confs + claim + slack
if (remaining == null || remaining < SAFE_BUFFER_SECONDS) {
  throw new Error(
    `Invoice expires in ${remaining == null ? "unknown time" : Math.round(remaining / 60) + " min"} — ` +
    `too soon to fund via the L1 on-ramp (3 confirmations can take 60+ min). ` +
    `Ask for an invoice with a longer expiry, or fund Spark from L1 FIRST and pay once the balance lands.`,
  );
}
```

**How much to deposit — sum BOTH fee legs, never just one.** The flow crosses two fee boundaries, so "deposit = invoice + Lightning fee" *under-funds every time*: the SSP takes a **claim spread** when the deposit is credited, so what lands on Spark is `deposit − spread`, not `deposit`. A 5,000-sat invoice is NOT funded by a 5,019-sat deposit — after a ~300-sat spread only ~4,719 credits, and the payment fails with the on-chain fee already spent. And the spread isn't knowable until 3 confirmations, so there is no exact figure to quote up front. Deposit with a buffer, then pay from what actually credited:

```javascript
import { estimateOnrampDeposit } from "sparkbtcbot-skill";

const lnFee = /* agent.estimateLightningFee(bolt11) result in sats */;
const { depositSats } = estimateOnrampDeposit({
  invoiceSats: 5000,
  lightningFeeSats: lnFee,      // the Spark→Lightning leg (defaults to the amount cap if omitted)
  // claimSpreadBufferSats defaults to max(500, 5% of target) — the SSP claim
  // leg is percentage-shaped, so a flat buffer under-covers large deposits.
  slackSats: 200,              // headroom for feerate drift in the spread
});
// Tell the user "send AT LEAST depositSats" — never a single exact number that
// omits a leg. Then, after the claim, verify the REAL credited amount —
// `quote.creditAmountSats` (what the SSP credited; NOT `deposit − creditAmountSats`,
// which is the spread) — covers invoice + Lightning fee before paying. If a fee
// spike ate the buffer, ask for a top-up rather than attempting a short pay.
```

Only if the invoice comfortably outlasts the window do the two legs:

1. **L1 → Spark**: send **at least `depositSats`** (above) to `getStaticDepositAddress()` — note this is an **L1 `bc1p…`/`bcrt1p…` address, on-chain, NOT a Spark `sp1…` address**. Wait **3 confirmations** (the SSP refuses to quote before then).
   - **To check whether the deposit has arrived, call `agent.listPendingDeposits()` — NOT `getBalance()`.** `getBalance()` reflects only *claimed* Spark balance, so it returns `0` for a deposit that confirmed an hour ago but isn't claimed yet — the classic "did it arrive?" → wrongly "no". `listPendingDeposits()` returns the confirmed-but-unclaimed UTXOs as `{ address, txid, vout }`; an empty array means nothing has landed yet (keep waiting), and each entry feeds straight into the claim. (It reads `queryStaticDepositAddresses()` + `getUtxosForDepositAddress(…, excludeClaimed=true)` under the hood; those give no amount, so dry-run a claim to learn the credited value.)
   - Then **claim** with a fee ceiling — `agent.claimDeposit({ txid, vout, dryRun })` previews the quoted credit, and the claim enforces a size-aware ceiling (`maxFeePct`, default 10% of the quoted credit). Costs: your miner fee plus the SSP claim spread (live-measured 297 sats on a 10,350-sat deposit; quote honored exactly). The credit is **asynchronous** (~30s after the claim returns).
2. **Spark → Lightning**: confirm the **actual credited balance** covers `invoiceSats + Lightning fee` (it will if the deposit had margin; if a fee spike ate the buffer, ask for a top-up rather than a failed pay), then pay via `agent.payLightningInvoice` (0.25% + routing worst case; free if the payee is Spark-backed). Re-check `invoiceIsExpired(bolt11)` right before paying — the clock kept running through leg 1.

**The sustainable pattern is "fund the Spark wallet from L1 once, then pay invoices instantly from the balance"** — the two-step nature is correct there, and the balance sitting in Spark has no clock. Reserve one-shot "pay this invoice starting from on-chain" for invoices with generous (multi-hour) expiries; for genuinely time-critical invoices from cold L1, a submarine swap that fronts the Lightning payment is the right tool, not this. Tell the user up front: the on-ramp is slower than it looks, the claim spread is only knowable at quote time, and the invoice must outlive the confirmation wait.

## Receive on REGTEST

REGTEST Lightning invoices have prefix `lnbcrt` (instead of `lnbc` for mainnet, `lntb` for testnet). The funded REGTEST test wallet can pay these via Spark's hosted REGTEST.
