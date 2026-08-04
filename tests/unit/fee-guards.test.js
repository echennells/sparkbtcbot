import { describe, it, expect } from "vitest";
import {
  satsFromCurrencyAmount,
  estimateFirstFeeCap,
  lightningEstimateSats,
  lightningFeeCap,
  checkFeeAgainstCap,
  checkL402Amount,
  checkInvoiceAgainstQuote,
  estimateOnrampDeposit,
  withdrawalTotalFee,
} from "../../lib/fee-guards.js";

describe("lightningEstimateSats", () => {
  it("reads the BARE NUMBER the SDK actually returns at runtime (14 sats)", () => {
    // Regression for the type-vs-runtime mismatch: the SDK type says
    // { feeEstimate: CurrencyAmount } but the live call returns a plain number.
    expect(lightningEstimateSats(14)).toBe(14);
  });
  it("also reads the declared { feeEstimate: CurrencyAmount } shape", () => {
    expect(lightningEstimateSats({ feeEstimate: { originalValue: 22, originalUnit: "SATOSHI" } })).toBe(22);
    expect(lightningEstimateSats({ feeEstimate: 22 })).toBe(22);
  });
  it("returns null for null/unreadable", () => {
    expect(lightningEstimateSats(null)).toBe(null);
    expect(lightningEstimateSats(undefined)).toBe(null);
  });
});

describe("satsFromCurrencyAmount", () => {
  it("reads originalValue from an SDK CurrencyAmount", () => {
    expect(satsFromCurrencyAmount({ originalValue: 198, originalUnit: "SATOSHI" })).toBe(198);
  });
  it("passes through a bare number", () => {
    expect(satsFromCurrencyAmount(42)).toBe(42);
  });
  it("returns null for null / unreadable", () => {
    expect(satsFromCurrencyAmount(null)).toBe(null);
    expect(satsFromCurrencyAmount(undefined)).toBe(null);
    expect(satsFromCurrencyAmount({ nope: 1 })).toBe(null);
  });
});

describe("lightningFeeCap", () => {
  it("scales with amount (0.5% default) so large sends are NOT capped at the floor", () => {
    // The old flat-10 default rejected anything over ~4,000 sats. Amount-aware
    // fixes exactly that: a 100k-sat send gets a 500-sat cap, not 10.
    expect(lightningFeeCap({ amountSats: 100_000 })).toBe(500);
    expect(lightningFeeCap({ amountSats: 10_000 })).toBe(50);
  });
  it("floors at 25 sats so Spark's flat fee component clears on small/mid sends", () => {
    // Live regression: a 4,464-sat payment carried a 25-sat SDK fee estimate;
    // the pure 0.5% cap (23) under-capped it and the SDK refused the send.
    expect(lightningFeeCap({ amountSats: 4_464 })).toBe(25);
    expect(lightningFeeCap({ amountSats: 100 })).toBe(25);
    expect(lightningFeeCap({ amountSats: 1 })).toBe(25);
  });
  it("falls back to estimate + 50% when the amount is unknown", () => {
    expect(lightningFeeCap({ estimatedFeeSats: 40 })).toBe(60);
  });
  it("drops to the floor only when amount AND estimate are both unknown", () => {
    expect(lightningFeeCap({})).toBe(25);
    expect(lightningFeeCap({ amountSats: 0 })).toBe(25);
  });
  it("honors custom floor/rate", () => {
    expect(lightningFeeCap({ amountSats: 100_000, rateBps: 25 })).toBe(250);
    expect(lightningFeeCap({ amountSats: 1, floorSats: 5 })).toBe(5);
  });
});

