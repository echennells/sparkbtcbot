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

// A misspelled option must THROW, not silently mean "no cap": JS drops unknown
// destructured keys, so `checkL402Amount({ amountSats, maxAmountSat: 500 })`
// used to return ok:true ("no amount cap set") — the keystroke that feels like
// setting a ceiling silently removes it. The SparkAgent wrapper already
// rejects unknown options; this enforces the same rule for direct lib users.
function rejectUnknownKeys(fn, options, known) {
  for (const key of Object.keys(options)) {
    if (!known.includes(key)) {
      throw new Error(
        `${fn}: unknown option "${key}" — a misspelled cap would be silently ignored, ` +
          `which removes the ceiling you meant to set. Known options: ${known.join(", ")}.`,
      );
    }
  }
}

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
// (Verified against @buildonspark/spark-sdk 0.8.8, re-verified on 0.9.0 against a
// live MAINNET payment — the type is the model, the runtime is the counterpart,
// and they still disagree.) Accept both shapes.
export function lightningEstimateSats(estimate) {
  if (estimate == null) return null;
  return satsFromCurrencyAmount(estimate.feeEstimate ?? estimate);
}

// Amount-aware default fee cap for a Lightning/L402 send, in sats.
// Uses `rateBps` (default 50 = 0.50%) of the amount so it scales — comfortably
// above the ~0.25% Spark-interop fee with routing headroom — with a `floorSats`
// (default 25) minimum. The floor is 25, not 10, because Spark's fee has a flat
// component that dominates small-to-mid sends: a live 4,464-sat payment carried
// a 25-sat SDK fee estimate (~0.56%), which a pure 0.5% cap (23) under-capped
// and the SDK refused. When the amount is unknown, falls back to the live
// estimate + 50% so a valid payment is never rejected for lack of a number;
// only when both are unknown does it drop to the floor.
export function lightningFeeCap(options = {}) {
  rejectUnknownKeys("lightningFeeCap", options, ["amountSats", "estimatedFeeSats", "floorSats", "rateBps"]);
  const { amountSats, estimatedFeeSats, floorSats = 25, rateBps = 50 } = options;
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

// Fee cap for an operator-present script: the amount-scaled cap, but never
// below the live estimate plus headroom. Use this in one-shot purchase scripts
// where a human is watching and a blocked send would just be re-run with a
// bigger number anyway. The SparkAgent wrapper deliberately does NOT use this:
// unattended agents get lightningFeeCap + checkFeeAgainstCap, which REFUSES an
// over-cap estimate legibly instead of silently adopting it — an estimate a
// compromised counterparty inflates should stop an unattended send, not grow
// its own cap. Same numbers, different trust postures; pick by who is present.
//
// Even attended, the estimate's influence is BOUNDED: it can raise the cap to
// at most `maxCapSats` (default 3× the amount-scaled cap). An estimate past
// that bound isn't drift a human should wave through by re-running the script
// — it's a broken or hostile counterparty, so the cap stops growing and the
// send fails legibly unless the operator raises maxCapSats on purpose.
export function estimateFirstFeeCap(options = {}) {
  rejectUnknownKeys("estimateFirstFeeCap", options, ["amountSats", "estimatedFeeSats", "headroomSats", "maxCapSats"]);
  const { amountSats, estimatedFeeSats, headroomSats = 5, maxCapSats } = options;
  const base = lightningFeeCap({ amountSats });
  const est = Number(estimatedFeeSats);
  if (!Number.isFinite(est) || est < 0) return base;
  const bound = Number.isFinite(Number(maxCapSats)) ? Number(maxCapSats) : base * 3;
  return Math.max(base, Math.min(Math.ceil(est) + headroomSats, bound));
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
export function checkL402Amount(options = {}) {
  rejectUnknownKeys("checkL402Amount", options, ["amountSats", "maxAmountSats"]);
  const { amountSats, maxAmountSats } = options;
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

// Pin a checkout invoice to the price the merchant quoted — the commerce
// counterpart of checkL402Amount. A checkout response (Bitrefill or any
// Lightning merchant) is untrusted input: the BOLT11 it carries can name any
// amount, so an agent that pays whatever arrives can be drained by a single
// tampered or MITM'd response. Verify amount-vs-quote BEFORE paying:
//   - `toleranceBps` (default 200 = 2%) absorbs fiat->sats drift between quote
//     and invoice creation; beyond it the mismatch is a reason to abort, not pay.
//   - `maxAmountSats`, when set, is an absolute ceiling checked on top of the
//     quote (a bad quote must not authorize an unbounded invoice).
//   - An unreadable invoice amount FAILS CLOSED whenever there is a quote or a
//     cap to enforce — refusing to pay blind, same policy as checkL402Amount.
// Returns { ok, amountSats, quotedSats, cap, reason }.
export function checkInvoiceAgainstQuote(options = {}) {
  rejectUnknownKeys("checkInvoiceAgainstQuote", options, ["amountSats", "quotedSats", "maxAmountSats", "toleranceBps"]);
  const { amountSats, quotedSats, maxAmountSats, toleranceBps = 200 } = options;
  const amt = amountSats == null ? NaN : Number(amountSats);
  const quote = quotedSats == null ? NaN : Number(quotedSats);
  const cap = Number(maxAmountSats);
  const hasQuote = Number.isFinite(quote) && quote > 0;
  const hasCap = Number.isFinite(cap);
  const base = {
    amountSats: Number.isFinite(amt) ? amt : null,
    quotedSats: hasQuote ? quote : null,
    cap: hasCap ? cap : null,
  };
  if (!hasQuote && !hasCap) {
    return { ok: true, ...base, reason: "no quote or amount cap to check against" };
  }
  if (!Number.isFinite(amt)) {
    return { ok: false, ...base, reason: "invoice has no decodable amount — refusing to pay an unbounded invoice" };
  }
  if (hasCap && amt > cap) {
    return { ok: false, ...base, reason: `invoice amount ${amt} sats exceeds cap ${cap} sats` };
  }
  if (!hasQuote) {
    return { ok: true, ...base, reason: "within cap; no quote to compare" };
  }
  const driftBps = Math.abs(amt - quote) / quote * 10_000;
  if (driftBps > toleranceBps) {
    return {
      ok: false,
      ...base,
      reason: `invoice amount ${amt} sats does not match quoted ${quote} sats (drift ${Math.round(driftBps)} bps > tolerance ${toleranceBps} bps)`,
    };
  }
  return { ok: true, ...base, reason: "matches quote" };
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
