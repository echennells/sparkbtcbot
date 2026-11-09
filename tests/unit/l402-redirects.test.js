// fetchL402's redirect rules against real Node fetch and two loopback servers
// (two ports are two origins). The stub tests in spark-agent-l402.test.js
// cover each rule; these check what actually goes over the wire, on every Node
// version CI runs: the pass and the caller's headers stay on the service's
// origin, and a body never follows a redirect to another host.
import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import http from "node:http";
import { readFile } from "node:fs/promises";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { freshInvoice } from "../helpers/bolt11.js";

const listen = (handler) => new Promise((resolve) => {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => handler(req, res, body));
  }).listen(0, "127.0.0.1", () => resolve(server));
});
const origin = (server) => `http://127.0.0.1:${server.address().port}`;

describe("fetchL402 redirects over real fetch (loopback)", () => {
  const seen = [];
  let invoice;
  let cdn;
  let service;
  let mode;
  const savedVault = process.env.SPARK_LEAF_VAULT;

  beforeAll(async () => {
    process.env.SPARK_LEAF_VAULT = "off";
    invoice = freshInvoice((await readFile("node_modules/light-bolt11-decoder/README.md", "utf8")).match(/lnbc20u[a-z0-9]+/)[0]);
    cdn = await listen((req, res, body) => {
      seen.push({ at: "cdn", method: req.method, path: req.url, auth: req.headers.authorization ?? null, apiKey: req.headers["x-api-key"] ?? null, body: body || null });
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"from":"cdn"}');
    });
    service = await listen((req, res, body) => {
      seen.push({ at: "service", method: req.method, path: req.url, auth: req.headers.authorization ?? null, apiKey: req.headers["x-api-key"] ?? null, body: body || null });
      if (mode === "challenge-redirect") { res.writeHead(307, { location: "/v2/paid" }); return res.end(); }
      if (!req.headers.authorization) { res.writeHead(402, { "content-type": "application/json" }); return res.end(JSON.stringify({ invoice, macaroon: "mac1" })); }
      if (mode === "same-origin" && req.url === "/paid") { res.writeHead(302, { location: "/paid/" }); return res.end(); }
      if (mode === "to-cdn") { res.writeHead(302, { location: `${origin(cdn)}/signed?sig=1` }); return res.end(); }
      if (mode === "post-307-to-cdn") { res.writeHead(307, { location: `${origin(cdn)}/landing` }); return res.end(); }
      res.writeHead(200, { "content-type": "application/json" });
      res.end('{"from":"service"}');
    });
  });
  afterEach(() => { seen.length = 0; });
  afterAll(() => {
    cdn.close();
    service.close();
    if (savedVault === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = savedVault;
  });

  const mkAgent = () => {
    const agent = new SparkAgent({ getSparkAddress: async () => "sp1x", getLightningSendRequest: async () => null }, "MAINNET");
    const pays = [];
    agent.payAndSettle = async (inv) => { pays.push(inv); return { settled: true, paymentPreimage: "abc123", id: "send-1" }; };
    return { agent, pays };
  };
  const url = () => `${origin(service)}/paid`;

  it("before paying, a redirect is not followed and nothing is paid", async () => {
    mode = "challenge-redirect";
    const { agent, pays } = mkAgent();
    await expect(agent.fetchL402(url(), { maxAmountSats: 3000 })).rejects.toMatchObject({ code: "SERVICE_REDIRECTED", status: 307, location: `${origin(service)}/v2/paid` });
    expect(pays).toEqual([]);
    expect(seen.map((s) => s.path)).toEqual(["/paid"]);
  });

  it("after paying, a same-origin redirect carries the pass", async () => {
    mode = "same-origin";
    const { agent, pays } = mkAgent();
    const r = await agent.fetchL402(url(), { maxAmountSats: 3000 });
    expect(r).toMatchObject({ paid: true, data: { from: "service" } });
    expect(seen.filter((s) => s.auth).map((s) => s.path)).toEqual(["/paid", "/paid/"]);
    expect(pays).toHaveLength(1);
  });

  it("a redirect to another host gets neither the pass nor the caller's headers", async () => {
    mode = "to-cdn";
    const { agent } = mkAgent();
    const r = await agent.fetchL402(url(), { headers: { "X-Api-Key": "secret-key" }, maxAmountSats: 3000 });
    expect(r).toMatchObject({ paid: true, data: { from: "cdn" } });
    const hop = seen.find((s) => s.at === "cdn");
    expect(hop).toMatchObject({ method: "GET", path: "/signed?sig=1", auth: null, apiKey: null, body: null });
    expect(seen.filter((s) => s.at === "service" && s.auth)).toHaveLength(1);
  });

  it("a paid POST redirected (307) to another host is not re-sent there, and the pass is held", async () => {
    mode = "post-307-to-cdn";
    const { agent, pays } = mkAgent();
    await expect(agent.fetchL402(url(), { method: "POST", body: { order: 7 }, maxAmountSats: 3000 }))
      .rejects.toMatchObject({ code: "PAYMENT_COMMITTED", settled: true, status: 307, location: `${origin(cdn)}/landing` });
    expect(seen.filter((s) => s.at === "cdn")).toEqual([]);
    expect(pays).toHaveLength(1);
  });
});
