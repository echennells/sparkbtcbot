// BTC price in fiat, from two independent public sources, cross-checked.
//
// The SDK has no price feed and a Lightning invoice is denominated in sats, so
// "make an invoice for $100" needs a rate from somewhere — and an agent that
// improvises one per run (a random API, a number from memory, the user's guess)
// is the failure mode this module exists to remove. Two keyless sources are
// queried in parallel; the answer is their mean when they agree, a single
// source (flagged) when one is down, and a REFUSAL when they disagree by more
// than `maxDisagreementBps` — a rate the two cannot agree on is not a rate to
// quote money against. Every result carries the sources and the time so the
// agent can show "≈ $100 at 76,700 USD/BTC (mempool.space + coinbase, 12:04
// UTC)" instead of presenting a snapshot as a fact.
//
//   mempool.space  GET /api/v1/prices          → { time, USD, EUR, GBP, CAD, CHF, AUD, JPY }
//   coinbase       GET /v2/exchange-rates?currency=BTC → { data: { rates: { USD: "…", … } } } (600+ currencies, no timestamp)
//
// Rates are untrusted network input like everything else: a source that
// returns a non-finite or non-positive number, a stale timestamp, or a currency
// it doesn't carry counts as DOWN for that call, never as a value.

const SATS_PER_BTC = 100_000_000;

