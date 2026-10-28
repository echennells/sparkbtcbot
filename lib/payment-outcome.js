// What a failed payment means — SDK-free. After a spend is recorded and the
// SDK call throws, exactly one question decides everything that follows: did
// the error PROVE that no funds left? If yes, undo the spend and rethrow. If
// not, the money may have left, and every caller follows the same rules:
// the spend stays counted, never pay again with a new invoice or another
// method, and resolve by checking status or re-presenting proof.
import { annotateError, hasAgentCode, isConnectionFailure } from "./agent-errors.js";

// SparkValidationError messages the Spark SDK raises BEFORE its first
// transfer request — input, balance and fee-cap checks — audited against
// spark-sdk 0.12.x on 2026-09-26 for the Lightning, Spark-transfer, Spark
// invoice and cooperative-exit paths, and on 2026-09-30 for token transfers.
// Deliberately an explicit list, matched by prefix: the SDK also raises
// SparkValidationError AFTER a request has gone out, while reading an
// operator's reply ("No transfer response from operator", "SSP coop exit
// response missing L1 transaction fields"), and its error context cannot tell
// the two apart. A message missing from this list —
// new or reworded in a later SDK — falls through to "outcome unknown", which
// over-counts the budget: the safe direction. tests/unit/payment-outcome.test.js
// pins every entry to the installed SDK source.
export const PRE_SEND_VALIDATION_MESSAGES = Object.freeze([
  // shared: amount, balance, leaf selection
  "Total target amount exceeds available balance",
  "Target amount must be positive",
  "Sats amount must be less than 2^53",
  "Amount must be greater than 0",
  "leaves must not be empty",
  // Lightning
  "Invoice network: ",
  "Invalid amount",
  "maxFeeSats does not cover fee estimate",
  // Spark transfer
  "Receiver Spark address cannot be empty",
  "Spark address is a Spark invoice",
  // Spark address decoding (a typo'd or wrong-network address). decodeSparkAddress
  // is a shared helper, so these were audited per call site (2026-09-30): in every
  // path SparkAgent records a spend for, it runs before the first request —
  // transfer, transferTokens/batch (and again while building, before broadcast),
  // fulfillSparkInvoice (while grouping, first) — and Lightning's Spark fallback
  // uses tryDecodeSparkAddress, which never throws.
  "Failed to decode Spark address",
  "Invalid Spark address prefix",
  // Spark invoices
  "No Spark invoices provided",
  // token transfers (output selection runs before the transaction is built)
  "Insufficient token amount",
  "Token amount must be greater than 0",
  "At least one receiver output is required",
  "No receiver outputs provided",
  // cooperative exit (withdraw)
  "Invalid exit speed",
  "No fee quote or fee amount provided",
  "No fee quote ID provided",
  "The fee for the withdrawal is greater than the target withdrawal amount",
  "targetAmountSats is required when deductFeeFromWithdrawalAmount is false",
]);

