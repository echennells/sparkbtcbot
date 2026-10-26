// What a failed payment means — SDK-free. After a spend is recorded and the
// SDK call throws, exactly one question decides everything that follows: did
// the error PROVE that no funds left? If yes, undo the spend and rethrow. If
// not, the money may have left, and every caller follows the same rules:
// the spend stays counted, never pay again with a new invoice or another
// method, and resolve by checking status or re-presenting proof.

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

// True only when the error proves no funds left. Matched by name, not
// instanceof, so a duplicate SDK copy in node_modules classifies the same.
export function provesNothingSent(err) {
  if (err?.name !== "SparkValidationError") return false;
  const message = String(err.message ?? "");
  return PRE_SEND_VALIDATION_MESSAGES.some((m) => message.startsWith(m));
}

// Money has left, or may have. `settled` is true when payment is proven (a
// preimage in hand) and null when the outcome is unknown. Carries no secret:
// never a preimage or a raw invoice — an error object gets logged, and Node
// prints its own properties.
export class PaymentCommittedError extends Error {
  constructor(message, { settled = null, op, invoiceHash, sendId, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "PaymentCommittedError";
    this.code = "PAYMENT_COMMITTED";
    this.settled = settled;
    if (op !== undefined) this.op = op;
    if (invoiceHash !== undefined) this.invoiceHash = invoiceHash;
    if (sendId !== undefined) this.sendId = sendId;
  }
}
