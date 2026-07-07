// Fee guardrails for value-moving Spark operations.
//
// These are PURE functions — no SDK, no I/O — so the fee policy is unit-testable
// in isolation and reusable across scripts. The wrapper (SparkAgent) fetches the
// live estimates/quotes from the SDK and feeds the numbers in here.
//
// Policy, made consistent across the three fee touchpoints:
//   - Sends (Lightning / L402) fail CLOSED but LEGIBLY: reject when the estimated
//     fee exceeds the cap, and hand the caller the numbers — instead of the old
//     flat `maxFeeSats: 10` that silently rejected anything over ~4,000 sats
//     (Spark→Lightning is ~0.25%, so 0.0025 × amount > 10 once amount > 4,000).
//   - Claims and withdrawals get an explicit CEILING so they can't silently
//     accept an arbitrary haircut from the SSP quote (the raw SDK leaves this
//     entirely to the caller — there is no built-in maxDepositClaimFee).

// Read a sats scalar out of an SDK CurrencyAmount ({ originalValue, originalUnit })
// or a bare number. Returns null when it can't.
export function satsFromCurrencyAmount(amount) {
  if (amount == null) return null;
  if (typeof amount === "number") return Number.isFinite(amount) ? amount : null;
  const v = Number(amount.originalValue);
  return Number.isFinite(v) ? v : null;
}

// Read the sats value out of a Lightning send fee estimate. IMPORTANT: at
// runtime the Spark SDK returns getLightningSendFeeEstimate() as a BARE NUMBER
// of sats, even though its TypeScript type declares { feeEstimate: CurrencyAmount }.
// (Verified against @buildonspark/spark-sdk 0.8.8 on REGTEST — the type is the
// model, the runtime is the counterpart, and they disagree.) Accept both shapes.
export function lightningEstimateSats(estimate) {
  if (estimate == null) return null;
  return satsFromCurrencyAmount(estimate.feeEstimate ?? estimate);
}

// Amount-aware default fee cap for a Lightning/L402 send, in sats.
// Uses `rateBps` (default 50 = 0.50%) of the amount so it scales — comfortably
// above the ~0.25% Spark-interop fee with routing headroom — with a `floorSats`
// (default 10) minimum for tiny payments. When the amount is unknown, falls back
// to the live estimate + 50% so a valid payment is never rejected for lack of a
// number; only when both are unknown does it drop to the floor.
export function lightningFeeCap({
  amountSats,
  estimatedFeeSats,
  floorSats = 10,
  rateBps = 50,
} = {}) {
  const amt = Number(amountSats);
  if (Number.isFinite(amt) && amt > 0) {
    return Math.max(floorSats, Math.ceil((amt * rateBps) / 10_000));
  }
  const est = Number(estimatedFeeSats);
  if (Number.isFinite(est) && est >= 0) {
    return Math.max(floorSats, Math.ceil(est * 1.5));
  }
  return floorSats;
}

// Decide whether an estimated fee is within the cap. Returns
// { ok, fee, cap, reason }. `ok:false` means the caller must NOT proceed.
// Unknown fee or unknown cap => ok:true (defer to the SDK's own cap) — this
// guard tightens the default, it does not add new ways to get stuck.
export function checkFeeAgainstCap(estimatedFeeSats, capSats) {
  const fee = estimatedFeeSats == null ? NaN : Number(estimatedFeeSats);
  const cap = Number(capSats);
  if (!Number.isFinite(fee)) {
    return { ok: true, fee: null, cap: Number.isFinite(cap) ? cap : null, reason: "fee estimate unavailable; deferring to SDK cap" };
  }
  if (!Number.isFinite(cap)) {
    return { ok: true, fee, cap: null, reason: "no cap set" };
  }
  if (fee > cap) {
    return { ok: false, fee, cap, reason: `estimated fee ${fee} sats exceeds cap ${cap} sats` };
  }
  return { ok: true, fee, cap, reason: "within cap" };
}

// Bound an inbound-invoice payment AMOUNT — distinct from the routing-fee cap.
// `maxFeeSats` limits only what you pay to ROUTE a Lightning payment; it does
// NOT limit the invoice's face value, so a malicious or compromised L402 paywall
// can demand an arbitrarily large invoice and drain an autonomous agent in one
// call. This caps the amount itself. An unreadable amount (amountless invoice)
// with a cap set FAILS CLOSED — refusing to pay an unbounded invoice is safer
// than crashing or paying blind. Returns { ok, amountSats, cap, reason }.
export function checkL402Amount({ amountSats, maxAmountSats } = {}) {
  // Number(null) === 0, which would sneak an amountless invoice through as "0
  // sats, within cap" — treat null/undefined as unreadable, not zero.
  const amt = amountSats == null ? NaN : Number(amountSats);
  const cap = Number(maxAmountSats);
  if (!Number.isFinite(cap)) {
    return { ok: true, amountSats: Number.isFinite(amt) ? amt : null, cap: null, reason: "no amount cap set" };
  }
  if (!Number.isFinite(amt)) {
    return { ok: false, amountSats: null, cap, reason: "invoice has no decodable amount — refusing to pay an unbounded invoice" };
  }
  if (amt > cap) {
    return { ok: false, amountSats: amt, cap, reason: `invoice amount ${amt} sats exceeds cap ${cap} sats` };
  }
  return { ok: true, amountSats: amt, cap, reason: "within cap" };
}

// Total withdrawal (cooperative-exit) fee for a given exit speed, in sats:
// userFee{Speed} + l1BroadcastFee{Speed} from a CoopExitFeeQuote. Returns null
// when the quote shape can't be read (SDK versions vary), so the caller can
// decide whether to proceed rather than crash.
export function withdrawalTotalFee(quote, speed = "MEDIUM") {
  if (quote == null) return null;
  const suffix = { FAST: "Fast", MEDIUM: "Medium", SLOW: "Slow" }[String(speed).toUpperCase()];
  if (!suffix) return null;
  const userFee = satsFromCurrencyAmount(quote[`userFee${suffix}`]);
  const l1Fee = satsFromCurrencyAmount(quote[`l1BroadcastFee${suffix}`]);
  if (userFee == null && l1Fee == null) {
    // Fall back to a couple of older/looser shapes before giving up.
    const flat = satsFromCurrencyAmount(quote[String(speed).toLowerCase()] ?? quote.fee ?? quote);
    return flat;
  }
  return (userFee ?? 0) + (l1Fee ?? 0);
}