// The error code each pre-send message carries (lib/agent-errors.js), plus
// the argument it names. One entry per PRE_SEND_VALIDATION_MESSAGES entry;
// tests/unit/agent-errors.test.js keeps the two in step.
const PRE_SEND_CODES = Object.freeze({
  "Total target amount exceeds available balance": { code: "INSUFFICIENT_FUNDS" },
  "Target amount must be positive": { code: "BAD_INPUT", field: "amount" },
  "Sats amount must be less than 2^53": { code: "BAD_INPUT", field: "amount" },
  "Amount must be greater than 0": { code: "BAD_INPUT", field: "amount" },
  "leaves must not be empty": { code: "INSUFFICIENT_FUNDS" },
  "Invoice network: ": { code: "INVOICE_INVALID" },
  "Invalid amount": { code: "BAD_INPUT", field: "amountSats" },
  "maxFeeSats does not cover fee estimate": { code: "FEE_OVER_LIMIT" },
  "Receiver Spark address cannot be empty": { code: "RECIPIENT_INVALID" },
  "Spark address is a Spark invoice": { code: "RECIPIENT_INVALID" },
  "Failed to decode Spark address": { code: "RECIPIENT_INVALID" },
  "Invalid Spark address prefix": { code: "RECIPIENT_INVALID" },
  "No Spark invoices provided": { code: "BAD_INPUT", field: "invoices" },
  "Insufficient token amount": { code: "INSUFFICIENT_FUNDS" },
  "Token amount must be greater than 0": { code: "BAD_INPUT", field: "amount" },
  "At least one receiver output is required": { code: "BAD_INPUT", field: "transfers" },
  "No receiver outputs provided": { code: "BAD_INPUT", field: "transfers" },
  "Invalid exit speed": { code: "BAD_INPUT", field: "speed" },
  "No fee quote or fee amount provided": { code: "QUOTE_UNREADABLE" },
  "No fee quote ID provided": { code: "QUOTE_UNREADABLE" },
  "The fee for the withdrawal is greater than the target withdrawal amount": {
    code: "FEE_OVER_LIMIT",
    nextStep: "Nothing was sent. The exit fee is more than the amount: ask the user whether to withdraw a larger amount, or keep the sats on Spark.",
  },
  "targetAmountSats is required when deductFeeFromWithdrawalAmount is false": { code: "BAD_INPUT", field: "amount" },
});

// True only when the error proves no funds left. Matched by name, not
// instanceof, so a duplicate SDK copy in node_modules classifies the same.
export function provesNothingSent(err) {
  return preSendMessage(err) !== null;
}

function preSendMessage(err) {
  if (err?.name !== "SparkValidationError") return null;
  const message = String(err.message ?? "");
  return PRE_SEND_VALIDATION_MESSAGES.find((m) => message.startsWith(m)) ?? null;
}

/**
 * The contract code a pre-send SparkValidationError carries, with the
 * argument it names and a more specific nextStep where it has one; null for
 * any other error.
 * @param {unknown} err
 * @returns {{ code: string, field?: string, nextStep?: string } | null}
 */
export function preSendCode(err) {
  const m = preSendMessage(err);
  return m === null ? null : PRE_SEND_CODES[m];
}

/**
 * Annotate (lib/agent-errors.js) an SDK error from a call that MOVES NO
 * MONEY: a read, a receive, a quote, or a fee estimate before any send. In
 * place, never re-wrapped: class, message, originalError and cause stay.
 *   - a connection failure in its chain: SPARK_UNAVAILABLE ("yes")
 *   - a pre-send SparkValidationError: the code its message names
 *   - anything else (operator/SSP refusals, auth, unknowns): SPARK_REFUSED ("no")
 * An error that already carries the contract (one this package raised on an
 * inner path) passes through untouched. Not for a spend's own SDK call: there
 * #spendFailed / PaymentCommittedError decide, since a request may have landed.
 * @template E
 * @param {E} err
 * @returns {E & { code: string, retryable: "yes" | "no" | "check-first", nextStep: string }}
 */
export function classifySdkError(err) {
  if (hasAgentCode(err)) return err;
  if (isConnectionFailure(err)) return annotateError(err, "SPARK_UNAVAILABLE");
  const pre = preSendCode(err);
  if (pre) return annotateError(err, pre.code, { field: pre.field, nextStep: pre.nextStep });
  return annotateError(err, "SPARK_REFUSED");
}

// Money has left, or may have. `settled` is true when payment is proven (a
// preimage in hand) and null when the outcome is unknown. Never carries a
// preimage — an error object gets logged, and Node prints its own properties.
// `cause` is the SDK's own error, whose message can quote the invoice; an
// invoice is not a secret, but don't promise more than this. Always
// retryable "check-first"; `nextStep` says what to check for this case.
export class PaymentCommittedError extends Error {
  constructor(message, { settled = null, op, invoiceHash, sendId, cause, nextStep } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PaymentCommittedError";
    annotateError(this, "PAYMENT_COMMITTED", { nextStep });
    this.settled = settled;
    if (op !== undefined) this.op = op;
    if (invoiceHash !== undefined) this.invoiceHash = invoiceHash;
    if (sendId !== undefined) this.sendId = sendId;
  }
}
