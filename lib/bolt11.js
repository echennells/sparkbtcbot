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

// Seconds until the invoice expires (its `timestamp` + `expiry`, default 3600),
// relative to `nowMs`. NEGATIVE means already expired; null when undecodable.
// A BOLT11 is a depreciating asset: its clock starts at creation, so any flow
// that spends real time before paying (above all the L1→Spark→Lightning
// on-ramp, which waits ~3 confirmations) must check this BEFORE committing
// funds, or it strands the user with on-chain fees spent and a dead invoice.
export function invoiceSecondsRemaining(bolt11, nowMs = Date.now()) {
  // A non-finite clock (e.g. a caller's Date.parse(userInput) → NaN) must fail
  // CLOSED, not read as "not expired": NaN comparisons are all false, which
  // would sail past a buffer gate. Guard it before any arithmetic.
  if (!Number.isFinite(nowMs)) return null;
  try {
    const sections = decode(bolt11)?.sections ?? [];
    const ts = Number(sections.find((s) => s.name === "timestamp")?.value);
    if (!Number.isFinite(ts)) return null;
    // Read expiry from the raw `expiry` SECTION value — unambiguously RELATIVE
    // seconds. Do NOT use the decoder's `decoded.expiry` property: it returns
    // the relative value only through an undocumented getter-shadow in
    // light-bolt11-decoder, and a future (caret-allowed) 3.x that drops the
    // shadow would return the ABSOLUTE epoch instead, making `ts + expiry`
    // land ~decades in the future for EVERY invoice — a silent global
    // fail-open of this exact guard, introduced by a bare `npm update`.
    // Absent section => the BOLT11 default of 3600s.
    const rawExpiry = sections.find((s) => s.name === "expiry")?.value ?? 3600;
    const expiry = Number(rawExpiry);
    if (!Number.isFinite(expiry)) return null;
    return Math.floor((ts + expiry) * 1000 - nowMs) / 1000;
  } catch {
    return null;
  }
}

// True when the invoice is already expired at `nowMs`. Undecodable => true
// (fail closed: don't spend against an invoice you can't read the clock on).
export function invoiceIsExpired(bolt11, nowMs = Date.now()) {
  const rem = invoiceSecondsRemaining(bolt11, nowMs);
  return rem == null || rem <= 0;
}
