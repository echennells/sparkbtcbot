// x402 `exact` on lnbtc — PAYER side only. Prototype for sparkbtcbot.
// Deps are already in the tree via @buildonspark/spark-sdk.
import { bech32 } from "@scure/base";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 as sha256raw } from "@noble/hashes/sha256";

export const MAINNET = "lnbtc:000000000019d6689c085ae165831e93";
export const TESTNET = "lnbtc:000000000933ea01ad0ee984209779ba";
const CURRENCY = { [MAINNET]: "bc", [TESTNET]: "tb" };
const SKEW = 60;
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const HEX64 = /^[0-9a-f]{64}$/;
const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const URI = /^[A-Za-z0-9._~:/?\[\]@!$&'()*+,;=%-]+$/;

export class X402Error extends Error { constructor(reason) { super(reason); this.reason = reason; } }
const bad = (r) => new X402Error(`invalid_exact_lnbtc_${r}`);
const enc = new TextEncoder();
const hex = (b) => Buffer.from(b).toString("hex");
export const sha256hex = (bytes) => hex(sha256raw(bytes));

// ---- JCS (RFC 8785) for JSON values ------------------------------------------
const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export function jcs(v) {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v) || (Number.isInteger(v) && !Number.isSafeInteger(v))) throw bad("request_binding");
    return JSON.stringify(v);
  }
  if (typeof v === "string") { if (LONE.test(v)) throw bad("request_binding"); return JSON.stringify(v); }
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  if (typeof v === "object") {
    const keys = Object.keys(v).sort(); // default sort = UTF-16 code units, as JCS requires
    return `{${keys.map((k) => { if (LONE.test(k)) throw bad("request_binding"); return `${JSON.stringify(k)}:${jcs(v[k])}`; }).join(",")}}`;
  }
  throw bad("request_binding");
}
const digest = (binding) => sha256hex(enc.encode(jcs(binding)));

// ---- request bindings (computed from OUR outgoing request) --------------------
function checkUri(u, httpOnly) {
  if (typeof u !== "string" || !URI.test(u) || /%(?![0-9A-Fa-f]{2})/.test(u)) throw bad("request_binding");
  let p; try { p = new URL(u); } catch { throw bad("request_binding"); }
  if (p.username || p.password || u.includes("#")) throw bad("request_binding");
  if ((httpOnly || /^https?:$/.test(p.protocol)) && (!/^https?:$/.test(p.protocol) || !p.hostname)) throw bad("request_binding");
}
export function checkParams(profile, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) throw bad("request_binding");
  const keys = Object.keys(params).sort().join(",");
  if (profile === "http:1") {
    const n = params.headers;
    if (keys !== "headers" || !Array.isArray(n) || n.some((h) => typeof h !== "string" || !TOKEN.test(h) || h !== h.toLowerCase() || h === "payment-signature")) throw bad("request_binding");
    if (jcs(n) !== jcs([...new Set(n)].sort())) throw bad("request_binding");
  } else if (profile === "mcp:1") {
    const m = params.metadata;
    if (keys !== "metadata,server") throw bad("request_binding");
    checkUri(params.server, false);
    if (!Array.isArray(m) || m.some((x) => typeof x !== "string" || !x || x === "x402/payment" || x === "progressToken")) throw bad("request_binding");
    if (jcs(m) !== jcs([...new Set(m)].sort())) throw bad("request_binding");
  } else throw bad("request_binding");
}

// headers: array of [name, value] exactly as we will send them; boundHeaders: the
// server's requestBindingParams.headers (validated) — names only, never values.
export function httpBinding({ method, url, body = new Uint8Array(), headers = [], boundHeaders = [] }) {
  checkUri(url, true);
  if (typeof method !== "string" || !TOKEN.test(method)) throw bad("request_binding");
  checkParams("http:1", { headers: boundHeaders });
  const selected = new Map(boundHeaders.map((n) => [n, []]));
  for (const [name, value] of headers) {
    const k = String(name).toLowerCase();
    if (!selected.has(k)) continue;
    if ([...String(value)].some((c) => (c.charCodeAt(0) < 32 && c !== "\t") || c.charCodeAt(0) > 126)) throw bad("request_binding");
    selected.get(k).push(String(value).replace(/^[ \t]+|[ \t]+$/g, ""));
  }
  const fields = [...selected].map(([name, vals]) => ({
    name,
    valueHash: sha256hex(vals.length ? Uint8Array.from([1, ...enc.encode(vals.join(", "))]) : Uint8Array.of(0)),
  }));
  const d = digest({ domain: "x402:exact:lnbtc:bolt11:http:1", method, url, bodyHash: sha256hex(body), headers: fields });
  return { profile: "http:1", params: { headers: [...boundHeaders] }, digest: d, resourceUrl: url };
}

