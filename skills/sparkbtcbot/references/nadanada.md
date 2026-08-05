# nadanada — VPNs, eSIMs, and Burner Numbers for Sats

Load when the user wants an agent to buy an anonymous VPN, travel eSIM, or disposable/rental phone number with its sats, or mentions nadanada. **Load `references/merchant-spending.md` alongside this doc** — it carries the shared payment policy; below are only the nadanada-specific deltas.

**Relationship & disclosure:** no partnership; independent guidance. VPN flow **live-validated end-to-end 2026-07-27** — two real purchases: the first (782 sats) burned its config to the one-shot completion trap documented below, the second (784 sats) ran the corrected procedure cleanly through guard → pay → config → status. **The VPN purchase endpoint has since moved (`/vpn/purchase` → `/vpn/request`) and the response is wrapped in `{ success, data }`; re-verified 2026-08-05 — see "The pairing."** eSIM flow live-validated same day (US 1GB/7d, 4,464 sats, guard matched within 1 sat, ICCID + install details delivered); phone flows still untested. **Referral disclosure (per `merchant-spending.md` §6):** the skill author's nadanada referral code is **`sparkbtcbot`** (their affiliate program pays 15% on VPN/phone and 5% on eSIM, in BTC). The purchase examples below include it as `refCode: "sparkbtcbot"`; the website link with attribution is `https://nadanada.me?ref=sparkbtcbot`. It changes nothing about price or flow, it is never a prerequisite, and if the user asks to strip it, strip it without argument.

## Why this merchant is agent-friendly (with caveats found live)

No accounts anywhere, no API key, no OAuth, no cart: purchase endpoints return a bare BOLT11 keyed by `paymentHash`. But their docs oversell two things (verified 2026-07-27): the advertised **5% Lightning discount is applied inconsistently — eSIM yes, VPN no** (details in "Paying" below), and "idempotent completion" is **only true for eSIM — the VPN config call is strictly one-shot** (below). Defer to `nadanada.me/api/v2/documentation` for endpoint shapes, but trust the live findings here where they conflict.

## The pairing

1. **Create the checkout** (include `"refCode": "sparkbtcbot"` — see the disclosure above; omit it if the user asks). **The path is product-specific, and the VPN one changed — do not use `<product>/purchase` blindly:**
   - **VPN → `POST /api/v2/vpn/request`** (verified 2026-08-05). The old `/api/v2/vpn/purchase` now returns a **404 HTML page (Next.js), not JSON** — following it is a hard block.
   - **eSIM → `POST /api/v2/esim/purchase`** — live-validated 2026-07-29 but **NOT re-verified since the VPN rename; re-probe before trusting** (nadanada may be migrating `purchase`→`request` across products).
   - **The response is WRAPPED, not flat:** `{ "success": true, "data": { checkoutId, paymentMethod, paymentHash, paymentRequest, price, expiresAt } }`. Read **`resp.data.paymentRequest`** — a bare `resp.paymentRequest` is `undefined`. `data.price` is the USD charged; `data.expiresAt` is the **payment window**, NOT the VPN's validity (that's in the config — see below). **Confirmed on BOTH VPN and eSIM responses (2026-08-05)** — every `/api/v2/*` endpoint wraps in `{ success, data }`, so read everything off `data`.
   - **Save `data.checkoutId` immediately** — it's the order-lookup handle (`nadanada.me/order`) if anything goes wrong. **There is NO email/receipt parameter anywhere in the API** (verified against their OpenAPI spec) — policy §3's no-receipt-channel rule applies in full: what you persist is the only record.
   - VPN quirk: the `duration` field is **the price-in-USD tag, not a number of days** — the 1-day $0.50 plan is `duration: 0.5` (valid values come from `/api/v2/vpn/countries` `durations[].duration`). Confirmed live: `duration: 1` is rejected (`Invalid duration…`), `0.5` accepted.
2. **Pay the BOLT11 from Spark** — guard first (below).
3. **Complete** — eSIM: `POST /api/v2/esim/complete` with `paymentHash` **or `checkoutId`** (either handle works — verified 2026-08-05; both return 402 while unpaid), documented idempotent. VPN: see the one-shot warning below.

Catalog/pricing lookups are unauthenticated GETs; rental-phone tools (only — see phone note below) also live on a keyless MCP endpoint (`https://mcp.nadanada.me/mcp`).

## Paying — guard first

Use `payMerchantCheckout` from `references/merchant-spending.md` §1 with these nadanada inputs:

- **The advertised 5% Lightning discount is applied PER PRODUCT (verified live 2026-07-27): NOT on VPN, YES on eSIM.** VPN: quote at full catalog price (the guard's first live block proved it — 782-sat invoice vs 743 discounted quote, 782 = exactly the undiscounted $0.50). eSIM: checkouts return `data.originalPrice`/`data.price` with the 5% applied — quote at `usdPrice × 0.95` (confirmed 2026-08-05: `originalPrice 2.99 → price 2.84`). Assume nothing for untested products; the guard will tell you.
- **Fiat→sats conversion adds drift beyond the 2% default.** Use an independent rate (e.g. Coinbase spot — in one live check mempool.space and Coinbase agreed within 0.3%), `toleranceBps: 400`, and a firm `maxAmountSats` ceiling.

```javascript
const check = checkInvoiceAgainstQuote({
  amountSats,                                    // decoded from the returned BOLT11
  quotedSats: Math.round(usdPrice * satsPerUsd), // VPN: full price. eSIM: × 0.95 (see above)
  maxAmountSats: 15_000,
  toleranceBps: 400,                             // fx drift: two different USD/BTC rates in play
});
```

## eSIM SKU namespaces — merchant FIXED this 2026-07-29 (re-verify before trusting)

**History worth knowing, because it will recur:** on 2026-07-27 the entire advertised catalog (`fixed_*` names, from `/esim/portfolio`, `/esim/bundles`, and the website) was rejected by `/api/v2/esim/purchase`; only undocumented country-level `esim_*_V2` SKUs worked, and regional bundles were unbuyable. Reported to the merchant; they replied "already aware, now fixed."

**Re-probed 2026-07-29 — mostly true:** advertised `fixed_*` names now purchase successfully, including regional ones (`fixed_1GB_7D_NORTHAMERICA` / `north-america` → $1.19, the deal that didn't exist two days earlier). The `esim_*_V2` names still work too, so both namespaces are live. **One discrepancy remained when checked:** the catalog advertises `fixed_1GB_7D_EUROPE` at $1.19, and purchasing that exact pair returns `bundle_slug_mismatch` (stable across repeat probes ~20s apart), while `fixed_2GB_15D_EUROPE` on the same slug succeeds. Do not assume that is an unfixed bug — it could be a rollout in progress, or that bundle being genuinely retired upstream with the catalog as the stale side. (Note also that the `esim_*_V2` *region* names are constructed by extrapolating the country pattern; they were never documented, so their failing is unremarkable rather than evidence of anything.)

**The durable rule, whichever explanation holds:** treat every SKU observation here as a snapshot, not a spec — probe the exact pair before quoting a price.

**So the operating rule stands regardless of who fixed what:** a catalog listing is not proof of purchasability at this merchant. Probe the exact `bundleName` + `slug` pair with a purchase request before quoting a price to the user (creating a checkout is free — unpaid invoices expire), and be ready for either namespace.

## VPN completion is ONE-SHOT — prepare before you pay

`POST /api/v2/vpn/config` burns the payment on first success: a retry returns `409 CONFIG_ALREADY_GENERATED`, and it is NOT idempotent regardless of what the general docs imply. Learned by losing one $0.50 config to a client-side crash *after* the server had answered. Hard rules:

- **Generate the WireGuard keypair and PSK BEFORE paying**, and persist them to disk first — the server never sees the private key (their real headline feature), so a lost local key = a dead config. Node's X25519 keys **cannot** be exported as raw (`export({ type: "raw" })` throws) — export DER and take the trailing 32 bytes:
  ```javascript
  import { generateKeyPairSync, randomBytes } from "node:crypto";
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  // WireGuard wants base64 32-byte keys; slice the raw key off the end of the DER.
  const publicKeyB64  = publicKey.export({ type: "spki",  format: "der" }).subarray(-32).toString("base64");
  const privateKeyB64 = privateKey.export({ type: "pkcs8", format: "der" }).subarray(-32).toString("base64");
  const presharedKey  = randomBytes(32).toString("base64");
  // Send publicKeyB64 + presharedKey in the /vpn/request body (above). Keep
  // privateKeyB64 LOCAL and inject it into the returned config's empty
  // `PrivateKey = ` line before handing the file to wg-quick.
  ```
- **The public key and PSK go in the PURCHASE body, not just the config call.** The `POST /api/v2/vpn/request` body is (verified 2026-08-05):
  ```json
  {
    "country": "22",
    "duration": 0.5,
    "publicKey": "<client-generated WireGuard public key>",
    "presharedKey": "<client-generated PSK>",
    "refCode": "sparkbtcbot"
  }
  ```
  `country` is nadanada's **internal numeric code** from `/api/v2/vpn/countries` (`code`, e.g. Canada = `"5"`), NOT the ISO code — ISO fails with `Invalid country code`. The same `paymentHash` + `country` + `publicKey` + `presharedKey` are then replayed to `POST /api/v2/vpn/config`.
- The config response is the **raw WireGuard config as `text/plain`**, not JSON — do not `res.json()` it. Persist the body immediately, before any parsing that could throw.
- **The returned config's `PrivateKey` field is EMPTY** — by design (the server never had it). It comes back as `PrivateKey = ` with nothing after it, and handing that straight to `wg-quick` fails with a valid-*looking* config. **You must inject your locally-generated private key** into the `[Interface]` block before the config is usable. The failure mode is confusing precisely because the file looks complete.
- The config also carries metadata comments — notably **`# Valid until: <UTC>` is the VPN's expiry**, which is distinct from the checkout's `data.expiresAt` (that was only the payment window). Parse the comment, not `expiresAt`, if you want to tell the user when the VPN dies. (`# Location: 🇨🇭 Switzerland` is also included.)
- If completion fails irrecoverably, `checkoutId` + `paymentHash` are what support (`info@nadanada.me`) will want.

## Other product notes

- **Phone products split by surface (verified 2026-07-28):** the v2 API and the MCP tools are **rental numbers only** ($12/3 mo, `userId` + `userSecret` auth — the secret is returned ONCE on first purchase; persist it like a seed). The **$1.50 disposable numbers are website-checkout only** — no API/MCP surface exists despite their agent docs advertising the flow. **Disposables use HOLD invoices** — payment settles only when an SMS arrives (≤20 min), else auto-cancels and refunds. A long-pending payment is *normal, not stuck*: never retry-pay. Whether Spark's SSP tolerates a long-held HTLC remains **untested** — testable only by pasting a website-checkout invoice into the wallet, and stock is limited per country/service (observed fully sold out 2026-07-28), so don't promise users a number is available.
- **eSIM**: data-only, 200+ countries; ICCID (`^89\d{16,18}$`) is the handle for status/top-ups; top-ups queue without losing remaining data. New-purchase AND top-up flows live-validated 2026-07-27/28 (top-up: `POST /esim/[iccid]/purchase` -> pay -> `/esim/[iccid]/complete`; complete returned 402 until the invoice settled then succeeded on retry, confirming eSIM completes are genuinely retryable; the new bundle queued behind the active one as documented). Top-up SKUs: both `esim_*_V2` and `esimc_*_V2` namespaces create checkouts — match the eSIM's existing bundle family; the 5% discount applies to top-ups too.
  - **The purchase response (`data`) echoes a `providerBundleName`** (e.g. `esimc_1GB_7D_JP_V2`) that differs from the `bundleName` you sent (e.g. `fixed_1GB_7D_JP`) — it's the internal provider SKU the catalog name maps to. When you hit a `bundle_slug_mismatch` (see the SKU section above), this field is the debugging handle for what the catalog name actually resolved to.
  - **ICCID status is unconfirmed.** `GET /api/v2/esim/<iccid>` for an unknown/bad ICCID returned a **200 with an HTML "Back in a moment" page**, not JSON or a 404 — so a non-JSON 200 is NOT proof the ICCID is valid or the service is down; it's a catch-all. The real status/usage shape is still untested with a genuine ICCID; verify before relying on it.
  - Minor, undocumented but harmless: `/esim/portfolio` includes a `data.nadaworld` category alongside countries/regions (a separate product line), and bundle objects carry `speed`, `description`, `roamingEnabled`, and `unlimited` beyond the doc's field list — useful when choosing between bundles.
- Refund semantics vary — apply policy §3 accordingly: rental numbers explicitly non-refundable; disposable numbers self-refund via hold invoice; eSIM/VPN treat as non-refundable (the VPN one-shot above makes that literal).
- Deliverables under policy §4's bearer-secret rule: WireGuard configs, eSIM install QR/codes, phone-number dashboard URLs.
- nadanada sells anonymity products. That is legitimate — but if a user's request combines them with concretely harmful intent (e.g. numbers for verification fraud at scale), decline the purchase, not just the conversation.
