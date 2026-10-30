// Test invoices that haven't expired. SparkAgent refuses an invoice with under
// 30 s left (the SDK locks the coins before the SSP checks the expiry), so a
// fixture copied from a real invoice months ago is refused before the code
// under test runs. freshInvoice() re-stamps a BOLT11 with the current time and
// re-signs it with test key 1; every tagged field (amount, payment hash, Spark
// fallback, route hints, expiry) stays as it was. The payee recovered from the
// new signature is test key 1's, which nothing here checks.
import { createHash } from "node:crypto";
import { bech32 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1";

const TEST_KEY = new Uint8Array(32).fill(1);
const SIG_WORDS = 104; // 65 bytes: compact signature + recovery id

// BOLT11 signs hrp || data bits, padded with zero bits to a byte boundary.
function wordsToBytesPadded(words) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const w of words) {
    acc = (acc << 5) | w;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
    acc &= (1 << bits) - 1;
  }
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff);
  return Uint8Array.from(out);
}

export function freshInvoice(bolt11, nowSec = Math.floor(Date.now() / 1000), { prefix: newPrefix, paymentHash } = {}) {
  const { prefix: oldPrefix, words } = bech32.decode(bolt11, 10_000);
  const prefix = newPrefix ?? oldPrefix;
  const timestamp = Array.from({ length: 7 }, (_, i) => Math.floor(nowSec / 2 ** (5 * (6 - i))) % 32);
  const tagged = words.slice(7, words.length - SIG_WORDS);
  if (paymentHash) {
    // Tagged fields: type (5 bits), data length (10 bits), data. 'p' (1) is the payment hash.
    for (let i = 0; i < tagged.length;) {
      const len = tagged[i + 1] * 32 + tagged[i + 2];
      if (tagged[i] === 1) tagged.splice(i + 3, len, ...bech32.toWords(Buffer.from(paymentHash, "hex")));
      i += 3 + len;
    }
  }
  const data = [...timestamp, ...tagged];
  const digest = createHash("sha256").update(Buffer.concat([Buffer.from(prefix, "utf8"), wordsToBytesPadded(data)])).digest();
  const sig = secp256k1.sign(digest, TEST_KEY);
  const sigBytes = new Uint8Array([...sig.toCompactRawBytes(), sig.recovery]);
  return bech32.encode(prefix, [...data, ...bech32.toWords(sigBytes)], 10_000);
}

// A real amountless invoice: `bolt11` re-signed with the amount dropped from
// its prefix ("lnbc20u" -> "lnbc"), under its own payment hash so its dedup
// entries never meet the original's.
export function amountlessInvoice(bolt11, paymentHash = createHash("sha256").update(`amountless:${bolt11}`).digest("hex")) {
  const { prefix } = bech32.decode(bolt11, 10_000);
  return freshInvoice(bolt11, undefined, { prefix: prefix.replace(/^(lnbcrt|lntbs|lntb|lnbc)\d+[munp]?$/, "$1"), paymentHash });
}
