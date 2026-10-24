// Fixture generator: tokens encoded by an INDEPENDENT implementation
// (js-macaroon, by the go-macaroon maintainers) so our parser is tested
// against encodings it did not produce itself.
const macaroon = require("macaroon");
const rootKey = Buffer.alloc(32, 7);
const PAST = 1700000000, FUTURE = 4102444800, SOONER = 4000000000;
const mk = (version, id, caveats, thirdParty) => {
  const m = macaroon.newMacaroon({ rootKey, identifier: Buffer.from(id), location: "aperture", version });
  for (const c of caveats) m.addFirstPartyCaveat(Buffer.from(c));
  if (thirdParty) m.addThirdPartyCaveat(Buffer.alloc(32, 9), Buffer.from("opaque-3p-caveat-blob"), "https://discharge.example");
  return Buffer.from(m.exportBinary()).toString("base64");
};
const out = {
  v2ApertureValid: mk(2, "id-v2-valid", ["services=weather:0", "weather_capabilities=forecast", `weather_valid_until=${FUTURE}`]),
  v2ApertureExpired: mk(2, "id-v2-expired", ["services=weather:0", `weather_valid_until=${PAST}`]),
  v2Attenuated: mk(2, "id-v2-atten", ["services=weather:0", `weather_valid_until=${FUTURE}`, `weather_valid_until=${SOONER}`]),
  v2ThirdParty: mk(2, "id-v2-3p", [`valid_until=${FUTURE}`], true),
  v2NoExpiry: mk(2, "id-v2-none", ["services=weather:0"]),
};
console.log(JSON.stringify(out, null, 2));
// self-check with the same library: first bytes + caveat ids it wrote
for (const [k, v] of Object.entries(out)) {
  const b = Buffer.from(v, "base64");
  const m = macaroon.importMacaroon(b);
  console.error(k.padEnd(18), "firstByte=0x" + b[0].toString(16), "v" + m.version, JSON.stringify(m.caveats.map((c) => Buffer.from(c.identifier).toString())));
}
