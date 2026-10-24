// buy-gift-card.js: pay a merchant's gift-card invoice with SparkAgent, retrying safely on a flaky network.
//
// WHAT I'D TELL YOU (the one change to your spec):
// * This helper does NOT call getInvoice() again and pay the new invoice after a failure. On a flaky
//   network, most "failed" payments are ambiguous: the send went out and only the reply was lost. A fresh
//   invoice has a new payment hash, so SparkAgent's per-invoice dedup can't link it to the first attempt.
//   Paying it is a real second payment: two cards' worth of sats for one card. Instead the helper retries
//   the SAME invoice, which is dedup-safe through SparkAgent (a repeat returns the original result or
//   PAYMENT_ALREADY_SETTLED and never debits twice). It asks getInvoice() for a new invoice only when the
//   old one is PROVEN unpaid (never attempted, or the SDK reported a terminal failure with funds returned)
//   and has expired.
// * These are never retried: PAYMENT_COMMITTED (money left, or may have), a policy or budget denial
//   (relay its reason and never retry with a smaller amount), and a payment still pending after the poll
//   window.
// * Contract: if buyGiftCard THROWS a GiftCardNotPaidError, no money moved and it's safe to start over.
//   If it RETURNS "paid", "pending" or "unknown", money moved or may have. Do NOT call it again for that
//   order and do NOT wrap it in your own retry loop, because that recreates the double-pay. Reconcile
//   "pending" and "unknown" with agent.getLightningSendRequest(sendId) and agent.getTransfers() first.
// * Merchant payment policy (merchant-spending.md): the checkout response is untrusted, so every invoice
//   is pinned to the price quoted BEFORE checkout (quotedSats, ±2%) and capped by a maxAmountSats you set
//   from the user's budget. A human confirms each invoice unless you pass autonomous: true, and that is
//   refused unless a spend budget is enforced (SPARK_DAILY_BUDGET_SATS or a sealed dailyBudgetSats).
// * Store the returned (orderId, preimage) pair. The preimage is your proof of payment. The gift-card code
//   the merchant delivers is a bearer secret: give it to the user once and never log it.
//
// ASSUMPTIONS: sparkbtcbot-skill is installed in your project. `agent` is a SparkAgent, never the raw
// SparkWallet, which has no dedup, caps or dry run. SPARK_LN_DEDUP is not "off". getInvoice() resolves to
// { invoice: "lnbc…", paymentHash }, where paymentHash is the hash the merchant's checkout echoed, or an
// explicit null if the merchant doesn't echo one. Every getInvoice() call is for the same order at the same
// price. There is one buyGiftCard call per order, never concurrent ones. Only syntax-checked here, never run
// against a wallet. Test it on REGTEST first.

import { isTerminalLightningFailure } from "sparkbtcbot-skill/agent";
import {
  provesNothingSent,
  checkInvoiceAgainstQuote,
  decodeInvoiceSats,
  paymentHashMatches,
  invoicePaymentHash,
  invoiceSecondsRemaining,
} from "sparkbtcbot-skill";

