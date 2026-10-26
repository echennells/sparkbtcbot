// fetchL402/previewL402 were documented on the agent for two releases but only
// existed in the reference doc — a deployed bot got `TypeError: not a function`.
// Now they ship on SparkAgent; these tests pin the 402 flow with a stubbed fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

// Amount-ful sample (2,000 sats embedded) from light-bolt11-decoder's README.
const invoice2000 = async () => {
  const md = await readFile("node_modules/light-bolt11-decoder/README.md", "utf8");
  return md.match(/lnbc20u[a-z0-9]+/)[0];
};

const resp = (status, jsonBody) => ({
  status,
  headers: { get: () => "application/json" },
  json: async () => jsonBody,
  text: async () => JSON.stringify(jsonBody),
});

// V2 macaroons with aperture's per-service expiry caveat, encoded by js-macaroon
// (provenance in l402-token.test.js): expired in 2023, valid until 2100.
const TOKEN_EXPIRED = "AgEIYXBlcnR1cmUCDWlkLXYyLWV4cGlyZWQAAhJzZXJ2aWNlcz13ZWF0aGVyOjAAAh53ZWF0aGVyX3ZhbGlkX3VudGlsPTE3MDAwMDAwMDAAAAYg1C0YAL7aAzFs94agoy/RsvDw+ZwSnrbENgnm1qtU7/I=";
const TOKEN_VALID = "AgEIYXBlcnR1cmUCC2lkLXYyLXZhbGlkAAISc2VydmljZXM9d2VhdGhlcjowAAIdd2VhdGhlcl9jYXBhYmlsaXRpZXM9Zm9yZWNhc3QAAh53ZWF0aGVyX3ZhbGlkX3VudGlsPTQxMDI0NDQ4MDAAAAYgSOsuF9aj0Ne4umzqatlKrqj0g+NjvYPvGiJk1uuYfYQ=";
// A 2,000-sat invoice whose preimage is known (sha256(0x42 × 32) is its payment
// hash), signed with test key 1 — so a "the preimage arrived later" path can be
// exercised for real instead of with a preimage that hashes to nothing.
const KNOWN_INVOICE = "lnbc20u1p4tzwuqpp5gf0dfe9rdvcw5gdepcsuwykxf85zznpfkl40dqyf6ypecmj48pxqsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsdp5wdcxzuntvf6xxcn0wss8getnwsazq6mwdamkugrswfjkjmtpvajsxqrrssfgmzf4e3aygc36mfrkgfj23fs5l3v4a0ztu34u5uu0ws9eycv4psq4msf75685vluz7kg7n3pvvzme375yjx63zjt2nxs9vgspgspvcp45esgz";
const KNOWN_PREIMAGE = "42".repeat(32);

// lightningfaucet-style JSON token expiring `seconds` from now.
const tokenExpiringIn = (seconds) =>
  Buffer.from(JSON.stringify({ identifier: "x", caveats: [{ type: "expiry", value: Math.floor(Date.now() / 1000) + seconds }] })).toString("base64");

