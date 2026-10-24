import http from "node:http";
import { fetchL402Cached, tokenCache } from "./l402-cache-snippet.mjs";

const seen = [];
let valid = "L402 mac1:pre1";
const server = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    seen.push({ auth: req.headers.authorization ?? null, body });
    if (req.headers.authorization === valid) { res.setHeader("content-type", "application/json"); return res.end(JSON.stringify({ ok: true })); }
    res.statusCode = 402; res.end();
  });
});
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/data`;

let pays = 0;
const agent = { async fetchL402(u, opts) { pays++; return { paid: true, macaroon: `mac${pays}`, preimage: `pre${pays}`, data: { ok: true }, opts }; } };

const r1 = await fetchL402Cached(agent, url, { method: "POST", body: { q: 1 } }); const pays1 = pays;
const r2 = await fetchL402Cached(agent, url, { method: "POST", body: { q: 2 }, headers: { Authorization: "clobber" } }); const pays2 = pays;
valid = "L402 mac2:pre2";                                   // server expires the old token
const r3 = await fetchL402Cached(agent, url, { method: "POST", body: { q: 3 } });
server.close();

const check = (label, ok) => console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
check("first call pays through agent.fetchL402", r1.paid === true && pays1 === 1);
check("token cached as the full Authorization value", tokenCache.size === 1);
check("second call served from cache, no payment", r2.cached === true && r2.data.ok === true && pays2 === 1);
check("cached attempt forwards the request body", seen[0].body === JSON.stringify({ q: 2 }));
check("caller header cannot clobber the credential", seen[0].auth === "L402 mac1:pre1");
check("expired token: dropped, re-paid via the wrapper", r3.paid === true && pays === 2);
check("new token replaces the old", [...tokenCache.values()][0] === "L402 mac2:pre2");
