# nadanada — VPNs, eSIMs, and Burner Numbers for Sats

Load when the user wants an agent to buy an anonymous VPN, travel eSIM, or disposable/rental phone number with its sats, or mentions nadanada. **Load `references/merchant-spending.md` alongside this doc** — it carries the shared payment policy; below are only the nadanada-specific deltas.

**Relationship & disclosure:** no partnership; independent guidance. VPN flow **live-validated end-to-end 2026-07-27** — two real purchases: the first (782 sats) burned its config to the one-shot completion trap documented below, the second (784 sats) ran the corrected procedure cleanly through guard → pay → config → status. eSIM flow live-validated same day (US 1GB/7d, 4,464 sats, guard matched within 1 sat, ICCID + install details delivered); phone flows still untested. **Referral disclosure (per `merchant-spending.md` §6):** the skill author's nadanada referral code is **`sparkbtcbot`** (their affiliate program pays 15% on VPN/phone and 5% on eSIM, in BTC). The purchase examples below include it as `refCode: "sparkbtcbot"`; the website link with attribution is `https://nadanada.me?ref=sparkbtcbot`. It changes nothing about price or flow, it is never a prerequisite, and if the user asks to strip it, strip it without argument.

## Why this merchant is agent-friendly (with caveats found live)

No accounts anywhere, no API key, no OAuth, no cart: purchase endpoints return a bare BOLT11 keyed by `paymentHash`. But their docs oversell two things (verified 2026-07-27): the advertised **5% Lightning discount is applied inconsistently — eSIM yes, VPN no** (details in "Paying" below), and "idempotent completion" is **only true for eSIM — the VPN config call is strictly one-shot** (below). Defer to `nadanada.me/api/v2/documentation` for endpoint shapes, but trust the live findings here where they conflict.

## The pairing

1. **`POST /api/v2/<product>/purchase`** (include `"refCode": "sparkbtcbot"` — see the disclosure above; omit it if the user asks) → returns `paymentRequest` (BOLT11), `paymentHash`, `checkoutId`, `expiresAt`. **Save `checkoutId` immediately** — it's the order-lookup handle (`nadanada.me/order`) if anything goes wrong. **There is NO email/receipt parameter anywhere in the API** (verified against their OpenAPI spec) — policy §3's no-receipt-channel rule applies in full: what you persist is the only record.
   - VPN quirk: the `duration` field is **the price-in-USD tag, not a number of days** — the 1-day $0.50 plan is `duration: 0.5` (valid values come from `/api/v2/vpn/countries` `durations[].duration`).
2. **Pay the BOLT11 from Spark** — guard first (below).
3. **Complete** — eSIM: `POST /api/v2/esim/complete` with `paymentHash`, documented idempotent. VPN: see the one-shot warning below.

Catalog/pricing lookups are unauthenticated GETs; rental-phone tools (only — see phone note below) also live on a keyless MCP endpoint (`https://mcp.nadanada.me/mcp`).

## Paying — guard first

Use `payMerchantCheckout` from `references/merchant-spending.md` §1 with these nadanada inputs:

- **The advertised 5% Lightning discount is applied PER PRODUCT (verified live 2026-07-27): NOT on VPN, YES on eSIM.** VPN: quote at full catalog price (the guard's first live block proved it — 782-sat invoice vs 743 discounted quote, 782 = exactly the undiscounted $0.50). eSIM: checkouts return `originalPrice`/`price` with the 5% applied — quote at `usdPrice × 0.95`. Assume nothing for untested products; the guard will tell you.
- **Fiat→sats conversion adds drift beyond the 2% default.** Use an independent rate (e.g. Coinbase spot — in one live check mempool.space and Coinbase agreed within 0.3%), `toleranceBps: 400`, and a firm `maxAmountSats` ceiling.

```javascript
const check = checkInvoiceAgainstQuote({
  amountSats,                                    // decoded from the returned BOLT11
  quotedSats: Math.round(usdPrice * satsPerUsd), // VPN: full price. eSIM: × 0.95 (see above)
  maxAmountSats: 15_000,
  toleranceBps: 400,                             // fx drift: two different USD/BTC rates in play
});
```

## eSIM catalog vs purchasable SKUs — they disagree (verified 2026-07-27)

Every catalog surface (`/esim/portfolio`, `/esim/bundles`, the website's regional pages) advertises `fixed_*` bundle names — and `POST /api/v2/esim/purchase` rejects ALL of them with `Bundle not available`. The purchasable namespace is **country-level `esim_<data>GB_<days>D_<ISO>_V2`** (e.g. `esim_1GB_7D_US_V2` + slug `united-states`), which no catalog endpoint returns — you must construct the name from the pattern and verify with a purchase-request probe (creating a checkout is free; unpaid invoices expire). **Regional bundles are phantoms**: their price table still points at the dead `fixed_*` SKUs (`bundle_slug_mismatch` on the `_V2` region names), so nothing regional can be bought at all despite being advertised (e.g. "North America $1.19"). Catalog prices for countries did match the `_V2` `originalPrice` in tested cases. Bug reported to the merchant 2026-07; re-probe before trusting any of this in either direction.

## VPN completion is ONE-SHOT — prepare before you pay

`POST /api/v2/vpn/config` burns the payment on first success: a retry returns `409 CONFIG_ALREADY_GENERATED`, and it is NOT idempotent regardless of what the general docs imply. Learned by losing one $0.50 config to a client-side crash *after* the server had answered. Hard rules:

- **Generate the WireGuard keypair and PSK BEFORE paying**, and persist them to disk first — the server never sees the private key (their real headline feature), so a lost local key = a dead config.
- The response is the **raw WireGuard config as `text/plain`**, not JSON — do not `res.json()` it. Persist the body immediately, before any parsing that could throw.
- The `country` field wants nadanada's **internal numeric code** from `/api/v2/vpn/countries` (`code`, e.g. Canada = `"5"`), NOT the ISO code — ISO fails with `Invalid country code` *after* you've paid, which is survivable (retry with the right code) only because the 409 hasn't been triggered yet.
- If completion fails irrecoverably, `checkoutId` + `paymentHash` are what support (`info@nadanada.me`) will want.

## Other product notes

- **Phone products split by surface (verified 2026-07-28):** the v2 API and the MCP tools are **rental numbers only** ($12/3 mo, `userId` + `userSecret` auth — the secret is returned ONCE on first purchase; persist it like a seed). The **$1.50 disposable numbers are website-checkout only** — no API/MCP surface exists despite their agent docs advertising the flow. **Disposables use HOLD invoices** — payment settles only when an SMS arrives (≤20 min), else auto-cancels and refunds. A long-pending payment is *normal, not stuck*: never retry-pay. Whether Spark's SSP tolerates a long-held HTLC remains **untested** — testable only by pasting a website-checkout invoice into the wallet, and stock is limited per country/service (observed fully sold out 2026-07-28), so don't promise users a number is available.
- **eSIM**: data-only, 200+ countries; ICCID (`^89\d{16,18}$`) is the handle for status/top-ups; top-ups queue without losing remaining data. New-purchase AND top-up flows live-validated 2026-07-27/28 (top-up: `POST /esim/[iccid]/purchase` -> pay -> `/esim/[iccid]/complete`; complete returned 402 until the invoice settled then succeeded on retry, confirming eSIM completes are genuinely retryable; the new bundle queued behind the active one as documented). Top-up SKUs: both `esim_*_V2` and `esimc_*_V2` namespaces create checkouts — match the eSIM's existing bundle family; the 5% discount applies to top-ups too.
- Refund semantics vary — apply policy §3 accordingly: rental numbers explicitly non-refundable; disposable numbers self-refund via hold invoice; eSIM/VPN treat as non-refundable (the VPN one-shot above makes that literal).
- Deliverables under policy §4's bearer-secret rule: WireGuard configs, eSIM install QR/codes, phone-number dashboard URLs.
- nadanada sells anonymity products. That is legitimate — but if a user's request combines them with concretely harmful intent (e.g. numbers for verification fraud at scale), decline the purchase, not just the conversation.