// A fetch with a hard deadline. The global fetch has none, and a price lookup
// that hangs blocks the user's invoice.
async function fetchJson(fetchImpl, url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function positiveFinite(v) {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

export const DEFAULT_SOURCES = [
  {
    name: "mempool.space",
    url: () => "https://mempool.space/api/v1/prices",
    parse(json, currency, { now, maxAgeMs }) {
      const at = positiveFinite(json?.time);
      if (at === null) throw new Error("no timestamp");
      const ageMs = now - at * 1000;
      if (ageMs > maxAgeMs) throw new Error(`stale: ${Math.round(ageMs / 60_000)} min old`);
      const price = positiveFinite(json?.[currency]);
      if (price === null) throw new Error(`no ${currency} rate`);
      return { price, at: at * 1000 };
    },
  },
  {
    name: "coinbase",
    url: () => "https://api.coinbase.com/v2/exchange-rates?currency=BTC",
    parse(json, currency, { now }) {
      if (json?.data?.currency !== "BTC") throw new Error("unexpected base currency");
      const price = positiveFinite(json?.data?.rates?.[currency]);
      if (price === null) throw new Error(`no ${currency} rate`);
      return { price, at: now }; // no server timestamp; the response is live
    },
  },
];

const KNOWN_OPTIONS = ["currency", "fetch", "sources", "timeoutMs", "maxAgeMs", "maxDisagreementBps", "now"];

// Returns { currency, price, at, sources: [{ name, price, at }], failed: [{ name, error }],
// singleSource, disagreementBps }. Throws when no source answers, or when two
// answers disagree by more than maxDisagreementBps (default 300 = 3%).
export async function fetchBtcPrice(options = {}) {
  for (const key of Object.keys(options)) {
    if (!KNOWN_OPTIONS.includes(key)) {
      throw new Error(`fetchBtcPrice: unknown option "${key}". Known options: ${KNOWN_OPTIONS.join(", ")}.`);
    }
  }
  const {
    currency: rawCurrency = "USD",
    fetch: fetchImpl = globalThis.fetch,
    sources = DEFAULT_SOURCES,
    timeoutMs = 8_000,
    maxAgeMs = 15 * 60_000,
    maxDisagreementBps = 300,
    now = Date.now(),
  } = options;
  if (typeof rawCurrency !== "string" || !/^[A-Za-z]{3}$/.test(rawCurrency)) {
    throw new Error(`fetchBtcPrice: currency must be a 3-letter ISO code, got ${JSON.stringify(rawCurrency)}`);
  }
  if (typeof fetchImpl !== "function") throw new Error("fetchBtcPrice: no fetch implementation available");
  const currency = rawCurrency.toUpperCase();

  const results = await Promise.all(
    sources.map(async (src) => {
      try {
        const json = await fetchJson(fetchImpl, src.url(currency), timeoutMs);
        const { price, at } = src.parse(json, currency, { now, maxAgeMs });
        return { ok: true, name: src.name, price, at };
      } catch (err) {
        return { ok: false, name: src.name, error: err?.message ?? String(err) };
      }
    }),
  );
  const good = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok).map(({ name, error }) => ({ name, error }));
  if (good.length === 0) {
    throw new Error(
      `fetchBtcPrice: no price source answered for ${currency} — ` +
        failed.map((f) => `${f.name}: ${f.error}`).join("; "),
    );
  }
  const prices = good.map((g) => g.price);
  const lo = Math.min(...prices);
  const hi = Math.max(...prices);
  const disagreementBps = Math.round(((hi - lo) / lo) * 10_000);
  if (good.length > 1 && disagreementBps > maxDisagreementBps) {
    throw new Error(
      `fetchBtcPrice: sources disagree on ${currency}/BTC by ${(disagreementBps / 100).toFixed(2)}% (` +
        good.map((g) => `${g.name} ${g.price}`).join(", ") +
        `) — more than the ${maxDisagreementBps / 100}% tolerance; refusing to quote.`,
    );
  }
  const price = prices.reduce((a, b) => a + b, 0) / prices.length;
  return {
    currency,
    price,
    at: Math.min(...good.map((g) => g.at)),
    sources: good.map(({ name, price, at }) => ({ name, price, at })),
    failed,
    singleSource: good.length === 1,
    disagreementBps: good.length > 1 ? disagreementBps : null,
  };
}

// Whole sats for a fiat amount at a BTC price. Rounds to the NEAREST sat — an
// invoice for "$100" should be the closest sat figure, not a systematic over-
// or under-ask. Callers sizing a spend under a balance want floor semantics and
// get them from fee-guards' maxSpendableFace instead.
export function fiatToSats(amountFiat, pricePerBtc) {
  const amount = positiveFinite(amountFiat);
  const price = positiveFinite(pricePerBtc);
  if (amount === null) throw new Error(`fiatToSats: amount must be a positive number, got ${JSON.stringify(amountFiat)}`);
  if (price === null) throw new Error(`fiatToSats: pricePerBtc must be a positive number, got ${JSON.stringify(pricePerBtc)}`);
  return Math.round((amount / price) * SATS_PER_BTC);
}

// Fiat value of a sats amount at a BTC price, as a Number (round for display).
// Accepts a number, a bigint, or a numeric string: SparkAgent.getBalance()
// returns `sats` as a STRING ("19932") and the raw SDK's satsBalance.available
// is a bigint — the first live run threw here on the wrapper's string.
export function satsToFiat(sats, pricePerBtc) {
  const n = typeof sats === "bigint" ? Number(sats) : typeof sats === "string" && /^\d+$/.test(sats.trim()) ? Number(sats) : sats;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) throw new Error(`satsToFiat: sats must be a non-negative number, got ${JSON.stringify(sats)}`);
  const price = positiveFinite(pricePerBtc);
  if (price === null) throw new Error(`satsToFiat: pricePerBtc must be a positive number, got ${JSON.stringify(pricePerBtc)}`);
  return (n / SATS_PER_BTC) * price;
}

// One line an agent can paste under any fiat figure so the snapshot is honest:
// "≈ $100.00 at 76,764 USD/BTC (mempool.space + coinbase, 2026-09-15 12:04 UTC)".
export function describeRate(rate, { locale = "en-US" } = {}) {
  const when = new Date(rate.at).toISOString().replace("T", " ").slice(0, 16) + " UTC";
  const via = rate.sources.map((s) => s.name).join(" + ") + (rate.singleSource ? " only" : "");
  const px = Math.round(rate.price).toLocaleString(locale);
  return `${px} ${rate.currency}/BTC (${via}, ${when})`;
}
