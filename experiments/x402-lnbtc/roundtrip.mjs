import http from "node:http";
import { randomBytes } from "node:crypto";
import * as L from "./lnbtc.mjs";

// ================= payer: the shape agent.fetchX402 would take =================
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");
const unb64 = (s) => JSON.parse(Buffer.from(s, "base64").toString("utf8"));

async function fetchX402(url, { method = "GET", headers = {}, body, maxAmountSats = 10_000 } = {}, payer, { proof } = {}) {
  const bytes = body === undefined ? new Uint8Array() : new TextEncoder().encode(typeof body === "string" ? body : JSON.stringify(body));
  const send = (extra = {}) => fetch(url, { method, headers: { ...headers, ...extra }, body: bytes.length ? bytes : undefined });
  if (proof) return finish(await send({ "payment-signature": proof.header }), proof);        // paid retry: re-present, never re-pay
  const first = await send();
  if (first.status !== 402) return { paid: false, status: first.status, data: await first.text() };
  const pr = unb64(first.headers.get("payment-required"));
  if (pr.x402Version !== 2 || pr.resource?.url !== url) throw new L.X402Error("invalid_exact_lnbtc_request_mismatch");
  const req = pr.accepts.find((a) => a.scheme === "exact" && a.network === L.MAINNET); // Spark pays mainnet only
  if (!req) throw new L.X402Error("no lnbtc mainnet option offered");
  const binding = L.httpBinding({ method, url, body: bytes, headers: Object.entries(headers), boundHeaders: req.extra?.requestBindingParams?.headers ?? [] });
  const inv = L.validateRequirements(req, binding);                                            // every client MUST, before any money moves
  if (inv.amountMsat % 1000n) throw new Error("refusing a sub-satoshi amount (Spark pays whole sats)");
  const sats = Number(inv.amountMsat / 1000n);
  if (sats > maxAmountSats) throw new Error(`x402 payment blocked: ${sats} sats > maxAmountSats ${maxAmountSats}`);
  const paid = await payer(req.extra.invoice);                                                  // in sparkbtcbot: agent.payAndSettle
  if (!paid.settled) return { paid: true, settled: false, inFlight: paid.id };                  // never re-pay; poll, then present
  if (L.sha256hex(Buffer.from(paid.paymentPreimage, "hex")) !== inv.paymentHash) throw new Error("payer preimage does not match invoice");
  const header = b64({ x402Version: 2, resource: pr.resource, accepted: req, payload: { preimage: paid.paymentPreimage } });
  const p = { header, amountSats: sats, paymentHash: inv.paymentHash };
  return finish(await send({ "payment-signature": header }), p);
}
async function finish(res, proof) {
  const pr = res.headers.get("payment-response");
  const settlement = pr ? unb64(pr) : null;
  const data = await res.text();
  if (res.ok) return { paid: true, settled: true, status: res.status, settlement, data, amountSats: proof.amountSats };
  // Paid but not served: keep the proof — it is still unused unless the server said duplicate_settlement.
  return { paid: true, settled: false, status: res.status, settlement, proof };
}

// ================= spec-following server + mock Lightning =================
const K1 = "0000000000000000000000000000000000000000000000000000000000000001";
const PAYTO = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const lightning = new Map();          // payment hash -> preimage, released when "paid"
const replay = new Set();             // durable in real life; network:payment_hash
let payments = 0, evil = null, dropNextPaid = false;
const payer = async (invoice) => { payments++; const h = L.decodeInvoice(invoice).paymentHash; return { settled: true, paymentPreimage: lightning.get(h), id: h }; };

