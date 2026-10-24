import { bech32 } from "@scure/base";
import * as L from "./lnbtc.mjs";

let pass = 0, fail = 0;
const ok = (label, cond) => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); };
const rejects = (label, fn, reason) => {
  try { fn(); ok(`${label} → expected ${reason}, got success`, false); }
  catch (e) { ok(`${label} → ${e.reason ?? e.message}`, (e.reason ?? e.message) === reason); }
};
const clone = (o) => JSON.parse(JSON.stringify(o));

// ---- published binding digests ----
const A = "https://api.example.com/article/A";
const httpA = L.httpBinding({ method: "GET", url: A });
ok("http:1 article A = 0d6623…", httpA.digest === "0d6623f775e025501fa7f0a30b54da25aad62b6ccfe35c85da38016711e6c018");
ok("http:1 article B = 4a9986…", L.httpBinding({ method: "GET", url: "https://api.example.com/article/B" }).digest === "4a99860f75eed1ea8178a5db488e044173bc570c8a6210f2c8590cdf8622d509");
const mcp = (over = {}) => L.mcpBinding({ server: "https://api.example.com/mcp", params: { name: "get_article", arguments: { article: "A" } }, ...over }).digest;
ok("mcp:1 article A = 03941b…", mcp() === "03941bfedc6af8a09b2f459fe83470284a76a8c75801caa9e1487a9276a693f4");
ok("mcp:1 arguments B = b3e425…", mcp({ params: { name: "get_article", arguments: { article: "B" } } }) === "b3e425970d64cd4f08fc4d57a11b76da59ce6a5760d92687398c91f063120678");
ok("mcp:1 delete_article = 3a52bb…", mcp({ params: { name: "delete_article", arguments: { article: "A" } } }) === "3a52bbf19dda8b5765a27246b12e805770298273b48526956c421f02fe043455");
ok("mcp:1 other server = 96903c…", mcp({ server: "https://other.example.com/mcp" }) === "96903c29186c6aabc95e48abafd8ce3ad32b4060f5d5bf22cf75f3fbfe816e45");
ok("mcp:1 JSON-RPC id / progressToken / x402 payment don't change the hash",
  mcp({ params: { name: "get_article", arguments: { article: "A" }, _meta: { progressToken: 7, "x402/payment": { any: 1 } } } }) === mcp());
ok("metadata absent → 6e340b…", L.sha256hex(Uint8Array.of(0)) === "6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d");
ok("metadata null → c58dcb…", L.sha256hex(Uint8Array.from([1, ...new TextEncoder().encode(L.jcs(null))])) === "c58dcb77cee9027d1f4b3207bd876d232e61f79ee9f9dbd4e6d834778da78b16");

// ---- the spec invoice ----
const SPEC_INV = "lnbc250n1pj48ugqpp54y3u9s8ylemsv8l3ewyzzu0klhujvuvmkl6llchq23vy8rzjsf0qsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygshp5p4nz8am4uqj4q8a87z3sk4x6yk4dv2mvel34epw68qqkwy0xcqvqxqzfvcqpjr4rx6ls6j5rpwknuea64evlk7yfx56wmqcer5eerekdsn9tlv6v4ex9mlz5dtm9qapl3svwlqcf7837dmjkru9z9w4h2rvm0md52w2sqxrwu5f";
const G = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const inv = L.decodeInvoice(SPEC_INV);
ok("invoice: payee recovered = G (payTo)", inv.payee === G);
ok("invoice: 25000 msat, bc, expiry 300, created 1700000000", inv.amountMsat === 25000n && inv.currency === "bc" && inv.expiry === 300 && inv.timestamp === 1700000000);
ok("invoice: description hash = request hash", inv.descriptionHash === httpA.digest);
ok("spec preimage hashes to the invoice payment hash",
  L.sha256hex(Buffer.from("0001020304050607080900010203040506070809000102030405060708090102", "hex")) === inv.paymentHash);

// rebuild the spec invoice from its fields with private key 1 (RFC 6979 is deterministic)
const { words } = bech32.decode(SPEC_INV, Number.MAX_SAFE_INTEGER);
const tagList = []; const CH = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
for (let i = 7, end = words.length - 104; i < end; ) { const len = words[i + 1] * 32 + words[i + 2]; tagList.push([CH[words[i]], words.slice(i + 3, i + 3 + len)]); i += 3 + len; }
const K1 = "0000000000000000000000000000000000000000000000000000000000000001";
const rebuilt = L.encodeInvoice({ hrp: "lnbc250n", timestamp: 1700000000, tags: tagList, privKey: K1 });
ok(`encoder rebuilds the spec invoice byte for byte (tags ${tagList.map((t) => t[0]).join("")})`, rebuilt === SPEC_INV);

// ---- full client validation ----
const REQ = {
  scheme: "exact", network: L.MAINNET, amount: "25000", asset: "BTC", payTo: G, maxTimeoutSeconds: 300,
  extra: { assetTransferMethod: "bolt11", paymentFlow: "upfront", requestHash: httpA.digest, requestBindingProfile: "http:1", requestBindingParams: { headers: [] }, invoice: SPEC_INV },
};
const T0 = 1700000000;
ok("spec requirements validate at T0", !!L.validateRequirements(REQ, httpA, { now: T0 }));
rejects("same challenge today (it is a 2023 test vector)", () => L.validateRequirements(REQ, httpA), "invalid_exact_lnbtc_invoice_expired");

