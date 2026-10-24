// buyGiftCard(agent, getInvoice, opts) — pay a merchant's Lightning invoice via Spark,
// retrying on a flaky network WITHOUT risking a double purchase.
//
// Assumptions:
//  - `agent.wallet` is an initialized @buildonspark/spark-sdk SparkWallet (if your
//    SparkAgent exposes the wallet under another name, change getWallet() below).
//  - SparkWallet exposes payLightningInvoice({ invoice, maxFeeSats }) returning a
//    LightningSendRequest ({ id, status, ... }) — or a completed WalletTransfer when
//    preferSpark routes it Spark-to-Spark — and getLightningSendRequest(id) for polling.
//  - Status strings follow the SDK's LightningSendRequestStatus enum (names below).
//  - getInvoice() returns a BOLT11 string (or { invoice }) for ONE gift card; each call
//    may create a new merchant order with a new payment hash.
//  - `light-bolt11-decoder` is installed (npm i light-bolt11-decoder) to check the
//    amount/expiry before paying.
//
// Why the retry loop is not a plain "try 3 times":
//  A thrown error or a timeout does NOT mean the sats didn't leave. If we called
//  getInvoice() again after an ambiguous failure we'd get a NEW payment hash and could
//  pay for two gift cards. So:
//    * definite failure (funds returned / never sent) -> safe to retry, fresh invoice ok
//    * ambiguous (threw mid-send, still pending)      -> re-check / re-try the SAME
//      invoice (same payment hash: the merchant can only be paid once for it), and if
//      it still can't be resolved, STOP and surface it for a human — never buy again.

import { decode } from "light-bolt11-decoder";

const SUCCESS = new Set([
  "LIGHTNING_PAYMENT_SUCCEEDED",
  "PREIMAGE_PROVIDED",
  "TRANSFER_COMPLETED",
]);
// Money never left, or was returned: safe to start over with a fresh invoice.
const FAILED_SAFE = new Set([
  "USER_TRANSFER_VALIDATION_FAILED",
  "USER_SWAP_RETURNED",
  "LIGHTNING_PAYMENT_FAILED",
]);
// Anything else (CREATED, REQUEST_VALIDATED, LIGHTNING_PAYMENT_INITIATED, TRANSFER_FAILED,
// USER_SWAP_RETURN_FAILED, unknown) is treated as in-flight/ambiguous.

export class PaymentAmbiguousError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "PaymentAmbiguousError";
    this.details = details; // { invoice, requestId, lastStatus } — log it, reconcile by hand
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const getWallet = (agent) => agent.wallet ?? agent;

function inspectInvoice(invoice) {
  const d = decode(invoice);
  const field = (name) => d.sections.find((s) => s.name === name)?.value;
  const msat = field("amount");
  const ts = field("timestamp");
  const expiry = d.expiry ?? 3600;
  return {
    amountSats: msat != null ? Math.floor(Number(msat) / 1000) : null,
    paymentHash: field("payment_hash"),
    expiresAt: ts != null ? (Number(ts) + Number(expiry)) * 1000 : Infinity,
  };
}

function isSuccessResult(res) {
  // Spark-to-Spark (preferSpark) returns a transfer object rather than a send request.
  if (res && !res.status && res.id && res.totalValue != null) return true;
  return SUCCESS.has(res?.status);
}

// Poll the send request until it is final or we give up (returns last known status).
async function waitForFinal(wallet, requestId, { timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const req = await wallet.getLightningSendRequest(requestId);
      last = req?.status ?? last;
      if (SUCCESS.has(last) || FAILED_SAFE.has(last)) return last;
    } catch {
      // flaky network — keep polling; a failed status read tells us nothing
    }
    await sleep(pollMs);
  }
  return last; // still pending/unknown
}

let purchaseInFlight = false;

/**
 * @param {object} agent        SparkAgent (wrapping a SparkWallet)
 * @param {() => Promise<string|{invoice:string}>} getInvoice
 * @param {object} [opts]
 * @param {number} [opts.expectedAmountSats]  price you agreed to; invoice must not exceed it
 * @param {number} [opts.maxFeeSats=100]      routing-fee ceiling per attempt
 * @param {number} [opts.maxAttempts=3]
 * @param {number} [opts.settleTimeoutMs=60000]
 * @returns {Promise<{ invoice, paymentHash, requestId, status, attempts }>}
 */
