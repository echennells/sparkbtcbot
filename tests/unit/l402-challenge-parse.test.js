// L402 challenges live in the WWW-Authenticate HEADER on spec-compliant servers
// (aperture, lightningfaucet); only some return a JSON body. The wrapper used to
// call response.json() unconditionally and never read the header, so a header-only
// server threw "Invalid L402 challenge". It also parsed the header (in the ref
// impl) with split('L402 macaroon="'), which misses the current-spec token= field
// (lightningfaucet sends `L402 version="0", token="...", invoice="..."`). These
// tests pin: header first, body fallback, and macaroon= OR token= in either place.
import { describe, it, expect } from "vitest";
import { parseL402Challenge } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

const mkResp = (headers = {}, body) => ({
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  json: async () => {
    if (body === undefined) throw new Error("no JSON body");
    return body;
  },
});

describe("parseL402Challenge", () => {
  it("parses a HEADER-ONLY challenge using token= (the spec-compliant lightningfaucet case that broke)", async () => {
    const r = mkResp({ "www-authenticate": 'L402 version="0", token="MAC123", invoice="lnbc1abc"' });
    expect(await parseL402Challenge(r)).toEqual({ invoice: "lnbc1abc", macaroon: "MAC123" });
  });

  it("parses a header-only challenge using macaroon= (aperture classic)", async () => {
    const r = mkResp({ "www-authenticate": 'L402 macaroon="MACX", invoice="lnbc2"' });
    expect(await parseL402Challenge(r)).toEqual({ invoice: "lnbc2", macaroon: "MACX" });
  });

  it("handles the LSAT scheme prefix and reversed field order", async () => {
    const r = mkResp({ "www-authenticate": 'LSAT invoice="lnbc3", macaroon="MACL"' });
    expect(await parseL402Challenge(r)).toEqual({ invoice: "lnbc3", macaroon: "MACL" });
  });

  it("falls back to a JSON body when the header is absent ({invoice, macaroon})", async () => {
    const r = mkResp({}, { invoice: "lnbcBODY", macaroon: "MACBODY" });
    expect(await parseL402Challenge(r)).toEqual({ invoice: "lnbcBODY", macaroon: "MACBODY" });
  });

  it("accepts token / payment_request in the JSON body too", async () => {
    const r = mkResp({}, { payment_request: "lnbcPR", token: "TOKB" });
    expect(await parseL402Challenge(r)).toEqual({ invoice: "lnbcPR", macaroon: "TOKB" });
  });

  it("returns undefined fields (never throws) when neither source has them — caller decides", async () => {
    const r = mkResp({}, {});
    expect(await parseL402Challenge(r)).toEqual({ invoice: undefined, macaroon: undefined });
  });
});
