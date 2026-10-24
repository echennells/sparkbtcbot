// BOLT11 payee recovery: the signature covers SHA-256(hrp || data words
// packed to bytes, zero-padded); the last 104 words are sig(64) + recid(1).
import { createRequire } from "node:module";
const require = createRequire("/workspace/package.json");
const { bech32 } = require("@scure/base");
const { secp256k1 } = require("@noble/curves/secp256k1");
const { sha256 } = require("@noble/hashes/sha256");

const pack = (words) => {
  const out = []; let acc = 0, bits = 0;
  for (const w of words) { acc = (acc << 5) | w; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } }
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return Uint8Array.from(out);
};
const hex = (b) => Buffer.from(b).toString("hex");

export function recoverPayee(invoice) {
  const { prefix, words } = bech32.decode(invoice.toLowerCase(), Number.MAX_SAFE_INTEGER);
  const sig = pack(words.slice(-104));
  const data = pack(words.slice(0, -104));
  const msg = sha256(Uint8Array.from([...Buffer.from(prefix, "utf8"), ...data]));
  const s = secp256k1.Signature.fromCompact(sig.slice(0, 64)).addRecoveryBit(sig[64]);
  return hex(s.recoverPublicKey(msg).toRawBytes(true));
}

export function descriptionHash(invoice) {
  const { words } = bech32.decode(invoice.toLowerCase(), Number.MAX_SAFE_INTEGER);
  const tagged = words.slice(7, -104);
  for (let i = 0; i < tagged.length; ) {
    const tag = tagged[i], len = tagged[i + 1] * 32 + tagged[i + 2];
    if (tag === 23) return hex(pack(tagged.slice(i + 3, i + 3 + len)).slice(0, 32));
    i += 3 + len;
  }
  return null;
}
