// Zero-spend survey: one unpaid request per MPP service; record the payment
// methods its 402 challenge actually offers. Nothing is ever paid.
import { readFileSync, writeFileSync } from "node:fs";
const raw = JSON.parse(readFileSync(new URL("./api-services.json", import.meta.url), "utf8"));
const services = Array.isArray(raw) ? raw : raw.services;
const pick = (s) => {
  const eps = s.endpoints || [];
  const priced = eps.find((e) => e.payment?.amount || e.amount || e.price) || eps[0];
  if (!priced) return null;
  const [m, ...rest] = String(priced.route || `${priced.method || "GET"} ${priced.path || ""}`).split(" ");
  const path = rest.join(" ") || priced.path || "";
  return { method: (m || "GET").toUpperCase(), url: new URL(path.replace(/^\//, ""), s.url.endsWith("/") ? s.url : s.url + "/").toString() };
};
const methodsOf = (hdrs) => {
  const out = new Set();
  for (const h of hdrs) for (const m of h.matchAll(/method="([^"]+)"/g)) out.add(m[1]);
  if (hdrs.some((h) => /\bL402\b|\bLSAT\b/.test(h))) out.add("L402");
  return [...out].sort();
};
const results = [];
const queue = services.map((s) => ({ s, t: pick(s) }));
async function worker() {
  for (let item = queue.shift(); item; item = queue.shift()) {
    const { s, t } = item;
    if (!t) { results.push({ name: s.name, status: "no-endpoint" }); continue; }
    try {
      const res = await fetch(t.url, {
        method: t.method,
        headers: { "content-type": "application/json", accept: "application/json" },
        body: ["GET", "HEAD"].includes(t.method) ? undefined : "{}",
        signal: AbortSignal.timeout(12_000),
        redirect: "manual",
      });
      const hdrs = [];
      res.headers.forEach((v, k) => { if (k === "www-authenticate") hdrs.push(v); });
      await res.body?.cancel().catch(() => {});
      results.push({ name: s.name, status: res.status, methods: methodsOf(hdrs), declared: Object.keys(s.methods || {}).sort() });
    } catch (e) {
      results.push({ name: s.name, status: "error", error: String(e.cause?.code || e.name || e.message).slice(0, 40) });
    }
  }
}
await Promise.all(Array.from({ length: 8 }, worker));
writeFileSync(new URL("./probe-results.json", import.meta.url), JSON.stringify(results, null, 1));
const got402 = results.filter((r) => r.status === 402);
const tally = {};
for (const r of got402) for (const m of r.methods.length ? r.methods : ["(402, no Payment challenge)"]) tally[m] = (tally[m] || 0) + 1;
const statusTally = {};
for (const r of results) statusTally[r.status] = (statusTally[r.status] || 0) + 1;
console.log("services probed:", results.length);
console.log("response status:", statusTally);
console.log("payment methods offered in live 402s (count of services):", tally);
console.log("any Lightning or L402 offered:", results.filter((r) => r.methods?.some((m) => /lightning|L402/i.test(m))).map((r) => r.name));
const undeclared = got402.filter((r) => r.methods.some((m) => !r.declared.includes(m)));
console.log("live methods not in the registry declaration:", undeclared.map((r) => `${r.name}: ${r.methods.join("+")}`).slice(0, 10));