describe("checkFeeAgainstCap", () => {
  it("passes when fee is within cap", () => {
    expect(checkFeeAgainstCap(8, 10)).toMatchObject({ ok: true });
    expect(checkFeeAgainstCap(10, 10)).toMatchObject({ ok: true });
  });
  it("blocks (legibly) when fee exceeds cap", () => {
    const r = checkFeeAgainstCap(30, 10);
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("30");
    expect(r.reason).toContain("10");
  });
  it("defers (ok:true) when the estimate is unavailable — tightens, never adds new ways to get stuck", () => {
    expect(checkFeeAgainstCap(undefined, 10)).toMatchObject({ ok: true, fee: null });
    expect(checkFeeAgainstCap(NaN, 10)).toMatchObject({ ok: true });
  });
  it("defers when no cap is set", () => {
    expect(checkFeeAgainstCap(500, undefined)).toMatchObject({ ok: true, cap: null });
  });
});

describe("checkL402Amount", () => {
  it("passes when the invoice amount is within the cap", () => {
    expect(checkL402Amount({ amountSats: 500, maxAmountSats: 10_000 })).toMatchObject({ ok: true });
  });
  it("blocks an over-cap invoice (the Blink mirror: unbounded amount)", () => {
    const r = checkL402Amount({ amountSats: 5_000_000, maxAmountSats: 10_000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("exceeds cap");
  });
  it("FAILS CLOSED on an amountless invoice when a cap is set (no TypeError)", () => {
    const r = checkL402Amount({ amountSats: null, maxAmountSats: 10_000 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("unbounded");
  });
  it("defers when no cap is set", () => {
    expect(checkL402Amount({ amountSats: 999_999 })).toMatchObject({ ok: true, cap: null });
  });
});

describe("estimateFirstFeeCap", () => {
  it("returns the amount-scaled cap when the estimate fits under it", () => {
    expect(estimateFirstFeeCap({ amountSats: 100_000, estimatedFeeSats: 300 })).toBe(500);
  });
  it("adopts estimate + headroom when the live estimate exceeds the cap (operator-present posture)", () => {
    // The live eSIM case: 4,464-sat send, 25-sat estimate, cap floor 25 -> 30.
    expect(estimateFirstFeeCap({ amountSats: 4_464, estimatedFeeSats: 25 })).toBe(30);
    expect(estimateFirstFeeCap({ amountSats: 4_464, estimatedFeeSats: 25, headroomSats: 10 })).toBe(35);
  });
  it("falls back to the plain cap when the estimate is unreadable", () => {
    expect(estimateFirstFeeCap({ amountSats: 4_464 })).toBe(25);
    expect(estimateFirstFeeCap({ amountSats: 4_464, estimatedFeeSats: NaN })).toBe(25);
  });
});

describe("checkInvoiceAgainstQuote", () => {
  it("passes an invoice that exactly matches the quote", () => {
    expect(
      checkInvoiceAgainstQuote({ amountSats: 7_150, quotedSats: 7_150 }),
    ).toMatchObject({ ok: true, reason: "matches quote" });
  });
  it("absorbs fiat->sats drift inside the default 2% tolerance", () => {
    expect(
      checkInvoiceAgainstQuote({ amountSats: 7_250, quotedSats: 7_150 }),
    ).toMatchObject({ ok: true });
  });
  it("blocks a tampered invoice beyond tolerance, with both numbers in the reason", () => {
    const r = checkInvoiceAgainstQuote({ amountSats: 71_500, quotedSats: 7_150 });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("71500");
    expect(r.reason).toContain("7150");
  });
  it("blocks drift in BOTH directions (an underpaying invoice buys a failed order)", () => {
    expect(
      checkInvoiceAgainstQuote({ amountSats: 5_000, quotedSats: 7_150 }).ok,
    ).toBe(false);
  });
  it("enforces the absolute cap even when the invoice matches the quote", () => {
    // A bad/inflated quote must not authorize an unbounded invoice.
    const r = checkInvoiceAgainstQuote({
      amountSats: 900_000,
      quotedSats: 900_000,
      maxAmountSats: 50_000,
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toContain("exceeds cap");
  });
  it("FAILS CLOSED on an amountless invoice when there is a quote or cap to enforce", () => {
    expect(
      checkInvoiceAgainstQuote({ amountSats: null, quotedSats: 7_150 }).ok,
    ).toBe(false);
    expect(
      checkInvoiceAgainstQuote({ amountSats: null, maxAmountSats: 10_000 }).ok,
    ).toBe(false);
  });
  it("defers only when there is neither quote nor cap (nothing to enforce)", () => {
    expect(checkInvoiceAgainstQuote({ amountSats: 7_150 })).toMatchObject({ ok: true });
    expect(checkInvoiceAgainstQuote({})).toMatchObject({ ok: true });
  });
  it("treats a zero/garbage quote as no quote, not division-by-zero", () => {
    expect(
      checkInvoiceAgainstQuote({ amountSats: 500, quotedSats: 0, maxAmountSats: 1_000 }),
    ).toMatchObject({ ok: true, quotedSats: null, reason: "within cap; no quote to compare" });
  });
  it("honors a custom tolerance", () => {
    expect(
      checkInvoiceAgainstQuote({ amountSats: 7_250, quotedSats: 7_150, toleranceBps: 100 }).ok,
    ).toBe(false);
  });
});

describe("withdrawalTotalFee", () => {
  const quote = {
    userFeeMedium: { originalValue: 120, originalUnit: "SATOSHI" },
    l1BroadcastFeeMedium: { originalValue: 300, originalUnit: "SATOSHI" },
    userFeeFast: { originalValue: 200, originalUnit: "SATOSHI" },
    l1BroadcastFeeFast: { originalValue: 600, originalUnit: "SATOSHI" },
  };
  it("sums userFee + l1BroadcastFee for the chosen speed", () => {
    expect(withdrawalTotalFee(quote, "MEDIUM")).toBe(420);
    expect(withdrawalTotalFee(quote, "FAST")).toBe(800);
  });
  it("is case-insensitive on speed", () => {
    expect(withdrawalTotalFee(quote, "medium")).toBe(420);
  });
  it("returns null for a null quote or unknown speed", () => {
    expect(withdrawalTotalFee(null, "MEDIUM")).toBe(null);
    expect(withdrawalTotalFee(quote, "TURBO")).toBe(null);
  });
  it("falls back to a flat/legacy quote shape", () => {
    expect(withdrawalTotalFee({ medium: 55 }, "MEDIUM")).toBe(55);
    expect(withdrawalTotalFee({ fee: 77 }, "MEDIUM")).toBe(77);
  });
});

// A misspelled cap option used to silently mean "no cap" — the exact keystroke
// that feels like setting a ceiling removed it (`maxAmountSat: 500` → ok:true,
// "no amount cap set"). Unknown keys must throw for every option-taking guard.
describe("unknown-option rejection (typo-proofing)", () => {
  it("checkL402Amount throws on a misspelled cap instead of dropping it", () => {
    expect(() => checkL402Amount({ amountSats: 9_999, maxAmountSat: 500 })).toThrow(/unknown option/);
  });
  it("checkInvoiceAgainstQuote throws on a misspelled tolerance", () => {
    expect(() => checkInvoiceAgainstQuote({ amountSats: 100, quotedSats: 100, toleranceBsp: 0 })).toThrow(/unknown option/);
  });
  it("lightningFeeCap throws on a misspelled floor", () => {
    expect(() => lightningFeeCap({ amountSats: 1_000, floorSat: 1 })).toThrow(/unknown option/);
  });
  it("estimateFirstFeeCap throws on a misspelled headroom", () => {
    expect(() => estimateFirstFeeCap({ amountSats: 1_000, headroomSat: 50 })).toThrow(/unknown option/);
  });
  it("correctly-spelled options are unaffected", () => {
    expect(checkL402Amount({ amountSats: 9_999, maxAmountSats: 500 }).ok).toBe(false);
  });
});

// The estimate could previously raise its own cap WITHOUT BOUND — an inflated
// estimate from a hostile counterparty grew the cap instead of tripping it.
describe("estimateFirstFeeCap growth bound", () => {
  it("caps estimate-driven growth at 3x the amount-scaled cap by default", () => {
    // amount 10,000 → base 50; inflated estimate 10,000 must not become the cap
    expect(estimateFirstFeeCap({ amountSats: 10_000, estimatedFeeSats: 10_000 })).toBe(150);
  });
  it("still honors a modest estimate under the bound", () => {
    expect(estimateFirstFeeCap({ amountSats: 10_000, estimatedFeeSats: 60 })).toBe(65);
  });
  it("an explicit maxCapSats overrides the default bound", () => {
    expect(estimateFirstFeeCap({ amountSats: 10_000, estimatedFeeSats: 10_000, maxCapSats: 400 })).toBe(400);
    expect(estimateFirstFeeCap({ amountSats: 10_000, estimatedFeeSats: 10_000, maxCapSats: 200_000 })).toBe(10_005);
  });
  it("the bound never drops the cap below the amount-scaled base", () => {
    expect(estimateFirstFeeCap({ amountSats: 10_000, estimatedFeeSats: 10_000, maxCapSats: 1 })).toBe(50);
  });
});

// The on-ramp under-funding bug: an agent quoted "deposit 5,019" to pay a
// 5,000-sat invoice (invoice + Lightning fee only), forgetting the SSP claim
// spread. After the ~300-sat spread, ~4,719 credited -> payment failed.
describe("estimateOnrampDeposit (fee composition across both legs)", () => {
  it("includes the claim spread the naive sum omits (the 5k-invoice bug)", () => {
    const { depositSats, breakdown } = estimateOnrampDeposit({
      invoiceSats: 5000, lightningFeeSats: 19, claimSpreadBufferSats: 500, slackSats: 0,
    });
    expect(depositSats).toBe(5519);              // NOT the buggy 5019
    expect(depositSats).toBeGreaterThan(5019);   // covers the claim leg
    expect(breakdown).toEqual({ invoiceSats: 5000, lightningFeeSats: 19, claimSpreadBufferSats: 500, slackSats: 0 });
  });
  it("a 5,019 deposit would leave the invoice UNFUNDED after a 300-sat spread", () => {
    // sanity anchor for the failure mode: credited = deposit - spread
    const credited = 5019 - 300;
    expect(credited).toBeLessThan(5000 + 19); // < invoice + fee -> can't pay
    // the helper's answer, minus the same spread, DOES cover it:
    const { depositSats } = estimateOnrampDeposit({ invoiceSats: 5000, lightningFeeSats: 19 });
    expect(depositSats - 300).toBeGreaterThanOrEqual(5000 + 19);
  });
  it("defaults: 500-sat spread buffer, 0 lightning/slack", () => {
    expect(estimateOnrampDeposit({ invoiceSats: 1000 }).depositSats).toBe(1500);
  });
  it("ceils fractional inputs and sums slack", () => {
    expect(estimateOnrampDeposit({ invoiceSats: 1000.4, lightningFeeSats: 5, claimSpreadBufferSats: 300, slackSats: 100 }).depositSats).toBe(1406);
  });
  it("throws on a non-positive or unreadable invoice amount", () => {
    expect(() => estimateOnrampDeposit({ invoiceSats: 0 })).toThrow(/positive number/);
    expect(() => estimateOnrampDeposit({ invoiceSats: "5k" })).toThrow(/positive number/);
    expect(() => estimateOnrampDeposit({})).toThrow(/positive number/);
  });
  it("throws on negative/garbage fee components (no silent under-buffer)", () => {
    expect(() => estimateOnrampDeposit({ invoiceSats: 5000, claimSpreadBufferSats: -100 })).toThrow(/non-negative/);
    expect(() => estimateOnrampDeposit({ invoiceSats: 5000, lightningFeeSats: "free" })).toThrow(/non-negative/);
  });
  it("rejects misspelled options instead of dropping them", () => {
    expect(() => estimateOnrampDeposit({ invoiceSats: 5000, claimSpreadBuffer: 500 })).toThrow(/unknown option/);
  });
});