// server comes from OUR configuration of which MCP server we meant to call.
export function mcpBinding({ server, params, boundMetadata = [], resourceUrl }) {
  checkParams("mcp:1", { server, metadata: boundMetadata });
  const name = params?.name, args = params?.arguments ?? {}, meta = params?._meta ?? {};
  if (typeof name !== "string" || !name) throw bad("request_binding");
  for (const o of [args, meta]) if (o === null || typeof o !== "object" || Array.isArray(o)) throw bad("request_binding");
  const fields = boundMetadata.map((k) => ({
    name: k,
    valueHash: sha256hex(k in meta ? Uint8Array.from([1, ...enc.encode(jcs(meta[k]))]) : Uint8Array.of(0)),
  }));
  const d = digest({ domain: "x402:exact:lnbtc:bolt11:mcp:1", server, method: "tools/call", name, arguments: args, metadata: fields });
  return { profile: "mcp:1", params: { server, metadata: [...boundMetadata] }, digest: d, resourceUrl };
}

// ---- strict BOLT11 ------------------------------------------------------------
const pack = (words) => { const out = []; let acc = 0, bits = 0;
  for (const w of words) { acc = ((acc << 5) | w) & 0xffff; bits += 5; while (bits >= 8) { bits -= 8; out.push((acc >> bits) & 0xff); } }
  if (bits > 0) out.push((acc << (8 - bits)) & 0xff); return Uint8Array.from(out); };
const wordsToInt = (ws) => ws.reduce((n, w) => n * 32 + w, 0);
const MULT = { m: 100_000_000n, u: 100_000n, n: 100n, p: null };

export function decodeInvoice(invoice) {
  try {
    if (invoice !== invoice.toLowerCase()) throw bad("invoice_decode_failed");
    const { prefix, words } = bech32.decode(invoice, Number.MAX_SAFE_INTEGER);
    const m = /^ln(bcrt|tbs|bc|tb)([0-9]+)([munp]?)$/.exec(prefix);
    if (!m || words.length < 111) throw bad("invoice_decode_failed");
    const n = BigInt(m[2]);
    let amountMsat;
    if (m[3] === "p") { if (n % 10n) throw bad("invoice_decode_failed"); amountMsat = n / 10n; }
    else amountMsat = n * (m[3] ? MULT[m[3]] : 100_000_000_000n);
    if (amountMsat <= 0n) throw bad("invoice_decode_failed");
    const end = words.length - 104, tags = {};
    for (let i = 7; i < end; ) {
      if (i + 3 > end) throw bad("invoice_decode_failed");
      const t = CHARSET[words[i]], len = words[i + 1] * 32 + words[i + 2];
      if (i + 3 + len > end) throw bad("invoice_decode_failed");
      (tags[t] ??= []).push(words.slice(i + 3, i + 3 + len)); i += 3 + len;
    }
    if ((tags.h?.length ?? 0) !== 1 || tags.d) throw bad("invoice_description");
    for (const t of ["p", "h", "s"]) { const f = tags[t] ?? []; if (f.length !== 1 || f[0].length !== 52 || f[0][51] & 15) throw bad("invoice_decode_failed"); }
    for (const t of ["n", "x", "c", "9"]) if ((tags[t]?.length ?? 0) > 1) throw bad("invoice_decode_failed");
    if (tags.n && (tags.n[0].length !== 53 || tags.n[0][52] & 1)) throw bad("invoice_decode_failed");
    const sigBytes = pack(words.slice(end));
    const msg = sha256raw(Uint8Array.from([...enc.encode(prefix), ...pack(words.slice(0, end))]));
    const sig = secp256k1.Signature.fromCompact(sigBytes.slice(0, 64)).addRecoveryBit(sigBytes[64]);
    if (sig.hasHighS()) throw bad("invoice_decode_failed");
    const payee = hex(sig.recoverPublicKey(msg).toRawBytes(true));
    if (tags.n && hex(pack(tags.n[0]).slice(0, 33)) !== payee) throw bad("invoice_decode_failed");
    return {
      currency: m[1], amountMsat, payee,
      timestamp: wordsToInt(words.slice(0, 7)),
      expiry: tags.x ? wordsToInt(tags.x[0]) : 3600,
      paymentHash: hex(pack(tags.p[0]).slice(0, 32)),
      descriptionHash: hex(pack(tags.h[0]).slice(0, 32)),
    };
  } catch (e) { if (e instanceof X402Error) throw e; throw bad("invoice_decode_failed"); }
}

