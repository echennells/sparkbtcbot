// lib/l402-token.js reads the expiry a server signed into an L402 token, so
// fetchL402 can refuse to buy a pass the server has already declared dead.
// Fixtures come from INDEPENDENT encoders, not from our own code: V2 macaroons
// from js-macaroon 3.0.4 (the go-macaroon maintainers' JS port, the format
// aperture emits), V1 from pymacaroons (its default serializer), and a JSON
// token captured live from lightningfaucet.com on 2026-09-26, and satring.com's
// double-base64 V1 macaroon captured live the same day. Timestamps:
// 1700000000 is 2023 (expired), 4102444800 is 2100 (valid).
import { describe, it, expect } from "vitest";
import { decodeL402Token, l402TokenExpiry } from "../../lib/l402-token.js";

const FX = {
  v2ApertureValid: "AgEIYXBlcnR1cmUCC2lkLXYyLXZhbGlkAAISc2VydmljZXM9d2VhdGhlcjowAAIdd2VhdGhlcl9jYXBhYmlsaXRpZXM9Zm9yZWNhc3QAAh53ZWF0aGVyX3ZhbGlkX3VudGlsPTQxMDI0NDQ4MDAAAAYgSOsuF9aj0Ne4umzqatlKrqj0g+NjvYPvGiJk1uuYfYQ=",
  v2ApertureExpired: "AgEIYXBlcnR1cmUCDWlkLXYyLWV4cGlyZWQAAhJzZXJ2aWNlcz13ZWF0aGVyOjAAAh53ZWF0aGVyX3ZhbGlkX3VudGlsPTE3MDAwMDAwMDAAAAYg1C0YAL7aAzFs94agoy/RsvDw+ZwSnrbENgnm1qtU7/I=",
  v2Attenuated: "AgEIYXBlcnR1cmUCC2lkLXYyLWF0dGVuAAISc2VydmljZXM9d2VhdGhlcjowAAIed2VhdGhlcl92YWxpZF91bnRpbD00MTAyNDQ0ODAwAAIed2VhdGhlcl92YWxpZF91bnRpbD00MDAwMDAwMDAwAAAGIKkVh8mkCFB8iGIdIKjhOvMSqNfAwFU73Ew1hh2SR0kl",
  v2ThirdParty: "AgEIYXBlcnR1cmUCCGlkLXYyLTNwAAIWdmFsaWRfdW50aWw9NDEwMjQ0NDgwMAABGWh0dHBzOi8vZGlzY2hhcmdlLmV4YW1wbGUCFW9wYXF1ZS0zcC1jYXZlYXQtYmxvYgRIIBvyiBZyig6qrAxMhjK1sZmPaeu0/trMMFE8kcyIyLDkZuju/JWsYnWhYmbWo1HULe2p/G37bUvAzRGZEndP9+E/3OHev9MxAAAGIBJhMySVldVQryIxgmymUjYrjD6PETnVEOjohJifj68V",
  v2NoExpiry: "AgEIYXBlcnR1cmUCCmlkLXYyLW5vbmUAAhJzZXJ2aWNlcz13ZWF0aGVyOjAAAAYgF9u/zTXNMRREX53a6BHJkvP4ZqLIzWD03aJYqEUjcRM=",
  v1GenericExpired: "MDAxNmxvY2F0aW9uIHB5c2VydmVyCjAwMWRpZGVudGlmaWVyIGlkLXYxLWV4cGlyZWQKMDAxZmNpZCB2YWxpZF91bnRpbD0xNzAwMDAwMDAwCjAwMmZzaWduYXR1cmUgVjw9L8EQsVfrPO99APz0-qkRP5mdsri1kC8RC7PLKZMK",
  v1ApertureValid: "MDAxNmxvY2F0aW9uIHB5c2VydmVyCjAwMWJpZGVudGlmaWVyIGlkLXYxLXZhbGlkCjAwMWJjaWQgc2VydmljZXM9d2VhdGhlcjowCjAwMjdjaWQgd2VhdGhlcl92YWxpZF91bnRpbD00MTAyNDQ0ODAwCjAwMmZzaWduYXR1cmUgJn7iNBMzk-UHDep1937x2hkPECtUHyagk_-z8lOb_1kK",
  v1NoExpiry: "MDAxNmxvY2F0aW9uIHB5c2VydmVyCjAwMWFpZGVudGlmaWVyIGlkLXYxLW5vbmUKMDAxYmNpZCBzZXJ2aWNlcz13ZWF0aGVyOjAKMDAyZnNpZ25hdHVyZSD2iGdWmjNS_-V-JvT8rdsu_j4mfpbPRrpqv_DzRZwwKQo",
  satringLive: "TURBeE5XeHZZMkYwYVc5dUlITmhkSEpwYm1jS01EQTFNR2xrWlc1MGFXWnBaWElnT0RJelptRmxaV1JoT1RVM01tRTVZVEV4TVdGaFlUSXlOakl6WmpVM09HWTVOak5qWXpReE1HTmlPVGMzTWpOa01EUTRNRE14TkdReU1XRXpaVEJrTXdvd01EVTRZMmxrSUhCaGVXMWxiblJmYUdGemFDQTlJRGd5TTJaaFpXVmtZVGsxTnpKaE9XRXhNVEZoWVdFeU1qWXlNMlkxTnpobU9UWXpZMk0wTVRCallqazNOekl6WkRBME9EQXpNVFJrTWpGaE0yVXdaRE1LTURBeVpuTnBaMjVoZEhWeVpTRDI3UzExT2hJU21LN2pIQnZ6WVBqV0pvQ0gyNG94ZmZTV25GTHN0SGN6eUFv",
  faucetLive: "eyJpZGVudGlmaWVyIjoiNTZiOGNlMTk5YjQwMmIzNjMxYTdkZjQwYWZlMTk0MTYiLCJsb2NhdGlvbiI6ImxpZ2h0bmluZ2ZhdWNldC5jb20iLCJjYXZlYXRzIjpbeyJ0eXBlIjoicGF5bWVudF9oYXNoIiwidmFsdWUiOiJkMDJmMTE1MzFjNTRhNjlkMjNjZDY4Yjg0N2Y3NTE4YzA3NTAyOGNmODQ5OGMxZDc3ZDBjNDJmYjg0Y2EwNzJhIn0seyJ0eXBlIjoiZXhwaXJ5IiwidmFsdWUiOjE3OTAzODgwMTd9LHsidHlwZSI6InNlcnZpY2UiLCJ2YWx1ZSI6Impva2UifSx7InR5cGUiOiJjYXBhYmlsaXRpZXMiLCJ2YWx1ZSI6WyJzdGFuZGFyZCIsInJhbmRvbSIsInF1b3RlZF9wYXJhbXM6ZmMxODQ1MWUyMGFhNGYxMGEzZGUwYThmMDM5ZmYwNWQiXX1dLCJzaWduYXR1cmUiOiIxMTM3ZGU0Yjg5ZTEyN2Y3NDcxNDE0MmU0MjcxMmQwMTc3MGNlMTYxYTQ2OTg4MmVlY2IyYjU0NTE4MmRiNjU1In0=",
};