const origFlag = process.env.SPARK_LEAF_VAULT;
afterEach(() => {
  vi.unstubAllGlobals();
  if (origFlag === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = origFlag;
});

const mkAgent = () => {
  process.env.SPARK_LEAF_VAULT = "off";
  const calls = { pay: null };
  const wallet = {
    getSparkAddress: async () => "sp1from",
    getLightningSendFeeEstimate: async () => 5,
    payLightningInvoice: async (params) => { calls.pay = params; return { paymentPreimage: "abc123preimage" }; },
  };
  return { agent: new SparkAgent(wallet, "MAINNET"), calls };
};

describe("previewL402", () => {
  it("returns the price for a 402 challenge without paying", async () => {
    const inv = await invoice2000();
    vi.stubGlobal("fetch", async () => resp(402, { invoice: inv, macaroon: "mac1" }));
    const { agent, calls } = mkAgent();
    expect(await agent.previewL402("https://api.example/paid")).toMatchObject({
      requiresPayment: true, amountSats: 2000, macaroon: "mac1",
    });
    expect(calls.pay).toBeNull(); // preview never pays
  });

  it("reports when the server says the token dies (null for an opaque token)", async () => {
    const inv = await invoice2000();
    vi.stubGlobal("fetch", async () => resp(402, { invoice: inv, macaroon: TOKEN_VALID }));
    expect(await mkAgent().agent.previewL402("https://api.example/paid"))
      .toMatchObject({ tokenExpiresAt: "2100-01-01T00:00:00.000Z" });
    vi.stubGlobal("fetch", async () => resp(402, { invoice: inv, macaroon: "mac1" }));
    expect(await mkAgent().agent.previewL402("https://api.example/paid")).toMatchObject({ tokenExpiresAt: null });
  });

  it("reports no payment required for a non-402 response", async () => {
    vi.stubGlobal("fetch", async () => resp(200, { hello: "free" }));
    const { agent } = mkAgent();
    expect(await agent.previewL402("https://api.example/free")).toEqual({ requiresPayment: false });
  });
});

describe("fetchL402", () => {
  it("pays the challenge and retries with the L402 authorization header", async () => {
    const inv = await invoice2000();
    const fetches = [];
    vi.stubGlobal("fetch", async (url, opts) => {
      fetches.push(opts);
      return fetches.length === 1
        ? resp(402, { invoice: inv, macaroon: "mac1" })
        : resp(200, { premium: true });
    });
    const { agent } = mkAgent();
    // payAndSettle now VERIFIES sha256(preimage) against the invoice's payment
    // hash, and no fixture can forge a matching preimage for a real invoice —
    // that impossibility is the security property. Stub settlement here (this
    // test pins the 402 header/retry mechanics); the verification itself is
    // pinned in spark-agent-lightning.test.js.
    const paid = [];
    vi.spyOn(agent, "payAndSettle").mockImplementation(async (invoice) => {
      paid.push(invoice);
      return { settled: true, paymentPreimage: "abc123preimage", id: "pay-1" };
    });
    const r = await agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 });
    expect(r).toMatchObject({ paid: true, amountSats: 2000, preimage: "abc123preimage", data: { premium: true } });
    expect(paid).toEqual([inv]);
    expect(fetches[1].headers.Authorization).toBe("L402 mac1:abc123preimage");
  });

  it("blocks an over-limit invoice BEFORE paying (amount ceiling)", async () => {
    const inv = await invoice2000(); // 2,000 sats > 1,000 cap
    vi.stubGlobal("fetch", async () => resp(402, { invoice: inv, macaroon: "mac1" }));
    const { agent, calls } = mkAgent();
    await expect(agent.fetchL402("https://api.example/paid", { maxAmountSats: 1000 })).rejects.toThrow(/blocked/i);
    expect(calls.pay).toBeNull(); // never paid
  });

  it("pays over Lightning only, never Spark-direct", async () => {
    const inv = await invoice2000();
    vi.stubGlobal("fetch", async () => resp(402, { invoice: inv, macaroon: "mac1" }));
    const { agent, calls } = mkAgent();
    await agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 }).catch(() => {}); // the stub preimage doesn't hash to the invoice
    expect(calls.pay).toMatchObject({ invoice: inv, preferSpark: false });
  });
});

describe("fetchL402 token expiry", () => {
  const settled = (agent) =>
    vi.spyOn(agent, "payAndSettle").mockResolvedValue({ settled: true, paymentPreimage: "abc123preimage", id: "pay-1" });

  it("refuses a token the server already expired — before any payment", async () => {
    const inv = await invoice2000();
    vi.stubGlobal("fetch", async () => resp(402, { invoice: inv, macaroon: TOKEN_EXPIRED }));
    const { agent, calls } = mkAgent();
    const pay = settled(agent);
    await expect(agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 }))
      .rejects.toMatchObject({ code: "L402_TOKEN_EXPIRED", message: expect.stringMatching(/expired at 2023-11-14T22:13:20/) });
    expect(pay).not.toHaveBeenCalled();
    expect(calls.pay).toBeNull();
  });

  it("refuses a token that would die during the payment (< 60 s left)", async () => {
    const inv = await invoice2000();
    vi.stubGlobal("fetch", async () => resp(402, { invoice: inv, macaroon: tokenExpiringIn(30) }));
    const { agent } = mkAgent();
    const pay = settled(agent);
    await expect(agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 }))
      .rejects.toMatchObject({ code: "L402_TOKEN_EXPIRED", message: expect.stringMatching(/expires at/) });
    expect(pay).not.toHaveBeenCalled();
  });

  it("pays when the token has time left, and when the token is opaque", async () => {
    const inv = await invoice2000();
    for (const token of [TOKEN_VALID, tokenExpiringIn(300), "mac1"]) {
      let n = 0;
      vi.stubGlobal("fetch", async () => (++n === 1 ? resp(402, { invoice: inv, macaroon: token }) : resp(200, { ok: true })));
      const { agent } = mkAgent();
      settled(agent);
      expect(await agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 })).toMatchObject({ paid: true });
    }
  });
});