// ---- the client MUST list (spec § Client Payment Construction) ---------------
export function validateRequirements(req, binding, { now = Date.now() / 1000, skew = SKEW } = {}) {
  if (req?.scheme !== "exact") throw new X402Error("unsupported_scheme");
  if (!(req.network in CURRENCY)) throw new X402Error("unsupported_network");
  if (req.asset !== "BTC") throw bad("asset");
  if (typeof req.amount !== "string" || !/^[0-9]+$/.test(req.amount) || BigInt(req.amount) <= 0n) throw bad("amount");
  if (!Number.isSafeInteger(req.maxTimeoutSeconds) || req.maxTimeoutSeconds <= 0) throw bad("max_timeout");
  if (typeof req.payTo !== "string" || !/^0[23][0-9a-f]{64}$/.test(req.payTo)) throw bad("pay_to_malformed");
  try { secp256k1.ProjectivePoint.fromHex(req.payTo); } catch { throw bad("pay_to_malformed"); }
  const x = req.extra ?? {};
  if ((x.assetTransferMethod ?? "bolt11") !== "bolt11") throw bad("asset_transfer_method");
  if (x.paymentFlow !== "upfront") throw bad("payment_flow");
  if (typeof x.requestHash !== "string" || !HEX64.test(x.requestHash)) throw bad("request_binding");
  checkParams(x.requestBindingProfile, x.requestBindingParams);
  if (typeof x.invoice !== "string" || !x.invoice) throw bad("invoice_missing");
  // our request, recomputed locally, must be what the server priced
  if (binding.profile !== x.requestBindingProfile || jcs(binding.params) !== jcs(x.requestBindingParams) || binding.digest !== x.requestHash) throw bad("request_mismatch");
  const inv = decodeInvoice(x.invoice);
  if (inv.descriptionHash !== x.requestHash) throw bad("invoice_request_mismatch");
  if (inv.payee !== req.payTo) throw bad("invoice_payee_mismatch");
  if (inv.currency !== CURRENCY[req.network]) throw bad("invoice_currency_mismatch");
  if (inv.amountMsat !== BigInt(req.amount)) throw bad("invoice_amount_mismatch");
  if (inv.expiry !== req.maxTimeoutSeconds) throw bad("invoice_expiry_mismatch");
  if (inv.timestamp > now + skew) throw bad("invoice_created_in_future");
  if (now > inv.timestamp + inv.expiry) throw bad("invoice_expired");
  return inv;
}

// ---- test-only encoder (to rebuild the spec invoice byte for byte) -----------
export function encodeInvoice({ hrp, timestamp, tags, privKey }) {
  const ts = []; for (let i = 6, t = timestamp; i >= 0; i--) { ts[i] = t % 32; t = Math.floor(t / 32); }
  const data = [...ts];
  for (const [t, words] of tags) data.push(CHARSET.indexOf(t), Math.floor(words.length / 32), words.length % 32, ...words);
  const msg = sha256raw(Uint8Array.from([...enc.encode(hrp), ...pack(data)]));
  const s = secp256k1.sign(msg, privKey);
  const sigWords = bech32.toWords(Uint8Array.from([...s.toCompactRawBytes(), s.recovery]));
  return bech32.encode(hrp, [...data, ...sigWords], Number.MAX_SAFE_INTEGER);
}
export const intWords = (n) => { const w = []; do { w.unshift(n % 32); n = Math.floor(n / 32); } while (n > 0); return w; };
export const bytesWords = (h) => bech32.toWords(Buffer.from(h, "hex"));