// spec negative table, client side
const httpB = L.httpBinding({ method: "GET", url: "https://api.example.com/article/B" });
rejects("pay article A's challenge while actually requesting B", () => L.validateRequirements(REQ, httpB, { now: T0 }), "invalid_exact_lnbtc_request_mismatch");
rejects("server echoes B's hash but the invoice commits to A", () => { const r = clone(REQ); r.extra.requestHash = httpB.digest; L.validateRequirements(r, httpB, { now: T0 }); }, "invalid_exact_lnbtc_invoice_request_mismatch");
const post = L.httpBinding({ method: "POST", url: A });
rejects("method changed to POST, new digest echoed", () => { const r = clone(REQ); r.extra.requestHash = post.digest; L.validateRequirements(r, post, { now: T0 }); }, "invalid_exact_lnbtc_invoice_request_mismatch");
const bodyX = L.httpBinding({ method: "GET", url: A, body: Uint8Array.of(0x78) });
rejects("body changed to 0x78, new digest echoed", () => { const r = clone(REQ); r.extra.requestHash = bodyX.digest; L.validateRequirements(r, bodyX, { now: T0 }); }, "invalid_exact_lnbtc_invoice_request_mismatch");
for (const k of ["requestHash", "requestBindingProfile", "requestBindingParams"])
  rejects(`missing ${k}`, () => { const r = clone(REQ); delete r.extra[k]; L.validateRequirements(r, httpA, { now: T0 }); }, "invalid_exact_lnbtc_request_binding");
rejects("unknown profile", () => { const r = clone(REQ); r.extra.requestBindingProfile = "grpc:1"; L.validateRequirements(r, httpA, { now: T0 }); }, "invalid_exact_lnbtc_request_binding");
rejects("unknown profile parameter", () => { const r = clone(REQ); r.extra.requestBindingParams.extra = 1; L.validateRequirements(r, httpA, { now: T0 }); }, "invalid_exact_lnbtc_request_binding");
const withAccept = L.httpBinding({ method: "GET", url: A, boundHeaders: ["accept"] });
rejects("server's bound-header list changed", () => { const r = clone(REQ); r.extra.requestBindingParams = { headers: ["accept"] }; L.validateRequirements(r, withAccept, { now: T0 }); }, "invalid_exact_lnbtc_request_mismatch");
const inline = L.encodeInvoice({ hrp: "lnbc250n", timestamp: T0, tags: tagList.map(([t, w]) => (t === "h" ? ["d", L.bytesWords(Buffer.from("article A").toString("hex"))] : [t, w])), privKey: K1 });
rejects("invoice carries an inline description instead of a hash", () => { const r = clone(REQ); r.extra.invoice = inline; L.validateRequirements(r, httpA, { now: T0 }); }, "invalid_exact_lnbtc_invoice_description");
const K2 = "0000000000000000000000000000000000000000000000000000000000000002";
const otherSigner = L.encodeInvoice({ hrp: "lnbc250n", timestamp: T0, tags: tagList, privKey: K2 });
rejects("invoice signed by a key other than payTo", () => { const r = clone(REQ); r.extra.invoice = otherSigner; L.validateRequirements(r, httpA, { now: T0 }); }, "invalid_exact_lnbtc_invoice_payee_mismatch");
const tb = L.encodeInvoice({ hrp: "lntb250n", timestamp: T0, tags: tagList, privKey: K1 });
rejects("testnet (tb) invoice under the mainnet id", () => { const r = clone(REQ); r.extra.invoice = tb; L.validateRequirements(r, httpA, { now: T0 }); }, "invalid_exact_lnbtc_invoice_currency_mismatch");
rejects("requirements say 26000 msat, invoice 25000", () => { const r = clone(REQ); r.amount = "26000"; L.validateRequirements(r, httpA, { now: T0 }); }, "invalid_exact_lnbtc_invoice_amount_mismatch");
rejects("maxTimeoutSeconds 301 vs invoice expiry 300", () => { const r = clone(REQ); r.maxTimeoutSeconds = 301; L.validateRequirements(r, httpA, { now: T0 }); }, "invalid_exact_lnbtc_invoice_expiry_mismatch");
ok("created-time boundary: T0-60 accepted (equality valid)", !!L.validateRequirements(REQ, httpA, { now: T0 - 60 }));
rejects("created 61 s in the future", () => L.validateRequirements(REQ, httpA, { now: T0 - 61 }), "invalid_exact_lnbtc_invoice_created_in_future");
ok("expiry boundary: T0+300 accepted", !!L.validateRequirements(REQ, httpA, { now: T0 + 300 }));
rejects("one second past expiry", () => L.validateRequirements(REQ, httpA, { now: T0 + 301 }), "invalid_exact_lnbtc_invoice_expired");
const subMsat = L.encodeInvoice({ hrp: "lnbc2500001p", timestamp: T0, tags: tagList, privKey: K1 });
rejects("sub-millisatoshi p amount", () => L.decodeInvoice(subMsat), "invalid_exact_lnbtc_invoice_decode_failed");
rejects("tampered invoice (one character flipped)", () => L.decodeInvoice(SPEC_INV.slice(0, 60) + (SPEC_INV[60] === "q" ? "p" : "q") + SPEC_INV.slice(61)), "invalid_exact_lnbtc_invoice_decode_failed");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
