// fetchL402 end to end on hosted REGTEST: a local HTTPS L402 server whose
// invoices are a throwaway shop wallet's tracked invoices, paid for real by the
// funded test wallet through SparkAgent. Run by
// tests/integration/funded/l402-local-server.test.js, which makes a throwaway
// localhost certificate and starts this with NODE_EXTRA_CA_CERTS pointing at it
// and L402_TEST_CERT_DIR naming its folder. Prints one JSON line per check and
// a summary; exits 1 if any check failed.
import "../setup.js";
import https from "node:https";
import { readFileSync, mkdtempSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic, returnSats } from "./wallet.js";

const CERT_DIR = process.env.L402_TEST_CERT_DIR;
if (!CERT_DIR) throw new Error("L402_TEST_CERT_DIR is not set");
const PRICE = 50;
process.env.SPARK_LEAF_VAULT = "off";
process.env.SPARK_DAILY_BUDGET_SATS = "20000";
process.env.SPARK_SPEND_LEDGER_PATH = join(mkdtempSync(join(tmpdir(), "l402-regtest-")), "ledger.json");
const { SparkAgent } = await import("../../skills/sparkbtcbot/scripts/spark-agent.js");

const results = [];
const check = (name, ok, detail = {}) => {
  results.push({ name, ok });
  console.log(JSON.stringify({ check: name, ok, ...detail }));
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { wallet: payerWallet } = await createTestWallet({ mnemonic: getFundedMnemonic() });
const { wallet: shopWallet } = await createTestWallet();
const payer = new SparkAgent(payerWallet, "REGTEST");
const shop = new SparkAgent(shopWallet, "REGTEST");

// ---- the server ----
const issued = new Map(); // macaroon -> tracked invoice
const counts = {}; // per path: challenges, authorized requests
const bump = (path, k) => { counts[path] ??= { challenges: 0, authorized: 0 }; counts[path][k]++; };
const failFirst = { "/flaky": 3, "/order": 1 }; // authorized requests to fail before succeeding
const token = (expiresInSec) => Buffer.from(JSON.stringify({ identifier: randomUUID(), caveats: [{ type: "expiry", value: Math.floor(Date.now() / 1000) + expiresInSec }] })).toString("base64");
let staleInvoice = null;

const challenge = async (req, res, path) => {
  bump(path, "challenges");
  let order;
  let mac;
  if (path === "/stale") {
    order = staleInvoice; // created with a 5 s expiry, served after it expired
    mac = token(600);
  } else {
    order = await shop.createTrackedInvoice(PRICE, `l402 ${path}`, { expirySeconds: 600 });
    mac = token(path === "/short" ? 60 : 600);
  }
  issued.set(mac, order);
  res.writeHead(402, { "WWW-Authenticate": `L402 macaroon="${mac}", invoice="${order.invoice}"`, "content-type": "application/json" });
  res.end(JSON.stringify({ error: "payment required" }));
};
const verify = (req) => {
  const m = /^L402 ([^:]+):([0-9a-f]{64})$/.exec(req.headers.authorization ?? "");
  const order = m && issued.get(m[1]);
  return Boolean(order) && createHash("sha256").update(Buffer.from(m[2], "hex")).digest("hex") === order.paymentHash;
};
const server = https.createServer({ key: readFileSync(join(CERT_DIR, "key.pem")), cert: readFileSync(join(CERT_DIR, "cert.pem")) }, async (req, res) => {
  const path = new URL(req.url, "https://localhost").pathname;
  let body = "";
  for await (const c of req) body += c;
  if (!req.headers.authorization) return challenge(req, res, path);
  if (!verify(req)) { res.writeHead(401); return res.end("bad pass"); }
  bump(path, "authorized");
  if (path === "/refuse") { res.writeHead(401); return res.end("refused"); }
  if ((failFirst[path] ?? 0) > 0) {
    failFirst[path]--;
    if (path === "/flaky") return req.socket.destroy(); // transport failure
    res.writeHead(503); return res.end("busy");
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, path, body: body || null }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `https://localhost:${server.address().port}`;
const fetchL402 = (path, opts = {}) => payer.fetchL402(base + path, { maxAmountSats: 200, ...opts }).then((v) => ({ v }), (e) => ({ e }));
const owned = async () => (await payerWallet.getBalance()).satsBalance.owned;

try {
  // S1: an ordinary purchase.
  let r = await fetchL402("/ok");
  check("ok: paid and delivered", r.v?.paid === true && r.v?.status === 200 && r.v?.data?.ok === true, { status: r.v?.status, err: r.e?.message });

  // S2: delivery fails in transit three times, then the next call presents the held pass.
  r = await fetchL402("/flaky");
  check("flaky: first call is PAYMENT_COMMITTED settled:true", r.e?.code === "PAYMENT_COMMITTED" && r.e?.settled === true, { msg: r.e?.message?.slice(0, 120) });
  r = await fetchL402("/flaky");
  check("flaky: second call delivers the held pass, no new purchase", r.v?.recovered === true && r.v?.paid === false && counts["/flaky"].challenges === 1, { counts: counts["/flaky"] });

  // S3: the service refuses the paid pass.
  r = await fetchL402("/refuse");
  const refusedHash = r.e?.invoiceHash;
  check("refuse: PAYMENT_COMMITTED reason L402_PASS_REFUSED with the invoice hash", r.e?.code === "PAYMENT_COMMITTED" && r.e?.reason === "L402_PASS_REFUSED" && /^[0-9a-f]{64}$/.test(refusedHash ?? "") && r.e?.amountSats === PRICE, { status: r.e?.status });
  const before = { ...counts["/refuse"] };
  r = await fetchL402("/refuse");
  check("refuse: a retry throws again with no request and no payment", r.e?.reason === "L402_PASS_REFUSED" && counts["/refuse"].challenges === before.challenges && counts["/refuse"].authorized === before.authorized, { counts: counts["/refuse"] });
  check("refuse: forgetL402 lifts it", payer.forgetL402(base + "/refuse") === true);
  r = await fetchL402("/refuse");
  check("refuse: after forgetL402 it buys again (a second purchase)", r.e?.reason === "L402_PASS_REFUSED" && counts["/refuse"].challenges === 2, { counts: counts["/refuse"] });

  // S4: a POST whose delivery got a 503 is sent again only with resend and the same body.
  const post = { method: "POST", body: { order: 7 } };
  r = await fetchL402("/order", post);
  check("order: first POST is PAYMENT_COMMITTED with a resend hint", r.e?.code === "PAYMENT_COMMITTED" && /resend: true/.test(r.e?.message ?? ""), { msg: r.e?.message?.slice(0, 120) });
  r = await fetchL402("/order", post);
  check("order: without resend it isn't sent again", r.e?.code === "PAYMENT_COMMITTED" && counts["/order"].authorized === 1, { counts: counts["/order"] });
  r = await fetchL402("/order", { method: "POST", body: { order: 8 }, resend: true });
  check("order: resend with a different body is refused", /body differs/.test(r.e?.message ?? "") && counts["/order"].authorized === 1);
  r = await fetchL402("/order", { ...post, resend: true });
  check("order: resend with the same body delivers, one payment", r.v?.recovered === true && r.v?.data?.body === JSON.stringify({ order: 7 }) && counts["/order"].authorized === 2 && counts["/order"].challenges === 1, { counts: counts["/order"] });

  // S5: a token that dies within the 120 s floor is refused before paying.
  const ownedBefore5 = await owned();
  r = await fetchL402("/short");
  check("short: L402_TOKEN_EXPIRED before paying", r.e?.code === "L402_TOKEN_EXPIRED" && (await owned()) === ownedBefore5, { err: r.e?.message?.slice(0, 100) });

  // S6: an invoice that expired before it was served is refused before paying, nothing locked.
  staleInvoice = await shop.createTrackedInvoice(PRICE, "stale", { expirySeconds: 5 });
  await sleep(7_000);
  const ownedBefore6 = await owned();
  r = await fetchL402("/stale");
  await sleep(2_000);
  check("stale: INVOICE_EXPIRED before paying, nothing locked or spent", r.e?.code === "INVOICE_EXPIRED" && (await owned()) === ownedBefore6, { err: r.e?.message?.slice(0, 120) });

  // S7: the budget counted each purchase once (ok, flaky, refuse x2, order = 5).
  const spend = await payer.spendStatus();
  check("budget: five purchases counted once each", spend.spentSats === 5 * PRICE, { spentSats: spend.spentSats });

  // S8: every invoice the service issued and was paid for reads paid at the shop.
  let paidCount = 0;
  for (const order of new Set(issued.values())) {
    const s = await shop.getInvoiceStatus(order.id);
    if (s?.paid) paidCount++;
  }
  check("shop: exactly the five paid invoices read paid", paidCount === 5, { paidCount, issued: new Set(issued.values()).size });
} finally {
  server.close();
  const back = await returnSats(shopWallet, await payerWallet.getSparkAddress());
  console.log(JSON.stringify({ returnedSats: String(back) }));
  await cleanupAllWallets();
  const failed = results.filter((x) => !x.ok).map((x) => x.name);
  console.log(JSON.stringify({ summary: `${results.length - failed.length}/${results.length} passed`, failed }));
  process.exit(failed.length ? 1 : 0);
}
