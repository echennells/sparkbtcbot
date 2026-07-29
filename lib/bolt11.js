// BOLT11 read-only helpers for the merchant-payment flow.
//
// Thin, side-effect-free wrappers over light-bolt11-decoder, promoted to the
// library after the same three fragments were hand-rolled in every live
// merchant purchase (and in every doc example agents would copy). Decode
// errors return null/undefined rather than throwing: an unreadable invoice is
// a routine input here, and the guards (checkInvoiceAgainstQuote) are built to
// fail closed on null.
import { decode } from "light-bolt11-decoder";

// The invoice's embedded amount in whole sats (ceil of millisats), or null for
// an amountless or undecodable invoice. Feed the result straight into
// checkInvoiceAgainstQuote — its null handling refuses unbounded invoices
// whenever there is a quote or cap to enforce.
export function decodeInvoiceSats(bolt11) {
  try {
    const section = decode(bolt11)?.sections?.find((s) => s.name === "amount");
    if (!section?.value) return null;
    const sats = Math.ceil(Number(section.value) / 1000);
    return Number.isFinite(sats) && sats > 0 ? sats : null;
  } catch {
    return null;
  }
}

// The invoice's payment hash (lowercase hex), or null when undecodable.
// Policy §1: when a checkout echoes a paymentHash, require it to equal this —
// that binds the invoice to the specific order, so a swapped invoice fails
// even if its amount happens to match the quote.
export function invoicePaymentHash(bolt11) {
  try {
    const section = decode(bolt11)?.sections?.find((s) => s.name === "payment_hash");
    const hash = section?.value;
    return typeof hash === "string" && hash.length > 0 ? hash.toLowerCase() : null;
  } catch {
    return null;
  }
}

// True when the checkout's echoed paymentHash matches the invoice's. Either
// side missing => false: with no hash to bind, the caller should say so, not
// silently pass.
export function paymentHashMatches(bolt11, expectedPaymentHash) {
  const actual = invoicePaymentHash(bolt11);
  if (!actual || typeof expectedPaymentHash !== "string" || !expectedPaymentHash) return false;
  return actual === expectedPaymentHash.toLowerCase();
}
