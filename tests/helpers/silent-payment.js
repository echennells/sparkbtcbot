// BIP-352 silent payments, receiver side, for the REGTEST withdrawal test.
// Written from the BIP, sharing no code with the SDK, so a payout the SDK
// accepted is checked by a second implementation: encode a v0 address from
// our own scan/spend keys, then scan the broadcast transaction for the output
// those keys can spend. Covers what the SSP's coop exits use (P2WPKH inputs,
// one output, k = 0), not the whole BIP.
import { createHash, randomBytes } from "node:crypto";
import { secp256k1 } from "@noble/curves/secp256k1";

const { ProjectivePoint: Point, CURVE } = secp256k1;
const N = CURVE.n;

// BIP-352 names no regtest prefix; the SDK uses "sprt".
export const SILENT_PAYMENT_HRP = { MAINNET: "sp", TESTNET: "tsp", SIGNET: "tsp", REGTEST: "sprt" };

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const BECH32M_CONST = 0x2bc830a3;

function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const top = chk >>> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= GEN[i];
  }
  return chk >>> 0;
}

const hrpExpand = (hrp) => [...hrp].map((c) => c.charCodeAt(0) >> 5).concat([0], [...hrp].map((c) => c.charCodeAt(0) & 31));

function toWords(bytes) {
  const out = [];
  let acc = 0;
  let bits = 0;
  for (const b of bytes) {
    acc = (acc << 8) | b;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.push((acc >> bits) & 31);
    }
  }
  if (bits) out.push((acc << (5 - bits)) & 31);
  return out;
}

function bech32mEncode(hrp, words) {
  const pm = polymod([...hrpExpand(hrp), ...words, 0, 0, 0, 0, 0, 0]) ^ BECH32M_CONST;
  const checksum = Array.from({ length: 6 }, (_, i) => (pm >>> (5 * (5 - i))) & 31);
  return `${hrp}1${[...words, ...checksum].map((w) => CHARSET[w]).join("")}`;
}

const sha256 = (...parts) => createHash("sha256").update(Buffer.concat(parts)).digest();
const taggedHash = (tag, ...parts) => {
  const t = sha256(Buffer.from(tag, "utf8"));
  return sha256(t, t, ...parts);
};
const toScalar = (bytes) => BigInt(`0x${Buffer.from(bytes).toString("hex")}`);

function randomScalar() {
  for (;;) {
    const k = toScalar(randomBytes(32));
    if (k > 0n && k < N) return k;
  }
}

// The v0 address for a scan and a spend private key (bigints).
export function silentPaymentAddress(network, scanKey, spendKey) {
  const hrp = SILENT_PAYMENT_HRP[network];
  if (!hrp) throw new Error(`no silent payment prefix for ${network}`);
  const payload = Buffer.concat([
    Point.BASE.multiply(scanKey).toRawBytes(true),
    Point.BASE.multiply(spendKey).toRawBytes(true),
  ]);
  return bech32mEncode(hrp, [0, ...toWords(payload)]);
}

// A fresh receiver: scan and spend keys, and the v0 address that names them.
export function createSilentPaymentReceiver(network) {
  const scanKey = randomScalar();
  const spendKey = randomScalar();
  return { scanKey, spendKey, address: silentPaymentAddress(network, scanKey, spendKey) };
}

// Scan an esplora-shaped transaction (GET /api/tx/:txid) for the k = 0 output
// that `scanKey` / `spendKey` can spend. Returns { vout, outputKey, value,
// privateKey } or null. Throws on an input this helper doesn't model, so an
// unexpected transaction shape fails loudly instead of reading as "no match".
export function scanTransaction(tx, { scanKey, spendKey }) {
  const outpoints = [];
  let sum = null;
  for (const vin of tx.vin) {
    const type = vin.prevout?.scriptpubkey_type;
    const pubkey = vin.witness?.[1];
    if (type !== "v0_p2wpkh" || !pubkey || pubkey.length !== 66) {
      throw new Error(`input ${vin.txid}:${vin.vout} is ${type ?? "unknown"}, not a P2WPKH spend this scanner models`);
    }
    const P = Point.fromHex(pubkey);
    sum = sum ? sum.add(P) : P;
    const vout = Buffer.alloc(4);
    vout.writeUInt32LE(vin.vout);
    outpoints.push(Buffer.concat([Buffer.from(vin.txid, "hex").reverse(), vout]));
  }
  const smallest = outpoints.sort(Buffer.compare)[0];
  const inputHash = toScalar(taggedHash("BIP0352/Inputs", smallest, Buffer.from(sum.toRawBytes(true))));
  const shared = sum.multiply((inputHash * scanKey) % N);
  const t0 = toScalar(taggedHash("BIP0352/SharedSecret", Buffer.from(shared.toRawBytes(true)), Buffer.alloc(4))) % N;
  const outputKey = Buffer.from(Point.BASE.multiply(spendKey).add(Point.BASE.multiply(t0)).toRawBytes(true).subarray(1)).toString("hex");
  const vout = tx.vout.findIndex((o) => o.scriptpubkey === `5120${outputKey}`);
  if (vout < 0) return null;
  return { vout, outputKey, value: tx.vout[vout].value, privateKey: (spendKey + t0) % N };
}