describe("fetchL402 after payment: in-process recovery", () => {
  const saved = {};
  let dir;
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    dir = await mkdtemp(join(tmpdir(), "agent-l402-recover-"));
    for (const k of ["SPARK_LN_DEDUP_PATH", "SPARK_LEAF_VAULT"]) saved[k] = process.env[k];
    process.env.SPARK_LN_DEDUP_PATH = join(dir, "ln-dedup");
    process.env.SPARK_LEAF_VAULT = "off";
  });
  afterEach(async () => {
    vi.useRealTimers();
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  });

  const URL_ = "https://api.example/paid";
  // Queue of fetch outcomes: a response, or an Error to throw (transport failure).
  const stubFetch = (queue) => {
    const seen = [];
    vi.stubGlobal("fetch", async (url, opts) => {
      seen.push(opts);
      const next = queue.shift();
      if (next === undefined) throw new Error("unexpected extra fetch");
      if (next instanceof Error) throw next;
      return next;
    });
    return seen;
  };
  const run = async (promise) => {
    const settled = promise.then((value) => ({ value }), (error) => ({ error }));
    await vi.runAllTimersAsync();
    return settled;
  };
  const mk = () => {
    const wallet = { getSparkAddress: async () => "sp1from", getLightningSendRequest: async () => null };
    const agent = new SparkAgent(wallet, "MAINNET");
    const pay = vi.spyOn(agent, "payAndSettle").mockResolvedValue({ settled: true, paymentPreimage: "abc123preimage", id: "pay-1" });
    return { agent, wallet, pay };
  };
  const auth = (opts) => opts.headers.Authorization;

  it("a delivery that fails in transit is retried with the same pass — paid once", async () => {
    const inv = await invoice2000();
    const seen = stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), new TypeError("fetch failed"), resp(200, { ok: true })]);
    const { agent, pay } = mk();
    const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(value).toMatchObject({ paid: true, status: 200, data: { ok: true } });
    expect(pay).toHaveBeenCalledTimes(1);
    expect(seen.slice(1).map(auth)).toEqual(["L402 mac1:abc123preimage", "L402 mac1:abc123preimage"]);
  });

  it("a 5xx on delivery is retried with the same pass", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), resp(503, { busy: true }), resp(200, { ok: true })]);
    const { agent, pay } = mk();
    const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(value).toMatchObject({ paid: true, status: 200, data: { ok: true } });
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it("when every attempt fails, the pass is held: the next call presents it without paying", async () => {
    const inv = await invoice2000();
    const down = () => new TypeError("fetch failed");
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), down(), down(), down()]);
    const { agent, pay } = mk();
    const { error } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: true, op: "l402" });
    expect(error.message).toMatch(/call fetchL402 with the same URL again/);
    expect(inspect(error)).not.toContain("abc123preimage"); // the pass never rides on the error

    const seen = stubFetch([resp(200, { ok: true })]);
    const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(value).toMatchObject({ paid: false, recovered: true, status: 200, data: { ok: true } });
    expect(seen.map(auth)).toEqual(["L402 mac1:abc123preimage"]); // no new challenge, no new payment
    expect(pay).toHaveBeenCalledTimes(1);

    // delivered, so released: the next call is a fresh purchase
    const again = stubFetch([resp(402, { invoice: inv, macaroon: "mac2" }), resp(200, { ok: true })]);
    await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(again[0].headers.Authorization).toBeUndefined();
    expect(pay).toHaveBeenCalledTimes(2);
  });

  it("a malformed JSON body after payment is returned as text, never thrown", async () => {
    const inv = await invoice2000();
    const broken = { status: 200, headers: { get: () => "application/json" }, text: async () => "{not json", json: async () => { throw new SyntaxError("bad"); } };
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), broken]);
    const { agent, pay } = mk();
    const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(value).toMatchObject({ paid: true, data: "{not json" });
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it("a payment still pending: the next call checks it instead of paying again", async () => {
    stubFetch([resp(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" })]);
    const { agent, wallet, pay } = mk();
    pay.mockResolvedValue({ settled: false, paymentPreimage: null, id: "send-1", lastStatus: "LIGHTNING_PAYMENT_INITIATED" });
    const first = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(first.error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: null, sendId: "send-1", paid: true });

    wallet.getLightningSendRequest = async () => ({ status: "LIGHTNING_PAYMENT_INITIATED" });
    stubFetch([]); // any request here would be a bug
    const second = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(second.error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: null });
    expect(second.error.message).toMatch(/still pending.*nothing new was paid/);

    wallet.getLightningSendRequest = async (id) => (id === "send-1" ? { status: "TRANSFER_COMPLETED", paymentPreimage: KNOWN_PREIMAGE } : null);
    const seen = stubFetch([resp(200, { ok: true })]);
    const third = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(third.value).toMatchObject({ paid: false, recovered: true, data: { ok: true } });
    expect(seen.map(auth)).toEqual([`L402 mac1:${KNOWN_PREIMAGE}`]);
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it("a pending payment that failed for good: the next call buys afresh (nothing had left)", async () => {
    stubFetch([resp(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" })]);
    const { agent, wallet, pay } = mk();
    pay.mockResolvedValueOnce({ settled: false, paymentPreimage: null, id: "send-1", lastStatus: "LIGHTNING_PAYMENT_INITIATED" });
    await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));

    wallet.getLightningSendRequest = async () => ({ status: "LIGHTNING_PAYMENT_FAILED" });
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac2" }), resp(200, { ok: true })]);
    const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(value).toMatchObject({ paid: true, data: { ok: true } });
    expect(pay).toHaveBeenCalledTimes(2);
  });

  it("a held pass is only for the exact request: another URL or method pays normally", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), ...Array.from({ length: 3 }, () => new TypeError("fetch failed"))]);
    const { agent, pay } = mk();
    await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    const seen = stubFetch([resp(402, { invoice: inv, macaroon: "mac2" }), resp(200, { ok: true })]);
    await run(agent.fetchL402(URL_, { method: "POST", body: { q: 1 }, maxAmountSats: 3000 }));
    expect(seen[0].headers.Authorization).toBeUndefined();
    expect(pay).toHaveBeenCalledTimes(2);
  });
});
