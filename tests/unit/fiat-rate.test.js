// Two keyless price sources, cross-checked. Pins: both agree → mean with both
// named; one down → the other, flagged singleSource; both down → throw naming
// each failure; disagreement past the tolerance → REFUSE (a rate two sources
// can't agree on is not a rate to quote money against); a stale mempool
// timestamp, a missing currency, or a non-numeric value counts as DOWN, never
// as a value; conversions round to the nearest sat and reject bad input.
import { describe, it, expect } from "vitest";
import { fetchBtcPrice, fiatToSats, satsToFiat, describeRate, DEFAULT_SOURCES } from "../../lib/fiat-rate.js";

const NOW = Date.parse("2026-09-15T12:00:00Z");
const mempool = (over = {}) => ({ time: Math.floor(NOW / 1000) - 60, USD: 76726, EUR: 66591, GBP: 56949, ...over });
const coinbase = (over = {}) => ({ data: { currency: "BTC", rates: { USD: "76802.46", EUR: "66530.05", MXN: "1317222.5", ...over } } });

// A fetch stub keyed by hostname; a value of Error makes that host fail.
function fakeFetch(byHost) {
  return async (url) => {
    const host = new URL(url).hostname;
    const v = byHost[host];
    if (v instanceof Error) throw v;
    if (v === 500) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => v };
  };
}
const call = (byHost, opts = {}) => fetchBtcPrice({ fetch: fakeFetch(byHost), now: NOW, ...opts });

describe("fetchBtcPrice", () => {
  it("averages two agreeing sources and names both", async () => {
    const r = await call({ "mempool.space": mempool(), "api.coinbase.com": coinbase() });
    expect(r.currency).toBe("USD");
    expect(r.price).toBeCloseTo((76726 + 76802.46) / 2, 6);
    expect(r.sources.map((s) => s.name).sort()).toEqual(["coinbase", "mempool.space"]);
    expect(r.singleSource).toBe(false);
    expect(r.disagreementBps).toBe(Math.round(((76802.46 - 76726) / 76726) * 10_000));
    expect(r.failed).toEqual([]);
  });

  it("falls back to one source, flagged, when the other is down", async () => {
    const r = await call({ "mempool.space": new Error("ECONNRESET"), "api.coinbase.com": coinbase() });
    expect(r.price).toBe(76802.46);
    expect(r.singleSource).toBe(true);
    expect(r.disagreementBps).toBeNull();
    expect(r.failed).toEqual([{ name: "mempool.space", error: "ECONNRESET" }]);
  });

  it("throws naming every failure when no source answers", async () => {
    await expect(call({ "mempool.space": 500, "api.coinbase.com": new Error("timeout") })).rejects.toThrow(
      /no price source answered for USD.*mempool\.space: HTTP 500.*coinbase: timeout/,
    );
  });

  it("REFUSES when the sources disagree beyond the tolerance", async () => {
    await expect(call({ "mempool.space": mempool({ USD: 70000 }), "api.coinbase.com": coinbase() })).rejects.toThrow(
      /disagree on USD\/BTC by 9\.7\d%.*refusing to quote/,
    );
    // …and the tolerance is a knob.
    const r = await call({ "mempool.space": mempool({ USD: 70000 }), "api.coinbase.com": coinbase() }, { maxDisagreementBps: 2000 });
    expect(r.singleSource).toBe(false);
  });

  it("treats a stale mempool timestamp as that source being down", async () => {
    const stale = mempool({ time: Math.floor(NOW / 1000) - 60 * 60 });
    const r = await call({ "mempool.space": stale, "api.coinbase.com": coinbase() });
    expect(r.singleSource).toBe(true);
    expect(r.failed[0]).toMatchObject({ name: "mempool.space", error: expect.stringMatching(/stale: 60 min old/) });
  });

  it("a currency one source lacks comes from the other (MXN: coinbase only), flagged", async () => {
    const r = await call({ "mempool.space": mempool(), "api.coinbase.com": coinbase() }, { currency: "mxn" });
    expect(r.currency).toBe("MXN");
    expect(r.price).toBe(1317222.5);
    expect(r.singleSource).toBe(true);
    expect(r.failed[0].error).toMatch(/no MXN rate/);
  });

  it("non-numeric, zero or negative values count as DOWN, never as a rate", async () => {
    for (const bad of ["abc", 0, -5, null]) {
      const r = await call({ "mempool.space": mempool({ USD: bad }), "api.coinbase.com": coinbase() });
      expect(r.singleSource, `mempool USD=${bad}`).toBe(true);
      expect(r.price).toBe(76802.46);
    }
    await expect(call({ "mempool.space": mempool({ USD: "nope" }), "api.coinbase.com": coinbase({ USD: "" }) })).rejects.toThrow(/no price source answered/);
  });

  it("validates the currency code and rejects unknown options", async () => {
    await expect(call({}, { currency: "US" })).rejects.toThrow(/3-letter ISO code/);
    await expect(call({}, { curency: "USD" })).rejects.toThrow(/unknown option "curency"/);
  });

  it("the default sources hit mempool.space and coinbase", () => {
    expect(DEFAULT_SOURCES.map((s) => new URL(s.url("USD")).hostname)).toEqual(["mempool.space", "api.coinbase.com"]);
  });
});

describe("fiatToSats / satsToFiat / describeRate", () => {
  it("rounds to the nearest sat and round-trips", () => {
    expect(fiatToSats(100, 76764)).toBe(130269);
    expect(fiatToSats("100", "76764")).toBe(130269);
    expect(satsToFiat(130269, 76764)).toBeCloseTo(100, 2);
    expect(satsToFiat(130269n, 76764)).toBeCloseTo(100, 2);
  });
  it("satsToFiat accepts the shapes the wallet actually returns: the wrapper's STRING sats and the SDK's bigint", () => {
    // SparkAgent.getBalance() → { sats: "19932" }; raw wallet.getBalance().satsBalance.available → 19932n.
    // The first live funnel run threw here on the string and reported $0.
    expect(satsToFiat("19932", 76764)).toBeCloseTo(15.3, 1);
    expect(satsToFiat(19932n, 76764)).toBeCloseTo(15.3, 1);
    expect(satsToFiat("0", 76764)).toBe(0);
  });
  it("rejects non-positive or non-numeric input", () => {
    expect(() => fiatToSats(0, 76764)).toThrow(/amount must be a positive number/);
    expect(() => fiatToSats(100, "free")).toThrow(/pricePerBtc must be a positive number/);
    expect(() => satsToFiat(-1, 76764)).toThrow(/non-negative/);
    expect(() => satsToFiat("abc", 76764)).toThrow(/non-negative/);
    expect(() => satsToFiat("1e5", 76764)).toThrow(/non-negative/); // digits only — no exponent/float strings
  });
  it("describeRate names the sources, the time, and flags a single source", () => {
    const two = { currency: "USD", price: 76764.23, at: NOW, sources: [{ name: "mempool.space" }, { name: "coinbase" }], singleSource: false };
    expect(describeRate(two)).toBe("76,764 USD/BTC (mempool.space + coinbase, 2026-09-15 12:00 UTC)");
    const one = { ...two, sources: [{ name: "coinbase" }], singleSource: true };
    expect(describeRate(one)).toMatch(/\(coinbase only, /);
  });
});