const server = http.createServer((req, res) => {
  const chunks = []; req.on("data", (c) => chunks.push(c)); req.on("end", () => {
    const url = `http://127.0.0.1:${server.address().port}${req.url}`;
    const bound = req.method === "POST" ? ["content-type"] : evil === "bind-accept" ? ["accept"] : [];
    const binding = L.httpBinding({ method: req.method, url, body: Buffer.concat(chunks), headers: Object.entries(req.headers), boundHeaders: bound });
    const amount = evil === "greedy" ? "500000000" : "21000";
    const issue = () => {
      const preimage = randomBytes(32).toString("hex"), paymentHash = L.sha256hex(Buffer.from(preimage, "hex"));
      lightning.set(paymentHash, preimage);
      const h = evil === "wrong-binding" ? L.httpBinding({ method: "DELETE", url: url.replace(/article\/.*/, "admin/everything") }).digest : binding.digest;
      const hrp = `lnbc${BigInt(amount) / 100n}n`;
      const invoice = L.encodeInvoice({ hrp, timestamp: Math.floor(Date.now() / 1000), privKey: K1, tags: [
        ["p", L.bytesWords(paymentHash)], ["s", L.bytesWords(randomBytes(32).toString("hex"))], ["h", L.bytesWords(h)], ["x", L.intWords(300)], ["c", [18]] ] });
      return { scheme: "exact", network: L.MAINNET, amount, asset: "BTC", payTo: PAYTO, maxTimeoutSeconds: 300,
        extra: { assetTransferMethod: "bolt11", paymentFlow: "upfront", requestHash: binding.digest, requestBindingProfile: "http:1", requestBindingParams: { headers: bound }, invoice } };
    };
    const sig = req.headers["payment-signature"];
    const challenge = (errorReason) => {
      res.writeHead(402, { "payment-required": b64({ x402Version: 2, error: errorReason ?? "payment required", resource: { url }, accepts: [issue()] }),
        ...(errorReason && { "payment-response": b64({ success: false, errorReason, transaction: "", network: L.MAINNET }) }) });
      res.end("{}");
    };
    if (!sig) return challenge();
    // facilitator /settle, per spec § Facilitator Validation (server recomputes the digest from THIS request)
    const payload = unb64(sig), acc = payload.accepted;
    try {
      if (acc.scheme !== "exact" || acc.network !== L.MAINNET || acc.amount !== amount || acc.payTo !== PAYTO || acc.maxTimeoutSeconds !== 300) throw new L.X402Error("invalid_exact_lnbtc_amount_mismatch");
      if (acc.extra.requestHash !== binding.digest) throw new L.X402Error("invalid_exact_lnbtc_request_mismatch");
      const inv = L.decodeInvoice(acc.extra.invoice);
      if (inv.descriptionHash !== binding.digest) throw new L.X402Error("invalid_exact_lnbtc_invoice_request_mismatch");
      if (inv.payee !== PAYTO) throw new L.X402Error("invalid_exact_lnbtc_invoice_payee_mismatch");
      if (L.sha256hex(Buffer.from(payload.payload.preimage, "hex")) !== inv.paymentHash) throw new L.X402Error("invalid_exact_lnbtc_preimage_hash_mismatch");
      if (dropNextPaid) { dropNextPaid = false; res.writeHead(503); return res.end("upstream hiccup"); }  // before consuming the proof
      const key = `${L.MAINNET}:${inv.paymentHash}`;
      if (replay.has(key)) throw new L.X402Error("duplicate_settlement");
      replay.add(key);
      res.writeHead(200, { "content-type": "application/json", "payment-response": b64({ success: true, transaction: inv.paymentHash, network: L.MAINNET }) });
      res.end(JSON.stringify({ article: req.url, body: Buffer.concat(chunks).toString() }));
    } catch (e) { challenge(e.reason ?? e.message); }
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"}  ${label}${extra ? `  (${extra})` : ""}`); };
const expectThrow = async (fn) => { try { await fn(); return null; } catch (e) { return e.reason ?? e.message; } };

let n0 = payments, r = await fetchX402(`${base}/article/A`, {}, payer);
ok("GET: 402 → validate → pay → retry → 200", r.status === 200 && r.settled && payments === n0 + 1, `receipt tx ${r.settlement?.transaction.slice(0, 12)}…, ${r.amountSats} sats`);

n0 = payments; r = await fetchX402(`${base}/article/B`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: { q: "lightning" } }, payer);
ok("POST JSON body with a bound content-type header", r.status === 200 && JSON.parse(r.data).body === '{"q":"lightning"}' && payments === n0 + 1);

const replayRes = await fetch(`${base}/article/B`, { method: "POST", headers: { "content-type": "application/json", "payment-signature": (await (async () => {
  // capture a fresh paid proof, then present it twice
  dropNextPaid = false; const x = await fetchX402(`${base}/article/C`, {}, payer); return x; })()).settled ? "" : "" } });
void replayRes;
n0 = payments; dropNextPaid = true;
r = await fetchX402(`${base}/article/D`, {}, payer);
ok("server fails AFTER we paid (503) → proof kept, nothing lost", r.paid && !r.settled && r.status === 503 && !!r.proof && payments === n0 + 1);
const again = await fetchX402(`${base}/article/D`, {}, payer, { proof: r.proof });
ok("paid retry re-presents the SAME proof → 200, still one payment", again.status === 200 && payments === n0 + 1);
const dup = await fetchX402(`${base}/article/D`, {}, payer, { proof: r.proof });
ok("third presentation of that proof → duplicate_settlement", dup.status === 402 && dup.settlement?.errorReason === "duplicate_settlement" && payments === n0 + 1);
const cross = await fetchX402(`${base}/article/E`, {}, payer, { proof: r.proof });
ok("article D's proof presented for article E → rejected", cross.status === 402 && cross.settlement?.errorReason === "invalid_exact_lnbtc_request_mismatch");

n0 = payments; evil = "bind-accept";
let why = await expectThrow(() => fetchX402(`${base}/article/F`, {}, payer));
ok("server binds `accept`; fetch sends its own default we did not hash → refuse BEFORE paying", why === "invalid_exact_lnbtc_request_mismatch" && payments === n0, why);
r = await fetchX402(`${base}/article/F`, { headers: { accept: "application/json" } }, payer);
ok("same, with accept set explicitly → paid and served", r.status === 200 && payments === n0 + 1);

n0 = payments; evil = "greedy";
why = await expectThrow(() => fetchX402(`${base}/article/G`, { maxAmountSats: 100 }, payer));
ok("hostile server: 500,000-sat price → blocked by maxAmountSats, nothing paid", /blocked/.test(why) && payments === n0, why);

n0 = payments; evil = "wrong-binding";
why = await expectThrow(() => fetchX402(`${base}/article/H`, {}, payer));
ok("hostile server: invoice commits to `DELETE /admin/everything` → refused, nothing paid", why === "invalid_exact_lnbtc_invoice_request_mismatch" && payments === n0, why);

server.close();
console.log(`\n${pass} passed, ${fail} failed · total mock payments: ${payments}`);
process.exit(fail ? 1 : 0);