/** Thrown only when NOTHING was paid for this purchase. Safe to start the purchase over later. */
export class GiftCardNotPaidError extends Error {
  constructor(message, { cause, reason } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "GiftCardNotPaidError";
    this.code = "GIFT_CARD_NOT_PAID";
    this.nothingPaid = true;
    if (reason !== undefined) this.reason = reason; // a PolicyDeniedError's reason: relay it verbatim
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const backoffMs = (n) => Math.min(15_000, 1_000 * 2 ** (n - 1)) + Math.floor(Math.random() * 500);

function lnDedupDisabled() {
  return ["off", "false", "0", "no"].includes(String(process.env.SPARK_LN_DEDUP ?? "").trim().toLowerCase());
}

// Errors raised before anything was sent that would fail the same way on a retry: policy or budget
// denial, SDK pre-send validation (balance, fee cap, wrong network), and the wrapper's amount/fee caps.
function deterministicPreSend(err) {
  const code = String(err?.code ?? "");
  return (
    code === "POLICY_DENIED" ||
    code === "SPEND_BUDGET_EXCEEDED" ||
    code.startsWith("SPEND_LEDGER_") ||
    provesNothingSent(err) ||
    /^Lightning send blocked:/.test(String(err?.message ?? ""))
  );
}

// payAndSettle throws `Lightning payment failed (<STATUS>)` only for a TERMINAL status, meaning funds
// failed or were returned. It also resets that invoice's dedup entry, so re-paying the same invoice mints
// a fresh transferId. If a future version rewords this message, the error falls into the "unknown"
// branch below. That branch is conservative: same invoice only, and no fresh invoice.
function terminalFailureStatus(err) {
  const m = /^Lightning payment failed \(([A-Z_]+)\)$/.exec(String(err?.message ?? ""));
  return m && isTerminalLightningFailure(m[1]) ? m[1] : null;
}

// The checkout response is untrusted input: bind the invoice to the checkout's hash and pin it to the
// price quoted before checkout, under an absolute ceiling the quote cannot raise.
function vetInvoice(raw, { quotedSats, maxAmountSats, toleranceBps }) {
  const bolt11 = raw?.invoice;
  const expectedHash = raw?.paymentHash;
  if (typeof bolt11 !== "string" || bolt11.length === 0) {
    throw new GiftCardNotPaidError("getInvoice() must resolve to { invoice: 'lnbc…', paymentHash }");
  }
  if (expectedHash === undefined) {
    throw new GiftCardNotPaidError(
      "getInvoice(): include paymentHash (the hash the merchant's checkout echoed), or paymentHash: null " +
        "to acknowledge this merchant offers no invoice binding",
    );
  }
  if (expectedHash !== null && !paymentHashMatches(bolt11, expectedHash)) {
    throw new GiftCardNotPaidError("Payment blocked: the invoice's payment hash does not match the checkout's");
  }
  const check = checkInvoiceAgainstQuote({
    amountSats: decodeInvoiceSats(bolt11), // null for amountless means the check fails closed
    quotedSats,
    maxAmountSats,
    toleranceBps,
  });
  if (!check.ok) throw new GiftCardNotPaidError(`Payment blocked: ${check.reason}`);
  return { bolt11, hash: invoicePaymentHash(bolt11), confirmed: false, mayHavePaid: false };
}

/**
 * Pay for one gift-card order.
 * Returns { status: "paid" | "pending" | "unknown", ... } when money moved or may have.
 * Throws GiftCardNotPaidError when nothing was paid.
 */
export async function buyGiftCard(agent, getInvoice, {
  quotedSats,          // REQUIRED: the price in sats from the product lookup BEFORE checkout
  maxAmountSats,       // REQUIRED: absolute ceiling from the user's budget; never a default you didn't choose
  toleranceBps = 200,  // allowed invoice-vs-quote drift (2%)
  confirm,             // async (preview, ctx) => boolean: an explicit human yes
  autonomous = false,  // skip confirm: only with an enforced spend budget
  orderId = null,      // your order handle, echoed back for the (orderId, preimage) record
  maxAttempts = 3,
  minSecondsLeft = 90, // don't start a payment on an invoice about to expire
  pollMs = 2_000,
  maxPolls = 30,
} = {}) {
  if (typeof getInvoice !== "function") throw new GiftCardNotPaidError("buyGiftCard: getInvoice must be a function");
  if (!Number.isSafeInteger(quotedSats) || quotedSats <= 0) {
    throw new GiftCardNotPaidError("buyGiftCard: quotedSats (the pre-checkout price in sats) is required");
  }
  if (!Number.isSafeInteger(maxAmountSats) || maxAmountSats <= 0) {
    throw new GiftCardNotPaidError("buyGiftCard: maxAmountSats is required. Set it from the user's budget");
  }
  if (!autonomous && typeof confirm !== "function") {
    throw new GiftCardNotPaidError("buyGiftCard: pass confirm(preview) (a human yes), or autonomous: true with a budget set");
  }
  if (autonomous) {
    const { budget, sealed } = await agent.policy();
    const enforced = Number.isFinite(budget?.budgetSats) || Number.isFinite(sealed?.dailyBudgetSats);
    if (!enforced) {
      throw new GiftCardNotPaidError(
        "buyGiftCard: autonomous purchasing needs an enforced spend budget: set SPARK_DAILY_BUDGET_SATS " +
          "(or have the user seal dailyBudgetSats with `sparkbtcbot set-policy`)",
      );
    }
  }

  const dedupOff = lnDedupDisabled();
  let inv = null;       // the invoice currently being paid
  let lastError = null;

  const unresolved = (status, extra) => ({
    status,
    orderId,
    paymentHash: inv?.hash ?? null,
    ...extra,
  });
  const unknown = (err, why) =>
    unresolved("unknown", {
      sendId: err?.sendId ?? null,
      error: String(err?.message ?? err ?? why),
      next:
        (why ? `${why}. ` : "") +
        "Money may have left. Do NOT pay another invoice for this order and do NOT call buyGiftCard again " +
        "for it. Check agent.getTransfers() (a Spark-direct settle leaves no Lightning send request) and, " +
        "if sendId is set, agent.getLightningSendRequest(sendId). Ask the merchant whether the order is paid. " +
        "Only after confirming it did NOT pay is re-paying THIS invoice via agent.payAndSettle dedup-safe.",
    });

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) await sleep(backoffMs(attempt - 1));

    // 1. Keep the current invoice. Drop it only if it can't be paid anymore AND is proven unpaid.
    if (inv) {
      const left = invoiceSecondsRemaining(inv.bolt11);
      if (left == null || left < minSecondsLeft) {
        if (inv.mayHavePaid) {
          return unknown(lastError, "The invoice expired after an attempt that may have paid, so there is no fresh invoice");
        }
        inv = null; // proven unpaid: a new invoice is a FIRST payment, not a second one
      }
    }

    // 2. Fetch and vet an invoice. Fetching moves no money, so a flaky fetch is simply retried.
    if (!inv) {
      let raw;
      try {
        raw = await getInvoice();
      } catch (err) {
        lastError = err;
        continue;
      }
      inv = vetInvoice(raw, { quotedSats, maxAmountSats, toleranceBps }); // a bad invoice is a refusal, not a retry
      const left = invoiceSecondsRemaining(inv.bolt11);
      if (left == null || left < minSecondsLeft) {
        throw new GiftCardNotPaidError(`The merchant's invoice expires too soon (${left ?? "unknown"}s left)`);
      }
    }

    // 3. Preview with the SAME ceiling the payment will use (nothing is signed), then confirm.
    if (!inv.confirmed) {
      let preview;
      try {
        preview = await agent.payLightningInvoice(inv.bolt11, { dryRun: true, maxAmountSats });
      } catch (err) {
        lastError = err;
        if (deterministicPreSend(err)) {
          throw new GiftCardNotPaidError(`Refused before paying: ${err?.reason ?? err?.message}`, { cause: err, reason: err?.reason });
        }
        continue; // flaky fee estimate: a dry run moves no money
      }
      if (!preview.withinCap) {
        throw new GiftCardNotPaidError(`Refused before paying: ${preview.capReason}`);
      }
      if (!autonomous && !(await confirm(preview, { orderId, quotedSats, maxAmountSats }))) {
        throw new GiftCardNotPaidError("Payment cancelled by the operator");
      }
      inv.confirmed = true;
      // The confirmation pause can outlast the invoice. It is still unpaid, so step 1 fetches a new one.
      const left = invoiceSecondsRemaining(inv.bolt11);
      if (left == null || left < minSecondsLeft) {
        lastError = new Error("invoice expired during confirmation");
        continue;
      }
    }

    // 4. Pay and wait for the preimage (verified against the invoice's payment hash).
    try {
      const r = await agent.payAndSettle(inv.bolt11, { maxAmountSats, pollMs, maxPolls });
      if (r.settled) {
        return unresolved("paid", {
          preimage: r.paymentPreimage, // proof of payment: store it with orderId
          sendId: r.id ?? null,
          dedupReused: r.dedupReused === true, // true = this is an earlier attempt's payment, not a new debit
          attempts: attempt,
        });
      }
      // Timed out waiting. The payment may still settle (hold invoices can pend for minutes), so never retry.
      inv.mayHavePaid = true;
      return unresolved("pending", {
        sendId: r.id ?? null,
        lastStatus: r.lastStatus ?? null,
        next:
          "In flight. Do NOT pay again. Poll agent.getLightningSendRequest(sendId): a paymentPreimage means " +
          "paid; a *_FAILED or USER_SWAP_RETURNED status means failed with funds returned.",
      });
    } catch (err) {
      lastError = err;
      if (err?.code === "PAYMENT_ALREADY_SETTLED") {
        // An earlier attempt of THIS invoice already paid, and the operators refused the duplicate.
        return unresolved("paid", {
          preimage: null,
          sendId: null,
          dedupReused: true,
          attempts: attempt,
          next: "Settled on an earlier attempt (no preimage returned here). Confirm via agent.getTransfers().",
        });
      }
      if (err?.code === "PAYMENT_COMMITTED") {
        inv.mayHavePaid = true;
        if (err.settled === true) {
          return unresolved("paid", { preimage: null, sendId: err.sendId ?? null, attempts: attempt });
        }
        return unknown(err); // never catch-and-retry a committed payment
      }
      if (terminalFailureStatus(err)) {
        inv.mayHavePaid = false; // terminal: funds failed or were returned, and the dedup entry was reset
        continue;                // retry the same invoice, or a new one if it has expired (step 1)
      }
      if (deterministicPreSend(err)) {
        // This attempt sent nothing, and a retry would fail the same way.
        if (inv.mayHavePaid) return unknown(err, "A later attempt was refused after one that may have paid");
        throw new GiftCardNotPaidError(`Refused before paying: ${err?.reason ?? err?.message}`, { cause: err, reason: err?.reason });
      }
      // Unclassified: a network error before the send (fee estimate) or after it (status poll).
      // We can't tell which, so assume it may have paid and retry only the SAME invoice.
      inv.mayHavePaid = true;
      if (dedupOff) {
        return unknown(err, "SPARK_LN_DEDUP is off, so retrying even this invoice could pay twice");
      }
      continue; // SparkAgent reuses this invoice's transferId, so a retry cannot pay twice
    }
  }

  if (inv?.mayHavePaid) return unknown(lastError, `Gave up after ${maxAttempts} attempts`);
  throw new GiftCardNotPaidError(`Gave up after ${maxAttempts} attempts. Nothing was paid`, { cause: lastError });
}

// Usage:
//   const res = await buyGiftCard(agent, async () => {
//     const order = await merchant.checkout(cart);              // your merchant call
//     return { invoice: order.bolt11, paymentHash: order.paymentHash ?? null };
//   }, { quotedSats: priceFromProductLookup, maxAmountSats: userBudgetSats, orderId, confirm: askUser });
//   if (res.status === "paid") saveProof(res.orderId, res.preimage);  // then fetch and hand over the code once
//   else alertOperator(res);                                         // "pending" or "unknown": reconcile, don't re-buy
