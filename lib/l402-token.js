// L402 token inspection — SDK-free, no dependencies. Reads the caveats a
// server signed into the credential it hands out with a 402 challenge, so the
// client can see what the SERVER says about the pass before paying for it.
//
// Three wire formats seen in the wild:
//   - macaroon V2 binary (aperture / go-macaroon, the common case)
//   - macaroon V1 binary (libmacaroons / pymacaroons' default serializer)
//   - lightningfaucet's JSON token: base64 of { identifier, location, caveats: [{ type, value }], signature }
// and one wrapping quirk: satring.com base64-encodes its already-base64 V1
// macaroon a second time. Exactly one extra layer is unwrapped, never more.
//
// This is READ-ONLY inspection. Nothing here verifies the signature — only the
// issuing server holds that key. It exists to answer one question before money
// moves: has the server already declared this pass dead? Anything this module
// cannot parse returns null, and callers treat null as "no information", never
// as a reason to block.

const MAX_TOKEN_CHARS = 16_384;
const MAX_CAVEATS = 256;
const B64 = /^[A-Za-z0-9+/_-]+={0,2}$/;

// Field types from go-macaroon's V2 binary format (marshal-v2.go).
const V2_EOS = 0;
const V2_IDENTIFIER = 2;
const V2_VERIFICATION_ID = 4; // present only on third-party caveats

// Returns { format, caveats: [{ key, value }] }, or null when the token is not
// one of the known formats. Third-party caveats are skipped: their ids are
// opaque discharge blobs, not "key=value" conditions.
export function decodeL402Token(token) {
  return decodeLayer(token, 0);
}

function decodeLayer(token, depth) {
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN_CHARS || !B64.test(token)) return null;
  const buf = Buffer.from(token, "base64");
  if (!buf.length) return null;
  try {
    if (buf[0] === 0x02) return { format: "macaroon-v2", caveats: toKeyValues(readV2Caveats(buf)) };
    if (buf[0] === 0x7b /* { */) return decodeJsonToken(buf);
    if (/^[0-9a-f]{4}$/.test(buf.subarray(0, 4).toString("latin1"))) {
      return { format: "macaroon-v1", caveats: toKeyValues(readV1Caveats(buf)) };
    }
  } catch {
    return null;
  }
  // Not a known format: maybe a second base64 layer (satring.com). A raw V1
  // macaroon never reaches here — its bytes contain spaces and newlines, and
  // its 4-hex-digit prefix matched above.
  return depth === 0 ? decodeLayer(buf.toString("latin1"), 1) : null;
}

// Earliest expiry the server signed into the token, in unix seconds. A token
// is attenuated — every caveat must hold — so the earliest one wins.
// Recognized: `valid_until` and aperture's per-service `<service>_valid_until`
// (both unix seconds), and lightningfaucet's JSON `expiry`. Returns
// { format, expiresAt } with expiresAt null when no expiry caveat is present,
// or null when the token is undecodable.
export function l402TokenExpiry(token) {
  const decoded = decodeL402Token(token);
  if (!decoded) return null;
  let expiresAt = null;
  for (const { key, value } of decoded.caveats) {
    if (!isExpiryKey(key) || !/^\d{9,11}$/.test(value)) continue; // unix SECONDS only; never guess units
    const at = Number(value);
    expiresAt = expiresAt === null ? at : Math.min(expiresAt, at);
  }
  return { format: decoded.format, expiresAt };
}

function isExpiryKey(key) {
  return key === "valid_until" || key.endsWith("_valid_until") || key === "expiry";
}

function toKeyValues(ids) {
  const out = [];
  for (const id of ids) {
    const s = id.toString("utf8");
    const eq = s.indexOf("=");
    if (eq <= 0) continue;
    out.push({ key: s.slice(0, eq).trim(), value: s.slice(eq + 1).trim() });
  }
  return out;
}

// V2: version byte, then sections of (type uvarint, length uvarint, bytes)
// fields, each section closed by an EOS byte. Section 1 is the header
// (location, identifier); each following section is one caveat; an empty
// section ends the caveat list (the signature field follows, unread here).
function readV2Caveats(buf) {
  let pos = 1;
  const uvarint = () => {
    let x = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      if (pos >= buf.length) throw new Error("truncated");
      const b = buf[pos++];
      x += (b & 0x7f) * 2 ** shift;
      if (b < 0x80) return x;
    }
    throw new Error("varint too long");
  };
  const section = () => {
    const fields = [];
    for (;;) {
      const type = uvarint();
      if (type === V2_EOS) return fields;
      const len = uvarint();
      if (pos + len > buf.length) throw new Error("truncated");
      fields.push({ type, data: buf.subarray(pos, pos + len) });
      pos += len;
    }
  };
  section(); // header
  const ids = [];
  for (let n = 0; n < MAX_CAVEATS; n++) {
    const fields = section();
    if (!fields.length) return ids;
    if (fields.some((f) => f.type === V2_VERIFICATION_ID)) continue;
    const id = fields.find((f) => f.type === V2_IDENTIFIER);
    if (id) ids.push(id.data);
  }
  throw new Error("too many caveats");
}

// V1: packets of 4 hex digits (total packet length, header included), then
// "key value\n". A `vid` packet follows the `cid` of a third-party caveat.
function readV1Caveats(buf) {
  let pos = 0;
  const caveats = [];
  while (pos < buf.length) {
    const size = parseInt(buf.subarray(pos, pos + 4).toString("latin1"), 16);
    if (!(size > 5) || pos + size > buf.length || buf[pos + size - 1] !== 0x0a) throw new Error("bad packet");
    const body = buf.subarray(pos + 4, pos + size - 1);
    const space = body.indexOf(0x20);
    if (space <= 0) throw new Error("bad packet");
    const key = body.subarray(0, space).toString("latin1");
    if (key === "cid") caveats.push({ id: body.subarray(space + 1), thirdParty: false });
    else if (key === "vid" && caveats.length) caveats[caveats.length - 1].thirdParty = true;
    if (caveats.length > MAX_CAVEATS) throw new Error("too many caveats");
    pos += size;
  }
  return caveats.filter((c) => !c.thirdParty).map((c) => c.id);
}

function decodeJsonToken(buf) {
  const obj = JSON.parse(buf.toString("utf8"));
  if (!obj || typeof obj !== "object" || !Array.isArray(obj.caveats)) return null;
  const caveats = [];
  for (const c of obj.caveats.slice(0, MAX_CAVEATS)) {
    if (!c || typeof c.type !== "string") continue;
    if (typeof c.value !== "string" && typeof c.value !== "number") continue; // arrays/objects carry no expiry
    caveats.push({ key: c.type, value: String(c.value) });
  }
  return { format: "json", caveats };
}
