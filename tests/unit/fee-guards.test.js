import { describe, it, expect } from "vitest";
import {
  satsFromCurrencyAmount,
  lightningEstimateSats,
  lightningFeeCap,
  checkFeeAgainstCap,
  checkL402Amount,
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
  it("scales with amount (0.5% default) so large sends are NOT capped at 10", () => {
    // The old flat-10 default rejected anything over ~4,000 sats. Amount-aware
    // fixes exactly that: a 100k-sat send gets a 500-sat cap, not 10.
    expect(lightningFeeCap({ amountSats: 100_000 })).toBe(500);
    expect(lightningFeeCap({ amountSats: 10_000 })).toBe(50);
  });
  it("floors at 10 sats for tiny payments", () => {
    expect(lightningFeeCap({ amountSats: 100 })).toBe(10);
    expect(lightningFeeCap({ amountSats: 1 })).toBe(10);
  });
  it("falls back to estimate + 50% when the amount is unknown", () => {
    expect(lightningFeeCap({ estimatedFeeSats: 40 })).toBe(60);
  });
  it("drops to the floor only when amount AND estimate are both unknown", () => {
    expect(lightningFeeCap({})).toBe(10);
    expect(lightningFeeCap({ amountSats: 0 })).toBe(10);
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