export async function buyGiftCard(agent, getInvoice, opts = {}) {
  const {
    expectedAmountSats,
    maxFeeSats = 100,
    maxAttempts = 3,
    settleTimeoutMs = 60_000,
    pollMs = 2_000,
  } = opts;

  if (purchaseInFlight) throw new Error("buyGiftCard: a purchase is already in progress");
  purchaseInFlight = true;
  const wallet = getWallet(agent);

  try {
    let invoice = null; // reused across attempts while its outcome is ambiguous
    let info = null;
    let lastError = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // Only ask the merchant for a new invoice when there is no invoice whose
      // payment might still land.
      if (!invoice) {
        const raw = await getInvoice();
        invoice = typeof raw === "string" ? raw : raw?.invoice;
        if (!invoice) throw new Error("getInvoice() returned no invoice");
        info = inspectInvoice(invoice);

        if (info.amountSats == null) {
          throw new Error("Merchant invoice has no amount — refusing to pay an open-amount invoice");
        }
        if (expectedAmountSats != null && info.amountSats > expectedAmountSats) {
          throw new Error(
            `Invoice asks ${info.amountSats} sats, expected at most ${expectedAmountSats} — not paying`
          );
        }
      }
      if (Date.now() > info.expiresAt - 30_000) {
        // An expired invoice can't be paid anymore, so dropping it is only safe if we
        // know no prior attempt on it is still pending (handled below by throwing
        // before we ever get here with an ambiguous invoice).
        invoice = null;
        attempt--; // expiry isn't a payment attempt
        if (attempt >= maxAttempts) break;
        continue;
      }

      let requestId = null;
      try {
        const res = await wallet.payLightningInvoice({ invoice, maxFeeSats });
        if (isSuccessResult(res)) {
          return { invoice, paymentHash: info.paymentHash, requestId: res.id, status: res.status ?? "TRANSFER_COMPLETED", attempts: attempt };
        }
        requestId = res?.id ?? null;
        if (FAILED_SAFE.has(res?.status)) {
          lastError = new Error(`Payment failed (${res.status})`);
          invoice = null; // definite failure: next attempt may use a fresh invoice
          continue;
        }
      } catch (err) {
        lastError = err;
        // We don't know if the send reached the operators/SSP. Keep the SAME invoice:
        // re-paying the same payment hash can't buy a second card.
        console.warn(`[buyGiftCard] attempt ${attempt} threw (${err?.message}); retrying same invoice`);
        await sleep(Math.min(2_000 * 2 ** (attempt - 1), 15_000));
        continue;
      }

      // We have a send request that isn't final yet — wait for it.
      const status = await waitForFinal(wallet, requestId, { timeoutMs: settleTimeoutMs, pollMs });
      if (SUCCESS.has(status)) {
        return { invoice, paymentHash: info.paymentHash, requestId, status, attempts: attempt };
      }
      if (FAILED_SAFE.has(status)) {
        lastError = new Error(`Payment failed (${status})`);
        invoice = null; // funds back — safe to buy with a fresh invoice
        await sleep(Math.min(2_000 * 2 ** (attempt - 1), 15_000));
        continue;
      }

      // Still in flight after the timeout: do NOT retry or fetch a new invoice.
      throw new PaymentAmbiguousError(
        "Gift-card payment still pending — not retrying to avoid paying twice. Check the request status / merchant order before trying again.",
        { invoice, paymentHash: info.paymentHash, requestId, lastStatus: status }
      );
    }

    // Out of attempts. If the last invoice's outcome was never confirmed as failed,
    // say so explicitly — the card may already be paid for.
    if (invoice) {
      throw new PaymentAmbiguousError(
        `Gave up after ${maxAttempts} attempts with an unresolved payment (${lastError?.message}). ` +
          "The sats may have been sent — reconcile with the merchant before buying again.",
        { invoice, paymentHash: info?.paymentHash, lastStatus: null }
      );
    }
    throw new Error(`Gift-card payment failed after ${maxAttempts} attempts: ${lastError?.message}`);
  } finally {
    purchaseInFlight = false;
  }
}

// Usage:
//   const r = await buyGiftCard(agent, () => merchant.createOrderInvoice(cardId), {
//     expectedAmountSats: 25_000, maxFeeSats: 50,
//   });
//   // then fetch the card code from the merchant using the order tied to r.paymentHash