const jsonToken = (caveats) => Buffer.from(JSON.stringify({ identifier: "x", caveats })).toString("base64");

describe("l402TokenExpiry", () => {
  it("reads aperture's per-service `<service>_valid_until` from a V2 macaroon", () => {
    expect(l402TokenExpiry(FX.v2ApertureValid)).toEqual({ format: "macaroon-v2", expiresAt: 4102444800 });
    expect(l402TokenExpiry(FX.v2ApertureExpired)).toEqual({ format: "macaroon-v2", expiresAt: 1700000000 });
  });

  it("takes the EARLIEST expiry of an attenuated token (every caveat must hold)", () => {
    expect(l402TokenExpiry(FX.v2Attenuated).expiresAt).toBe(4000000000);
  });

  it("reads V1 macaroons (pymacaroons' default) — generic and per-service keys", () => {
    expect(l402TokenExpiry(FX.v1GenericExpired)).toEqual({ format: "macaroon-v1", expiresAt: 1700000000 });
    expect(l402TokenExpiry(FX.v1ApertureValid)).toEqual({ format: "macaroon-v1", expiresAt: 4102444800 });
  });

  it("reads lightningfaucet's JSON token (captured live), skipping array-valued caveats", () => {
    expect(l402TokenExpiry(FX.faucetLive)).toEqual({ format: "json", expiresAt: 1790388017 });
    expect(decodeL402Token(FX.faucetLive).caveats.map((c) => c.key)).toEqual(["payment_hash", "expiry", "service"]);
  });

  it("returns expiresAt null for a readable token with no expiry caveat", () => {
    expect(l402TokenExpiry(FX.v2NoExpiry)).toEqual({ format: "macaroon-v2", expiresAt: null });
    expect(l402TokenExpiry(FX.v1NoExpiry)).toEqual({ format: "macaroon-v1", expiresAt: null });
  });

  it("never guesses units: only 9–11 digit unix SECONDS count as an expiry", () => {
    expect(l402TokenExpiry(jsonToken([{ type: "expiry", value: "tomorrow" }])).expiresAt).toBeNull();
    expect(l402TokenExpiry(jsonToken([{ type: "expiry", value: 1790388017000 }])).expiresAt).toBeNull(); // ms
    expect(l402TokenExpiry(jsonToken([{ type: "valid_until", value: "1790388017" }])).expiresAt).toBe(1790388017);
  });

  it("returns null — no information, never a block — for anything it cannot parse", () => {
    for (const bad of [undefined, null, 42, "", "mac1", "not base64 !!", "AAAA", "Ag==", Buffer.from("0005x").toString("base64"), "A".repeat(20_000)]) {
      expect(l402TokenExpiry(bad)).toBeNull();
    }
  });
});

describe("decodeL402Token", () => {
  it("unwraps satring.com's second base64 layer (captured live) — exactly one layer", () => {
    const decoded = decodeL402Token(FX.satringLive);
    expect(decoded.format).toBe("macaroon-v1");
    expect(decoded.caveats.map((c) => c.key)).toEqual(["payment_hash"]);
    expect(l402TokenExpiry(FX.satringLive)).toEqual({ format: "macaroon-v1", expiresAt: null }); // no expiry caveat today
    const tripleWrapped = Buffer.from(FX.satringLive).toString("base64");
    expect(decodeL402Token(tripleWrapped)).toBeNull();
  });

  it("skips third-party caveats (their ids are opaque discharge blobs, not conditions)", () => {
    const { format, caveats } = decodeL402Token(FX.v2ThirdParty);
    expect(format).toBe("macaroon-v2");
    expect(caveats).toEqual([{ key: "valid_until", value: "4102444800" }]);
  });

  it("returns every first-party key=value caveat in order", () => {
    expect(decodeL402Token(FX.v2ApertureValid).caveats).toEqual([
      { key: "services", value: "weather:0" },
      { key: "weather_capabilities", value: "forecast" },
      { key: "weather_valid_until", value: "4102444800" },
    ]);
  });
});
