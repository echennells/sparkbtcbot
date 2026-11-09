// fetchL402/previewL402 were documented on the agent for two releases but only
// existed in the reference doc — a deployed bot got `TypeError: not a function`.
// Now they ship on SparkAgent; these tests pin the 402 flow with a stubbed fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFile, readdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { freshInvoice } from "../helpers/bolt11.js";
import { createL402HoldStore } from "../../lib/l402-holds.js";

// Amount-ful sample (2,000 sats embedded) from light-bolt11-decoder's README.
const invoice2000 = async () => {
  const md = await readFile("node_modules/light-bolt11-decoder/README.md", "utf8");
  return freshInvoice(md.match(/lnbc20u[a-z0-9]+/)[0]);
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
const KNOWN_INVOICE = freshInvoice("lnbc20u1p4tzwuqpp5gf0dfe9rdvcw5gdepcsuwykxf85zznpfkl40dqyf6ypecmj48pxqsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsdp5wdcxzuntvf6xxcn0wss8getnwsazq6mwdamkugrswfjkjmtpvajsxqrrssfgmzf4e3aygc36mfrkgfj23fs5l3v4a0ztu34u5uu0ws9eycv4psq4msf75685vluz7kg7n3pvvzme375yjx63zjt2nxs9vgspgspvcp45esgz");
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

  it("accepts plain http only for localhost, including IPv6 written as the URL parser writes it ([::1])", async () => {
    vi.stubGlobal("fetch", async () => resp(200, { hello: "free" }));
    const { agent } = mkAgent();
    expect(await agent.previewL402("http://[::1]:8080/paid")).toEqual({ requiresPayment: false });
    await expect(agent.previewL402("http://api.example/paid")).rejects.toMatchObject({ code: "BAD_INPUT", field: "url" });
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
  // Holds are written to disk (real I/O) between the fake timers, so run them
  // until the call settles, yielding to the real event loop between rounds.
  const run = async (promise) => {
    let done = false;
    const settled = promise.then((value) => ({ value }), (error) => ({ error })).finally(() => { done = true; });
    while (!done) {
      await vi.runAllTimersAsync();
      if (!done) await stat(tmpdir());
    }
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

  // Review 2026-10-28 F01: nothing marked a URL as being bought until the
  // payment returned, so a second call during the payment (a duplicated tool
  // call, a host timeout retried while the first still ran) fetched its own
  // challenge — a different invoice — and paid it too.
  it("two overlapping calls for one URL buy once: the second joins the first", async () => {
    const inv = await invoice2000();
    const seen = stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), resp(200, { ok: true })]);
    const { agent, pay } = mk();
    pay.mockImplementation(() => new Promise((r) => setTimeout(() => r({ settled: true, paymentPreimage: "abc123preimage", id: "pay-1" }), 5_000)));
    const first = agent.fetchL402(URL_, { maxAmountSats: 3000 });
    const second = agent.fetchL402(URL_, { maxAmountSats: 3000 }); // starts while the first is paying
    const [a, b] = await Promise.all([run(first), run(second)]);
    expect(a.value).toMatchObject({ paid: true, status: 200, data: { ok: true } });
    expect(b.value).toMatchObject({ paid: false, joined: true, status: 200, data: { ok: true } });
    expect(pay).toHaveBeenCalledTimes(1);
    expect(seen).toHaveLength(2); // one challenge, one delivery: the second call fetched nothing
  });

  it("an overlapping call with a different body is refused before anything is fetched or paid", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), resp(200, { ok: true })]);
    const { agent, pay } = mk();
    pay.mockImplementation(() => new Promise((r) => setTimeout(() => r({ settled: true, paymentPreimage: "abc123preimage", id: "pay-1" }), 5_000)));
    const first = agent.fetchL402(URL_, { method: "POST", body: { order: 1 }, maxAmountSats: 3000 });
    const { error } = await run(agent.fetchL402(URL_, { method: "POST", body: { order: 2 }, maxAmountSats: 3000 }));
    expect(error).toMatchObject({ code: "CONCURRENT_PAYMENT_ATTEMPT", retryable: "check-first" });
    expect(error.message).toMatch(/Nothing was paid by this call/);
    expect((await run(first)).value).toMatchObject({ paid: true, data: { ok: true } });
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it("an overlapping call shares the first call's error, and the URL is free again afterwards", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" })]);
    const { agent, pay } = mk();
    pay.mockImplementation(() => new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error("over budget"), { code: "SPEND_BUDGET_EXCEEDED" })), 5_000)));
    const first = agent.fetchL402(URL_, { maxAmountSats: 3000 });
    const second = agent.fetchL402(URL_, { maxAmountSats: 3000 });
    const [a, b] = await Promise.all([run(first), run(second)]);
    expect(a.error).toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
    expect(b.error).toBe(a.error);
    expect(pay).toHaveBeenCalledTimes(1);
    // Nothing still marks the URL as in progress: a later call is a fresh attempt.
    pay.mockResolvedValue({ settled: true, paymentPreimage: "abc123preimage", id: "pay-2" });
    stubFetch([resp(402, { invoice: inv, macaroon: "mac2" }), resp(200, { ok: true })]);
    expect((await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }))).value).toMatchObject({ paid: true });
    expect(pay).toHaveBeenCalledTimes(2);
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
    // What a restarted process finds the payment by (ToB review 2026-10-28).
    expect(error).toMatchObject({ sendId: "pay-1", invoiceHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(error.message).toMatch(/Call fetchL402 with the same URL again/);
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

  // Verified 2026-10-28: the service accepted the paid pass, then the body
  // stream broke (a reset mid-body, a proxy cutting the response). The raw
  // `TypeError: terminated` escaped with nothing held, and every retry bought
  // a new pass: 3 retries, 3 payments.
  const cutBody = () => new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"partial":'));
        c.error(new TypeError("terminated"));
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );

  it("a body cut off after paying is a failed delivery: retried with the same pass, paid once", async () => {
    const inv = await invoice2000();
    const seen = stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), cutBody(), resp(200, { ok: true })]);
    const { agent, pay } = mk();
    const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(value).toMatchObject({ paid: true, status: 200, data: { ok: true } });
    expect(pay).toHaveBeenCalledTimes(1);
    expect(seen.slice(1).map(auth)).toEqual(["L402 mac1:abc123preimage", "L402 mac1:abc123preimage"]);
  });

  it("a body cut off on every attempt: PAYMENT_COMMITTED settled:true, and retries present the pass, never buy again", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), cutBody(), cutBody(), cutBody()]);
    const { agent, pay } = mk();
    const { error } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(error).toMatchObject({ code: "PAYMENT_COMMITTED", retryable: "check-first", settled: true, op: "l402" });
    expect(error.message).toMatch(/after 3 attempts \(HTTP 200, body cut off \(terminated\)\)/);

    for (let i = 0; i < 3; i++) { // a retry loop on a deterministic cut: no new challenge, no new payment
      const seen = stubFetch([cutBody(), cutBody(), cutBody()]);
      const again = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
      expect(again.error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: true });
      expect(seen.map(auth)).toEqual(Array(3).fill("L402 mac1:abc123preimage"));
    }
    const seen = stubFetch([resp(200, { ok: true })]);
    const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(value).toMatchObject({ paid: false, recovered: true, data: { ok: true } });
    expect(seen.map(auth)).toEqual(["L402 mac1:abc123preimage"]);
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it("a POST whose body is cut off after paying is held as sent once (resend hint), not bought again", async () => {
    const inv = await invoice2000();
    const seen = stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), cutBody()]);
    const { agent, pay } = mk();
    const post = { method: "POST", body: { order: 7 }, maxAmountSats: 3000 };
    const { error } = await run(agent.fetchL402(URL_, post));
    expect(error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: true });
    expect(error.message).toMatch(/after 1 attempt \(HTTP 200, body cut off/);
    expect(error.message).toMatch(/resend: true/);
    expect(seen).toHaveLength(2); // the challenge and ONE paid attempt
    stubFetch([]);
    const again = await run(agent.fetchL402(URL_, post));
    expect(again.error.message).toMatch(/already sent once/);
    expect(pay).toHaveBeenCalledTimes(1);
  });

  // Defence in depth: the paid pass is held before the first delivery
  // attempt, so even a throw nobody planned for leaves it to present.
  it("an unexpected throw during the first delivery leaves the paid pass held", async () => {
    const inv = await invoice2000();
    const weird = { get status() { throw new TypeError("unexpected"); }, headers: { get: () => "" } };
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), weird, weird, weird]);
    const { agent, pay } = mk();
    const { error } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    // Read inside the redirect handling, the throw is a failed attempt: retried
    // with the same pass, then a coded error with the pass held.
    expect(error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: true });
    expect(error.message).toMatch(/after 3 attempts \(unexpected\)/);
    const seen = stubFetch([resp(200, { ok: true })]);
    const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(value).toMatchObject({ paid: false, recovered: true, data: { ok: true } });
    expect(seen.map(auth)).toEqual(["L402 mac1:abc123preimage"]);
    expect(pay).toHaveBeenCalledTimes(1);
  });

  // payAndSettle's PREIMAGE_MISMATCH used to escape fetchL402 with nothing
  // held, so a retry bought again. Now it blocks the URL like #resumeL402
  // does for the same evidence (L402_NO_PROOF), until forgetL402.
  it("a preimage that doesn't prove the invoice blocks the URL (L402_NO_PROOF) until forgetL402", async () => {
    stubFetch([resp(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" })]);
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: vi.fn(async () => ({ id: "send-1", paymentPreimage: "aa".repeat(32) })),
      getLightningSendRequest: async () => null,
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    const { error } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(error).toMatchObject({
      code: "PAYMENT_COMMITTED", retryable: "check-first", reason: "L402_NO_PROOF", settled: null, sendId: "send-1",
      invoiceHash: expect.stringMatching(/^[0-9a-f]{64}$/), amountSats: 2000,
    });
    expect(error.nextStep).toMatch(/getLightningSendRequest\(err\.sendId\)/);
    expect(error.nextStep).not.toMatch(/Nothing new was paid/); // this call did try to pay

    stubFetch([]); // a retry loop: no request, no payment
    for (let i = 0; i < 2; i++) {
      const again = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
      expect(again.error).toMatchObject({ code: "PAYMENT_COMMITTED", reason: "L402_NO_PROOF" });
      expect(again.error.nextStep).toMatch(/Nothing new was paid/);
    }
    expect(wallet.payLightningInvoice).toHaveBeenCalledTimes(1);
    expect(agent.forgetL402(URL_)).toBe(true); // the user's decision
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
    expect(second.error.message).toMatch(/still pending.*Nothing new was paid/);

    wallet.getLightningSendRequest = async (id) => (id === "send-1" ? { status: "TRANSFER_COMPLETED", paymentPreimage: KNOWN_PREIMAGE } : null);
    const seen = stubFetch([resp(200, { ok: true })]);
    const third = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(third.value).toMatchObject({ paid: false, recovered: true, data: { ok: true } });
    expect(seen.map(auth)).toEqual([`L402 mac1:${KNOWN_PREIMAGE}`]);
    expect(pay).toHaveBeenCalledTimes(1);
  });

  // Changed 2026-10-28 (verified): every terminal-failure status used to buy
  // again at once, but only USER_SWAP_RETURNED says the sats are back; in the
  // others they can still be locked to the SSP. Those keep the hold.
  it.each(["LIGHTNING_PAYMENT_FAILED", "PENDING_USER_SWAP_RETURN", "USER_SWAP_RETURN_FAILED", "USER_TRANSFER_VALIDATION_FAILED"])(
    "a pending payment that ended in %s: held (sats may still be locked), bought afresh only once USER_SWAP_RETURNED",
    async (status) => {
      stubFetch([resp(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" })]);
      const { agent, wallet, pay } = mk();
      pay.mockResolvedValueOnce({ settled: false, paymentPreimage: null, id: "send-1", lastStatus: "LIGHTNING_PAYMENT_INITIATED" });
      await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));

      wallet.getLightningSendRequest = async () => ({ status });
      stubFetch([]); // any request here would be a bug
      for (let i = 0; i < 2; i++) {
        const { error } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
        expect(error).toMatchObject({ code: "LIGHTNING_PAYMENT_FAILED", retryable: "check-first", fundsReturned: false, status, sendId: "send-1" });
        expect(error.message).toMatch(/Nothing new was paid/);
        expect(error.nextStep).toMatch(/forgetL402\(url\).*only on the user's say-so/);
      }
      expect(pay).toHaveBeenCalledTimes(1);

      wallet.getLightningSendRequest = async () => ({ status: "USER_SWAP_RETURNED" });
      const inv = await invoice2000();
      stubFetch([resp(402, { invoice: inv, macaroon: "mac2" }), resp(200, { ok: true })]);
      const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
      expect(value).toMatchObject({ paid: true, data: { ok: true } });
      expect(pay).toHaveBeenCalledTimes(2);
    },
  );

  // Payments review 2026-10-28: a FIRST call whose payment failed with the
  // sats maybe still locked threw unheld, so the next call bought a fresh
  // invoice at once (a retry loop locked one price per call). Held now, on the
  // send's id, as #resumeL402 holds for the same statuses. Through the real
  // payAndSettle, so the error is the one it throws.
  it.each(["LIGHTNING_PAYMENT_FAILED", "PENDING_USER_SWAP_RETURN", "USER_SWAP_RETURN_FAILED", "USER_TRANSFER_VALIDATION_FAILED"])(
    "a first call whose payment failed in %s: held on the send's id, one payment across the calls until USER_SWAP_RETURNED",
    async (status) => {
      const inv = await invoice2000();
      const sendStatus = { status };
      const wallet = {
        getSparkAddress: async () => "sp1from",
        getLightningSendFeeEstimate: async () => 5,
        payLightningInvoice: vi.fn(async () => ({ id: "send-1", status: "LIGHTNING_PAYMENT_INITIATED" })),
        getLightningSendRequest: vi.fn(async () => sendStatus),
      };
      const agent = new SparkAgent(wallet, "MAINNET");
      stubFetch([resp(402, { invoice: inv, macaroon: "mac1" })]);
      // payAndSettle sets its poll timer only after real I/O (the SDK's lazy
      // import, the dedup store), so one runAllTimersAsync() can finish before
      // the timer exists: yield to I/O and advance until the call settles.
      let done = false;
      const pending = agent.fetchL402(URL_, { maxAmountSats: 3000 }).then((value) => ({ value }), (error) => ({ error }));
      pending.finally(() => { done = true; });
      for (const end = Date.now() + 20_000; !done && Date.now() < end;) {
        await new Promise((r) => setImmediate(r));
        await vi.advanceTimersByTimeAsync(2_000);
      }
      const first = await pending;
      expect(first.error).toMatchObject({
        code: "LIGHTNING_PAYMENT_FAILED", retryable: "check-first", fundsReturned: false, status, sendId: "send-1",
        cause: expect.objectContaining({ code: "LIGHTNING_PAYMENT_FAILED", status }),
      });
      expect(first.error.message).toMatch(/only once that send reads USER_SWAP_RETURNED/);
      expect(first.error.nextStep).toMatch(/forgetL402\(url\) only on the user's say-so.*The hold is saved on disk.*If the check itself fails/);

      wallet.getLightningSendRequest.mockClear();
      stubFetch([]); // no new challenge: any request here would be a bug
      for (let i = 0; i < 2; i++) {
        const { error } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
        expect(error).toMatchObject({ code: "LIGHTNING_PAYMENT_FAILED", retryable: "check-first", fundsReturned: false, status, sendId: "send-1" });
        expect(error.message).toMatch(/Nothing new was paid/);
      }
      expect(wallet.getLightningSendRequest.mock.calls.map((c) => c[0])).toEqual(["send-1", "send-1"]);
      expect(wallet.payLightningInvoice).toHaveBeenCalledTimes(1);

      // The SSP returned the sats: the next call buys afresh.
      sendStatus.status = "USER_SWAP_RETURNED";
      const pay = vi.spyOn(agent, "payAndSettle").mockResolvedValue({ settled: true, paymentPreimage: "abc123preimage", id: "pay-2" });
      stubFetch([resp(402, { invoice: inv, macaroon: "mac2" }), resp(200, { ok: true })]);
      const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
      expect(value).toMatchObject({ paid: true, data: { ok: true } });
      expect(pay).toHaveBeenCalledTimes(1);
    },
  );

  it("a first call whose payment failed with the sats back (USER_SWAP_RETURNED): nothing held, retryable 'yes'", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" })]);
    const { agent, pay } = mk();
    const returned = Object.assign(new Error("Lightning payment failed (USER_SWAP_RETURNED)"), {
      code: "LIGHTNING_PAYMENT_FAILED", retryable: "yes", status: "USER_SWAP_RETURNED", fundsReturned: true, sendId: "send-1",
    });
    pay.mockRejectedValueOnce(returned);
    const first = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(first.error).toBe(returned);
    expect(agent.forgetL402(URL_)).toBe(false); // nothing held

    stubFetch([resp(402, { invoice: inv, macaroon: "mac2" }), resp(200, { ok: true })]);
    const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(value).toMatchObject({ paid: true, data: { ok: true } });
    expect(pay).toHaveBeenCalledTimes(2);
  });

  // ToB review 2026-10-26: a pay call that failed ambiguously held nothing, so
  // the documented "call again" fetched a NEW challenge and bought twice.
  it("a pay call that may have paid is held: the next call settles THE SAME invoice, no new challenge", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" })]);
    const { agent, pay } = mk();
    const committed = Object.assign(new Error("outcome unknown"), { code: "PAYMENT_COMMITTED", settled: null });
    pay.mockRejectedValueOnce(committed);
    const first = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(first.error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: null, op: "l402", paid: true });
    expect(first.error.message).toMatch(/finishes THIS payment/);

    const seen = stubFetch([resp(200, { ok: true })]); // no 402 fetch: straight to delivery
    const second = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(second.value).toMatchObject({ paid: false, recovered: true, data: { ok: true } });
    expect(pay.mock.calls.map((c) => c[0])).toEqual([inv, inv]); // the same invoice, both times
    expect(pay.mock.calls[1][1]).toMatchObject({ maxAmountSats: 3000, preferSpark: false });
    expect(seen.map(auth)).toEqual(["L402 mac1:abc123preimage"]);
  });

  it("with the dedup store off, a held ambiguous payment is not paid again", async () => {
    process.env.SPARK_LN_DEDUP = "off";
    try {
      const inv = await invoice2000();
      stubFetch([resp(402, { invoice: inv, macaroon: "mac1" })]);
      const { agent, pay } = mk();
      pay.mockRejectedValueOnce(Object.assign(new Error("outcome unknown"), { code: "PAYMENT_COMMITTED" }));
      await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
      stubFetch([]);
      const again = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
      expect(again.error).toMatchObject({ code: "PAYMENT_COMMITTED" });
      expect(again.error.message).toMatch(/SPARK_LN_DEDUP is off/);
      expect(pay).toHaveBeenCalledTimes(1);
    } finally {
      delete process.env.SPARK_LN_DEDUP;
    }
  });

  it("a refusal before paying holds nothing (it is rethrown as is)", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" })]);
    const { agent, pay } = mk();
    pay.mockRejectedValueOnce(new Error("Lightning send blocked: fee over cap"));
    const r = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(r.error.message).toMatch(/send blocked/);
    stubFetch([resp(402, { invoice: inv, macaroon: "mac2" }), resp(200, { ok: true })]);
    await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(pay).toHaveBeenCalledTimes(2); // a fresh purchase was right: nothing had left
  });

  it("a 429 or 408 on delivery is retried with the same pass", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), resp(429, {}), resp(408, {}), resp(200, { ok: true })]);
    const { agent, pay } = mk();
    const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(value).toMatchObject({ paid: true, data: { ok: true } });
    expect(pay).toHaveBeenCalledTimes(1);
  });

  // ToB review 2026-10-28 (F02): after paying, only 5xx/408/429 were retried and
  // only 401/402 refused, so "try again shortly" (409, 423, 425) or a 403
  // released the pass and the natural retry bought a second one.
  it.each([409, 423, 425])("a %i on delivery is retried with the same pass", async (status) => {
    const inv = await invoice2000();
    const seen = stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), resp(status, {}), resp(200, { ok: true })]);
    const { agent, pay } = mk();
    const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(value).toMatchObject({ paid: true, status: 200, data: { ok: true } });
    expect(seen.slice(1).map(auth)).toEqual(["L402 mac1:abc123preimage", "L402 mac1:abc123preimage"]);
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it("a 409 on every attempt holds the pass: the next call presents it without paying", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), resp(409, {}), resp(409, {}), resp(409, {})]);
    const { agent, pay } = mk();
    const first = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(first.error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: true });
    expect(first.error.message).toMatch(/after 3 attempts \(HTTP 409\)/);

    const seen = stubFetch([resp(200, { ok: true })]);
    expect((await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }))).value).toMatchObject({ paid: false, recovered: true, data: { ok: true } });
    expect(seen.map(auth)).toEqual(["L402 mac1:abc123preimage"]);
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it("a POST answered 409 is sent once and held, not repeated", async () => {
    const inv = await invoice2000();
    const seen = stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), resp(409, {})]);
    const { agent } = mk();
    const r = await run(agent.fetchL402(URL_, { method: "POST", body: { q: 1 }, maxAmountSats: 3000 }));
    expect(r.error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: true });
    expect(r.error.message).toMatch(/after 1 attempt \(HTTP 409\).*resend: true/s);
    expect(seen).toHaveLength(2);
  });

  it("a 403 after paying refuses the pass like a 401: blocked, no second purchase", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), resp(403, { error: "wrong caveat" })]);
    const { agent, pay } = mk();
    const r = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(r.error).toMatchObject({ code: "PAYMENT_COMMITTED", reason: "L402_PASS_REFUSED", settled: true, status: 403 });
    stubFetch([]);
    expect((await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }))).error).toMatchObject({ reason: "L402_PASS_REFUSED" });
    expect(pay).toHaveBeenCalledTimes(1);
  });

  // Documented in l402.md: these are the service's answer, so the pass is
  // released and calling again is a new purchase. A POST answered 400 must stay
  // free to send a corrected body.
  it.each([400, 404, 410, 422])("a %i after paying is returned with its status, and calling again buys again", async (status) => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), resp(status, { error: "no" })]);
    const { agent, pay } = mk();
    const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(value).toMatchObject({ paid: true, status, macaroon: "mac1", preimage: "abc123preimage", data: { error: "no" } });
    expect(agent.forgetL402(URL_)).toBe(false); // nothing held
    stubFetch([resp(402, { invoice: inv, macaroon: "mac2" }), resp(200, { ok: true })]);
    await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(pay).toHaveBeenCalledTimes(2);
  });

  it("a POST is presented once: a failed delivery holds the pass instead of re-sending it", async () => {
    const inv = await invoice2000();
    const seen = stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), resp(503, {})]);
    const { agent } = mk();
    const r = await run(agent.fetchL402(URL_, { method: "POST", body: { q: 1 }, maxAmountSats: 3000 }));
    expect(r.error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: true });
    expect(r.error.message).toMatch(/after 1 attempt \(HTTP 503\)/);
    expect(r.error.message).toMatch(/resend: true/);
    expect(seen).toHaveLength(2); // the challenge and ONE paid attempt
  });

  // ToB review of 375e6fb..HEAD: "call again" re-sent the POST, placing a
  // second order on the one payment.
  it("a POST that was sent once is sent again only with { resend: true }, with the same pass and no payment", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), new TypeError("fetch failed")]);
    const { agent, pay } = mk();
    const post = { method: "POST", body: { order: 7 }, maxAmountSats: 3000 };
    await run(agent.fetchL402(URL_, post));

    stubFetch([]);
    const again = await run(agent.fetchL402(URL_, post));
    expect(again.error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: true });
    expect(again.error.message).toMatch(/already sent once.*resend: true/s);

    const seen = stubFetch([resp(200, { placed: true })]);
    const resent = await run(agent.fetchL402(URL_, { ...post, resend: true }));
    expect(resent.value).toMatchObject({ recovered: true, data: { placed: true } });
    expect(seen.map(auth)).toEqual(["L402 mac1:abc123preimage"]);
    expect(pay).toHaveBeenCalledTimes(1);
    await expect(agent.fetchL402(URL_, { resend: "yes" })).rejects.toThrow(/resend must be true or false/);
  });

  // ToB review of 375e6fb..HEAD: settling a held invoice never re-read the
  // token, so a first payment that hadn't gone through became a purchase of a
  // pass the service had already declared dead.
  it("a held payment whose pass has since expired is not settled: blocked until forgetL402", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: tokenExpiringIn(600) })]);
    const { agent, pay } = mk();
    pay.mockRejectedValueOnce(Object.assign(new Error("outcome unknown"), { code: "PAYMENT_COMMITTED", settled: null }));
    await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));

    const later = Date.now() + 11 * 60_000;
    const clock = vi.spyOn(Date, "now").mockReturnValue(later);
    try {
      stubFetch([]);
      for (let i = 0; i < 2; i++) {
        const r = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
        expect(r.error).toMatchObject({ code: "PAYMENT_COMMITTED", reason: "L402_PASS_EXPIRED", settled: null });
        expect(r.error.message).toMatch(/Nothing new was paid/);
      }
      expect(pay).toHaveBeenCalledTimes(1);
      expect(agent.forgetL402(URL_)).toBe(true);
      stubFetch([resp(402, { invoice: inv, macaroon: "mac2" }), resp(200, { ok: true })]);
      const fresh = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
      expect(fresh.value).toMatchObject({ paid: true });
      expect(pay).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  // ToB review of 375e6fb..HEAD: errors from settling a held invoice came back
  // raw, among them "exceeds available balance", which by this package's own
  // rule means nothing was sent — when the first payment had likely drained it.
  it("an error while settling a held payment is PAYMENT_COMMITTED and keeps the hold", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" })]);
    const { agent, pay } = mk();
    pay.mockRejectedValueOnce(Object.assign(new Error("outcome unknown"), { code: "PAYMENT_COMMITTED", settled: null }));
    await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));

    const drained = Object.assign(new Error("Total target amount exceeds available balance"), { name: "SparkValidationError" });
    pay.mockRejectedValueOnce(drained);
    stubFetch([]);
    const second = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(second.error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: null, cause: drained });
    expect(second.error.message).toMatch(/settling it again failed.*Nothing new was paid/s);
    expect(pay.mock.calls[1][1][Object.getOwnPropertySymbols(pay.mock.calls[1][1]).find((k) => String(k).includes("Resuming"))]).toBeTypeOf("object");

    const seen = stubFetch([resp(200, { ok: true })]); // still held: settled, then delivered
    const third = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(third.value).toMatchObject({ recovered: true, data: { ok: true } });
    expect(pay.mock.calls.map((c) => c[0])).toEqual([inv, inv, inv]);
    expect(seen).toHaveLength(1);
  });

  it("a held payment that failed while being settled, its sats back (USER_SWAP_RETURNED): the same call buys afresh", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" })]);
    const { agent, pay } = mk();
    pay.mockRejectedValueOnce(Object.assign(new Error("outcome unknown"), { code: "PAYMENT_COMMITTED", settled: null }));
    await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));

    pay.mockRejectedValueOnce(Object.assign(new Error("Lightning payment failed (USER_SWAP_RETURNED)"), {
      code: "LIGHTNING_PAYMENT_FAILED", status: "USER_SWAP_RETURNED", fundsReturned: true, sendId: "send-9",
    }));
    stubFetch([resp(402, { invoice: inv, macaroon: "mac2" }), resp(200, { ok: true })]);
    const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(value).toMatchObject({ paid: true, data: { ok: true } });
    expect(pay).toHaveBeenCalledTimes(3);
  });

  // Changed 2026-10-28 (verified): this used to buy afresh at once, while the
  // failed payment's sats could still be locked to the SSP.
  it("a held payment that failed while being settled, its sats maybe still locked: held on the send's id, not bought again", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" })]);
    const { agent, wallet, pay } = mk();
    pay.mockRejectedValueOnce(Object.assign(new Error("outcome unknown"), { code: "PAYMENT_COMMITTED", settled: null }));
    await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));

    const failed = Object.assign(new Error("Lightning payment failed (PENDING_USER_SWAP_RETURN)"), {
      code: "LIGHTNING_PAYMENT_FAILED", status: "PENDING_USER_SWAP_RETURN", fundsReturned: false, sendId: "send-9",
    });
    pay.mockRejectedValueOnce(failed);
    stubFetch([]); // no new challenge, no delivery
    const second = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(second.error).toMatchObject({
      code: "LIGHTNING_PAYMENT_FAILED", retryable: "check-first", fundsReturned: false, status: "PENDING_USER_SWAP_RETURN", sendId: "send-9", cause: failed,
    });
    expect(second.error.nextStep).toMatch(/The hold is saved on disk.*If the check itself fails/);

    // The hold is now on the send's id: the next call reads its status instead of paying.
    const asked = [];
    wallet.getLightningSendRequest = async (id) => { asked.push(id); return { status: "USER_SWAP_RETURNED" }; };
    stubFetch([resp(402, { invoice: inv, macaroon: "mac2" }), resp(200, { ok: true })]);
    const third = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(asked).toEqual(["send-9"]);
    expect(third.value).toMatchObject({ paid: true, data: { ok: true } });
    expect(pay).toHaveBeenCalledTimes(3); // the held invoice twice, then the new purchase once
  });

  // ToB review of 375e6fb..HEAD: PREIMAGE_PROVIDING_FAILED read as "still
  // pending, call again later" forever.
  it("a held send that ended with the service maybe paid but no proof: blocked (L402_NO_PROOF), not pending forever", async () => {
    stubFetch([resp(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" })]);
    const { agent, wallet, pay } = mk();
    pay.mockResolvedValueOnce({ settled: false, paymentPreimage: null, id: "send-1", lastStatus: "LIGHTNING_PAYMENT_INITIATED" });
    await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));

    wallet.getLightningSendRequest = async () => ({ status: "PREIMAGE_PROVIDING_FAILED" });
    stubFetch([]);
    const r = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(r.error).toMatchObject({ code: "PAYMENT_COMMITTED", reason: "L402_NO_PROOF", settled: null });
    wallet.getLightningSendRequest = async () => { throw new Error("must not be asked again"); };
    const again = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(again.error).toMatchObject({ reason: "L402_NO_PROOF" });
    expect(pay).toHaveBeenCalledTimes(1);
  });

  it("a status read that fails while checking a held send is PAYMENT_COMMITTED, not a raw error", async () => {
    stubFetch([resp(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" })]);
    const { agent, wallet, pay } = mk();
    pay.mockResolvedValueOnce({ settled: false, paymentPreimage: null, id: "send-1", lastStatus: "LIGHTNING_PAYMENT_INITIATED" });
    await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    wallet.getLightningSendRequest = async () => { throw new Error("UNAVAILABLE"); };
    stubFetch([]);
    const r = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(r.error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: null, sendId: "send-1" });
    expect(r.error.message).toMatch(/can't be checked right now/);
  });

  // ToB review of 375e6fb..HEAD: the refusal was a plain Error that forgot the
  // purchase, so a loop that stops only on PAYMENT_COMMITTED bought again.
  it("a 401 or 402 after paying is PAYMENT_COMMITTED (L402_PASS_REFUSED), and this agent won't buy that URL again on its own", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), resp(402, { invoice: "lnbc-new", macaroon: "mac2" })]);
    const { agent, pay } = mk();
    const r = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(r.error).toMatchObject({ code: "PAYMENT_COMMITTED", reason: "L402_PASS_REFUSED", settled: true, paid: true, status: 402 });
    expect(r.error.message).toMatch(/forgetL402/);

    stubFetch([]); // a retry loop: no request, no payment
    for (let i = 0; i < 3; i++) {
      const again = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
      expect(again.error).toMatchObject({ code: "PAYMENT_COMMITTED", reason: "L402_PASS_REFUSED" });
    }
    expect(pay).toHaveBeenCalledTimes(1);

    expect(agent.forgetL402(URL_)).toBe(true); // the user's decision
    stubFetch([resp(402, { invoice: inv, macaroon: "mac3" }), resp(200, { ok: true })]);
    const fresh = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(fresh.value).toMatchObject({ paid: true, data: { ok: true } });
    expect(pay).toHaveBeenCalledTimes(2);
  });

  // The held invoice can expire before a doubtful payment is settled again.
  // Settling it then can't tell whether the first payment went through, so it
  // becomes a block, not "still pending" forever.
  it("a held payment whose invoice expired is blocked (L402_INVOICE_EXPIRED), not pending forever", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" })]);
    const { agent, pay } = mk();
    pay.mockRejectedValueOnce(Object.assign(new Error("outcome unknown"), { code: "PAYMENT_COMMITTED", settled: null }));
    await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    pay.mockRejectedValueOnce(Object.assign(new Error("invoice expired; an earlier attempt is on record"), { code: "PAYMENT_COMMITTED", reason: "INVOICE_EXPIRED_AFTER_ATTEMPT" }));
    stubFetch([]);
    const r = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(r.error).toMatchObject({ code: "PAYMENT_COMMITTED", reason: "L402_INVOICE_EXPIRED", settled: null, invoiceHash: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const again = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(again.error).toMatchObject({ reason: "L402_INVOICE_EXPIRED" });
    expect(pay).toHaveBeenCalledTimes(2); // the block doesn't try again
  });

  // ToB review of 9bc0f22..f88fbec (F3): with blocks kept forever, a full map
  // dropped may-have-paid holds instead, and the next call bought again.
  // Nothing held is dropped now; at the limit a NEW purchase is refused.
  it("at the held limit a new purchase is refused before paying, and nothing held is dropped", async () => {
    const inv = await invoice2000();
    const { agent, pay } = mk();
    for (let i = 0; i < 1000; i++) {
      stubFetch([resp(402, { invoice: inv, macaroon: `m${i}` }), ...Array.from({ length: 3 }, () => new TypeError("fetch failed"))]);
      await run(agent.fetchL402(`${URL_}/${i}`, { maxAmountSats: 3000 }));
    }
    expect(pay).toHaveBeenCalledTimes(1000);
    stubFetch([resp(402, { invoice: inv, macaroon: "one-too-many" })]);
    const refused = await run(agent.fetchL402(`${URL_}/new`, { maxAmountSats: 3000 }));
    expect(refused.error.message).toMatch(/1000 unresolved L402 purchases.*Nothing was paid/s);
    expect(pay).toHaveBeenCalledTimes(1000);
    const seen = stubFetch([resp(200, { ok: true })]); // the first hold is still there
    const first = await run(agent.fetchL402(`${URL_}/0`, { maxAmountSats: 3000 }));
    expect(first.value).toMatchObject({ recovered: true });
    expect(seen.map(auth)).toEqual(["L402 m0:abc123preimage"]);
  }, 60_000);

  // ToB review of 7ec89b9 (N1): the held map dropped its oldest entry when
  // full, blocks included, so 100 other holds later the refused URL was bought
  // again on nobody's say-so.
  it("a full held map never drops a block", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), resp(401, {})]);
    const { agent, pay } = mk();
    const refused = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(refused.error).toMatchObject({ reason: "L402_PASS_REFUSED" });
    // 120 other purchases whose delivery fails: each is held.
    for (let i = 0; i < 120; i++) {
      stubFetch([resp(402, { invoice: inv, macaroon: `m${i}` }), ...Array.from({ length: 3 }, () => new TypeError("fetch failed"))]);
      await run(agent.fetchL402(`${URL_}/${i}`, { maxAmountSats: 3000 }));
    }
    stubFetch([]); // the refused URL: still blocked, no request, no payment
    const again = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(again.error).toMatchObject({ reason: "L402_PASS_REFUSED" });
    expect(pay).toHaveBeenCalledTimes(121);
  });

  // ToB review of 7ec89b9 (N5, N8): the hint said forgetL402(url), which is
  // GET's, for a blocked POST; and a refused pass left no proof to show.
  it("a block's error names the call that lifts it, and carries the invoice hash and amount", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), resp(402, {})]);
    const { agent } = mk();
    const r = await run(agent.fetchL402(URL_, { method: "POST", body: { q: 1 }, maxAmountSats: 3000 }));
    expect(r.error.message).toContain('agent.forgetL402(url, { method: "POST" })');
    expect(r.error).toMatchObject({ invoiceHash: expect.stringMatching(/^[0-9a-f]{64}$/), amountSats: 2000 });
    expect(agent.forgetL402(URL_)).toBe(false); // GET: nothing held
    expect(agent.forgetL402(URL_, { method: "POST" })).toBe(true);
  });

  // ToB review of 7ec89b9 (N6): resend sent the NEW call's body.
  it("{ resend: true } refuses a body that differs from the request it re-sends", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), new TypeError("fetch failed")]);
    const { agent, pay } = mk();
    await run(agent.fetchL402(URL_, { method: "POST", body: { order: 7 }, maxAmountSats: 3000 }));
    stubFetch([]);
    const other = await run(agent.fetchL402(URL_, { method: "POST", body: { order: 8 }, maxAmountSats: 3000, resend: true }));
    expect(other.error.message).toMatch(/body differs/);
    const seen = stubFetch([resp(200, { placed: true })]);
    const same = await run(agent.fetchL402(URL_, { method: "POST", body: { order: 7 }, maxAmountSats: 3000, resend: true }));
    expect(same.value).toMatchObject({ recovered: true });
    expect(seen[0].body).toBe(JSON.stringify({ order: 7 }));
    expect(pay).toHaveBeenCalledTimes(1);
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

  // Redirects (2026-11-09). Before paying, none is followed: the paid
  // challenge must come from the URL given. After paying, same-origin hops
  // keep the pass, another https host gets no pass, no caller header and no
  // body, and anything else stops with the pass held.
  describe("redirects", () => {
    const redirect = (status, location) => ({
      status,
      headers: { get: (h) => (String(h).toLowerCase() === "location" ? location : null) },
      text: async () => "",
    });
    const stubUrls = (queue) => {
      const calls = [];
      vi.stubGlobal("fetch", async (url, opts) => {
        calls.push({ url: String(url), opts });
        const next = queue.shift();
        if (next === undefined) throw new Error("unexpected extra fetch");
        if (next instanceof Error) throw next;
        return next;
      });
      return calls;
    };

    it("a redirect before paying is not followed: SERVICE_REDIRECTED ('no'), nothing paid", async () => {
      const calls = stubUrls([redirect(307, "/v2/paid")]);
      const { agent, pay } = mk();
      const { error } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
      expect(error).toMatchObject({ code: "SERVICE_REDIRECTED", retryable: "no", status: 307, location: "https://api.example/v2/paid" });
      expect(error.message).toMatch(/Nothing was paid/);
      expect(calls).toHaveLength(1);
      expect(calls[0].opts.redirect).toBe("manual");
      expect(pay).not.toHaveBeenCalled();
    });

    it("previewL402 reports a redirect instead of 'no payment required'", async () => {
      stubUrls([redirect(302, "https://elsewhere.example/paid")]);
      const { agent } = mk();
      const { error } = await run(agent.previewL402(URL_));
      expect(error).toMatchObject({ code: "SERVICE_REDIRECTED", status: 302, location: "https://elsewhere.example/paid" });
    });

    it("a POST redirected before paying says the service received it", async () => {
      stubUrls([redirect(302, "/elsewhere")]);
      const { agent } = mk();
      const { error } = await run(agent.fetchL402(URL_, { method: "POST", body: { q: 1 }, maxAmountSats: 3000 }));
      expect(error).toMatchObject({ code: "SERVICE_REDIRECTED", retryable: "no" });
      expect(error.nextStep).toMatch(/received this request/);
    });

    it("after paying, a same-origin redirect is followed with the pass", async () => {
      const inv = await invoice2000();
      const calls = stubUrls([resp(402, { invoice: inv, macaroon: "mac1" }), redirect(302, "/paid/"), resp(200, { ok: true })]);
      const { agent, pay } = mk();
      const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
      expect(value).toMatchObject({ paid: true, status: 200, data: { ok: true } });
      expect(calls.slice(1).map((c) => [c.url, auth(c.opts)])).toEqual([
        [URL_, "L402 mac1:abc123preimage"],
        ["https://api.example/paid/", "L402 mac1:abc123preimage"],
      ]);
      expect(pay).toHaveBeenCalledTimes(1);
    });

    it("a 303 after a paid POST becomes a GET without the body, still with the pass", async () => {
      const inv = await invoice2000();
      const calls = stubUrls([resp(402, { invoice: inv, macaroon: "mac1" }), redirect(303, "/orders/1"), resp(200, { order: 1 })]);
      const { agent } = mk();
      const { value } = await run(agent.fetchL402(URL_, { method: "POST", body: { item: 7 }, maxAmountSats: 3000 }));
      expect(value).toMatchObject({ data: { order: 1 } });
      expect(calls[2]).toMatchObject({ url: "https://api.example/orders/1", opts: { method: "GET", body: undefined } });
      expect(auth(calls[2].opts)).toBe("L402 mac1:abc123preimage");
    });

    it("a redirect to another https host is followed without the pass, the caller's headers or a body", async () => {
      const inv = await invoice2000();
      const calls = stubUrls([resp(402, { invoice: inv, macaroon: "mac1" }), redirect(302, "https://cdn.example/f?sig=1"), resp(200, { file: true })]);
      const { agent } = mk();
      const { value } = await run(agent.fetchL402(URL_, { headers: { "X-Api-Key": "k" }, maxAmountSats: 3000 }));
      expect(value).toMatchObject({ data: { file: true } });
      expect(calls[1].opts.headers).toMatchObject({ "X-Api-Key": "k", Authorization: "L402 mac1:abc123preimage" });
      expect(calls[2]).toMatchObject({ url: "https://cdn.example/f?sig=1", opts: { headers: {}, body: undefined } });
    });

    it("a redirect to plain http stops: PAYMENT_COMMITTED, the pass held, and the next call presents it without paying", async () => {
      const inv = await invoice2000();
      const calls = stubUrls([resp(402, { invoice: inv, macaroon: "mac1" }), redirect(302, "http://cdn.example/f")]);
      const { agent, pay } = mk();
      const { error } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
      expect(error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: true, status: 302, location: "http://cdn.example/f" });
      expect(error.message).toMatch(/not https/);
      expect(calls.map((c) => c.url)).not.toContain("http://cdn.example/f");

      const next = stubUrls([resp(200, { ok: true })]);
      expect((await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }))).value).toMatchObject({ paid: false, recovered: true, data: { ok: true } });
      expect(next.map((c) => auth(c.opts))).toEqual(["L402 mac1:abc123preimage"]);
      expect(pay).toHaveBeenCalledTimes(1);
    });

    it("a 307 to another host after a paid POST stops instead of sending the body there", async () => {
      const inv = await invoice2000();
      const calls = stubUrls([resp(402, { invoice: inv, macaroon: "mac1" }), redirect(307, "https://other.example/x")]);
      const { agent } = mk();
      const { error } = await run(agent.fetchL402(URL_, { method: "POST", body: { item: 7 }, maxAmountSats: 3000 }));
      expect(error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: true, location: "https://other.example/x" });
      expect(error.message).toMatch(/another host/);
      expect(calls).toHaveLength(2); // the challenge and the paid POST; nothing to other.example
    });

    it("a refusal from the host a redirect led to is a failed attempt, retried from the service's URL with the pass", async () => {
      const inv = await invoice2000();
      const calls = stubUrls([
        resp(402, { invoice: inv, macaroon: "mac1" }),
        redirect(302, "https://cdn.example/f?sig=old"), resp(403, {}),
        redirect(302, "https://cdn.example/f?sig=new"), resp(200, { file: true }),
      ]);
      const { agent, pay } = mk();
      const { value } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
      expect(value).toMatchObject({ paid: true, data: { file: true } });
      expect(calls[3]).toMatchObject({ url: URL_ });
      expect(auth(calls[3].opts)).toBe("L402 mac1:abc123preimage");
      expect(pay).toHaveBeenCalledTimes(1);
    });

    it("more than 5 redirects stop, with the pass held", async () => {
      const inv = await invoice2000();
      stubUrls([resp(402, { invoice: inv, macaroon: "mac1" }), ...Array.from({ length: 5 }, (_, i) => redirect(302, `/hop${i}`))]);
      const { agent } = mk();
      const { error } = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
      expect(error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: true });
      expect(error.message).toMatch(/more than 5 redirects/);
    });
  });

  // ToB review 2026-10-28 (F10): the hold was keyed on the raw string, so a
  // respelling of the same request (host case, :443, a #fragment, dot
  // segments) bought it again. Query order and a trailing slash still name
  // another resource.
  it("a respelling of the same request finds its hold; another query order or a trailing slash does not", async () => {
    const inv = await invoice2000();
    const { agent, pay } = mk();
    const url = "https://api.example/paid?a=1&b=2";
    for (const same of ["https://API.example:443/paid?a=1&b=2", "https://api.example/x/../paid?a=1&b=2#top"]) {
      stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), ...Array.from({ length: 3 }, () => new TypeError("fetch failed"))]);
      await run(agent.fetchL402(url, { maxAmountSats: 3000 })); // paid, not delivered: held
      const seen = stubFetch([resp(200, { ok: true })]);
      expect((await run(agent.fetchL402(same, { maxAmountSats: 3000 }))).value).toMatchObject({ recovered: true, data: { ok: true } });
      expect(seen.map(auth)).toEqual(["L402 mac1:abc123preimage"]);
    }
    expect(pay).toHaveBeenCalledTimes(2); // one per purchase, none for the respellings
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" }), ...Array.from({ length: 3 }, () => new TypeError("fetch failed"))]);
    await run(agent.fetchL402(url, { maxAmountSats: 3000 }));
    for (const other of ["https://api.example/paid?b=2&a=1", "https://api.example/paid/?a=1&b=2"]) {
      const seen = stubFetch([resp(402, { invoice: inv, macaroon: "mac2" }), resp(200, { ok: true })]);
      await run(agent.fetchL402(other, { maxAmountSats: 3000 }));
      expect(seen[0].headers.Authorization).toBeUndefined();
    }
    expect(pay).toHaveBeenCalledTimes(5);
    expect(agent.forgetL402("https://API.example/paid?a=1&b=2#x")).toBe(true);
  });

  // ToB review 2026-10-28 (F33): a recovered POST was marked sent once only by
  // the hold after a failed delivery, and no test reached it. It is now also
  // marked before it goes out, so a process that dies mid-request can't leave
  // the next one sending it again.
  it.each([
    ["its preimage arrived later", "pending"],
    ["its first pay call may have paid", "committed"],
  ])("a recovered POST (%s) whose delivery fails is held as sent once: sent again only with { resend: true }", async (_label, how) => {
    stubFetch([resp(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" })]);
    const { agent, wallet, pay } = mk();
    if (how === "pending") {
      pay.mockResolvedValueOnce({ settled: false, paymentPreimage: null, id: "send-1", lastStatus: "LIGHTNING_PAYMENT_INITIATED" });
      wallet.getLightningSendRequest = async () => ({ status: "TRANSFER_COMPLETED", paymentPreimage: KNOWN_PREIMAGE });
    } else {
      pay.mockRejectedValueOnce(Object.assign(new Error("outcome unknown"), { code: "PAYMENT_COMMITTED", settled: null }));
      pay.mockResolvedValueOnce({ settled: true, paymentPreimage: KNOWN_PREIMAGE, id: "send-1" });
    }
    const post = { method: "POST", body: { order: 7 }, maxAmountSats: 3000 };
    expect((await run(agent.fetchL402(URL_, post))).error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: null });

    const onDisk = [];
    const posts = [];
    vi.stubGlobal("fetch", async (url, opts) => {
      posts.push(opts);
      onDisk.push(...(await createL402HoldStore({ dir: process.env.SPARK_L402_HOLDS_PATH }).list()).map((r) => r.sentOnce));
      return resp(503, {});
    });
    const second = await run(agent.fetchL402(URL_, post));
    expect(second.error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: true, sendId: "send-1" });
    expect(second.error.message).toMatch(/after 1 attempt \(HTTP 503\).*resend: true/s);
    expect(onDisk).toEqual([true]); // on disk as sent once while the request was out

    stubFetch([]); // without resend: nothing is sent
    expect((await run(agent.fetchL402(URL_, post))).error.message).toMatch(/already sent once/);
    expect(posts.map(auth)).toEqual([`L402 mac1:${KNOWN_PREIMAGE}`]);

    const resent = stubFetch([resp(200, { placed: true })]);
    expect((await run(agent.fetchL402(URL_, { ...post, resend: true }))).value).toMatchObject({ recovered: true, data: { placed: true } });
    expect(resent.map(auth)).toEqual([`L402 mac1:${KNOWN_PREIMAGE}`]);
    expect(pay).toHaveBeenCalledTimes(how === "pending" ? 1 : 2);
  });

  // F34: the proof check on a preimage read back by the send's id is the only
  // check on that path; #deliverL402 doesn't check again.
  it("a held send whose status read returns a preimage that doesn't prove the invoice: blocked (L402_NO_PROOF), nothing presented", async () => {
    stubFetch([resp(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" })]);
    const { agent, wallet, pay } = mk();
    pay.mockResolvedValueOnce({ settled: false, paymentPreimage: null, id: "send-1", lastStatus: "LIGHTNING_PAYMENT_INITIATED" });
    await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));

    const asked = [];
    wallet.getLightningSendRequest = async (id) => { asked.push(id); return { status: "TRANSFER_COMPLETED", paymentPreimage: "aa".repeat(32) }; };
    const seen = stubFetch([resp(401, {})]); // what the service would answer an unproven pass
    const r = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(r.error).toMatchObject({ code: "PAYMENT_COMMITTED", reason: "L402_NO_PROOF", settled: null, sendId: "send-1" });
    expect(seen).toHaveLength(0);
    expect((await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }))).error).toMatchObject({ reason: "L402_NO_PROOF" });
    expect(asked).toEqual(["send-1"]); // blocked: not asked again
    expect(pay).toHaveBeenCalledTimes(1);
  });

  // F35: settling a held payment again can learn its send id; the hold must
  // keep it, or every later call settles again instead of reading the send.
  const committed = () => Object.assign(new Error("outcome unknown"), { code: "PAYMENT_COMMITTED", settled: null });

  it("settling a held payment again that comes back with an unproven preimage keeps the send id: the next call reads it and blocks", async () => {
    stubFetch([resp(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" })]);
    const { agent, wallet, pay } = mk();
    pay.mockRejectedValueOnce(committed());
    await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));

    pay.mockRejectedValueOnce(Object.assign(new Error("preimage does not prove the invoice"), { code: "PREIMAGE_MISMATCH", sendId: "send-7" }));
    stubFetch([]);
    expect((await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }))).error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: null, sendId: "send-7" });

    wallet.getLightningSendRequest = async (id) => (id === "send-7" ? { status: "TRANSFER_COMPLETED", paymentPreimage: "aa".repeat(32) } : null);
    expect((await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }))).error).toMatchObject({ reason: "L402_NO_PROOF", sendId: "send-7" });
    expect(pay).toHaveBeenCalledTimes(2);
  });

  it("settling a held payment again that is still pending holds it on the send id: a later call delivers by it, even after the invoice expired", async () => {
    stubFetch([resp(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" })]);
    const { agent, wallet, pay } = mk();
    pay.mockRejectedValueOnce(committed());
    await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));

    pay.mockResolvedValueOnce({ settled: false, paymentPreimage: null, id: "send-5", lastStatus: "LIGHTNING_PAYMENT_INITIATED" });
    stubFetch([]);
    const second = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(second.error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: null, sendId: "send-5" });
    expect(second.error.message).toMatch(/still pending/);

    // The send settles after the invoice's expiry: settling the expired
    // invoice again would be refused, so the proof must come from the send.
    const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2 * 3600_000);
    try {
      wallet.getLightningSendRequest = async (id) => (id === "send-5" ? { status: "TRANSFER_COMPLETED", paymentPreimage: KNOWN_PREIMAGE } : null);
      const seen = stubFetch([resp(200, { ok: true })]);
      expect((await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }))).value).toMatchObject({ paid: false, recovered: true, data: { ok: true } });
      expect(seen.map(auth)).toEqual([`L402 mac1:${KNOWN_PREIMAGE}`]);
      expect(pay).toHaveBeenCalledTimes(2);
    } finally {
      clock.mockRestore();
    }
  });

  it("a held payment settled again but not delivered is saved with its send id: a new process reads the proof back, without settling again", async () => {
    stubFetch([resp(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" })]);
    const { agent, pay } = mk();
    pay.mockRejectedValueOnce(committed());
    await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));

    pay.mockResolvedValueOnce({ settled: true, paymentPreimage: KNOWN_PREIMAGE, id: "send-3" });
    stubFetch(Array.from({ length: 3 }, () => new TypeError("fetch failed")));
    expect((await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }))).error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: true, sendId: "send-3" });

    const next = mk(); // a new process: the disk hold, which never has the preimage
    next.wallet.getLightningSendRequest = async (id) => (id === "send-3" ? { status: "TRANSFER_COMPLETED", paymentPreimage: KNOWN_PREIMAGE } : null);
    const seen = stubFetch([resp(200, { ok: true })]);
    expect((await run(next.agent.fetchL402(URL_, { maxAmountSats: 3000 }))).value).toMatchObject({ paid: false, recovered: true, data: { ok: true } });
    expect(seen.map(auth)).toEqual([`L402 mac1:${KNOWN_PREIMAGE}`]);
    expect(next.pay).not.toHaveBeenCalled();
  });

  // F42: a payment the operators say already went through is held like one in
  // doubt, and reported settled.
  it("a pay call refused as already settled is held (settled: true): the next call settles THE SAME invoice, no new challenge", async () => {
    const inv = await invoice2000();
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" })]);
    const { agent, pay } = mk();
    pay.mockRejectedValueOnce(Object.assign(new Error("this invoice was already paid"), { code: "PAYMENT_ALREADY_SETTLED", transferId: "tr-1" }));
    const first = await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }));
    expect(first.error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: true, op: "l402", paid: true });

    const seen = stubFetch([resp(200, { ok: true })]); // no 402 fetch: straight to delivery
    expect((await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }))).value).toMatchObject({ paid: false, recovered: true, data: { ok: true } });
    expect(pay.mock.calls.map((c) => c[0])).toEqual([inv, inv]);
    expect(seen.map(auth)).toEqual(["L402 mac1:abc123preimage"]);
  });

  // F43: a held send found failed on a later call drops its dead dedup id,
  // so the next payment of that invoice doesn't replay the failure.
  it("a held send found failed later drops the invoice's dead dedup id", async () => {
    const inv = await invoice2000();
    const sendStatus = { status: "LIGHTNING_PAYMENT_INITIATED" };
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: vi.fn(async () => ({ id: "send-1", status: "LIGHTNING_PAYMENT_INITIATED" })),
      getLightningSendRequest: vi.fn(async () => sendStatus),
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    stubFetch([resp(402, { invoice: inv, macaroon: "mac1" })]);
    // The real payAndSettle polls until it gives up (30 polls, 2 s apart).
    let done = false;
    const pending = agent.fetchL402(URL_, { maxAmountSats: 3000 }).then((value) => ({ value }), (error) => ({ error }));
    pending.finally(() => { done = true; });
    for (const end = Date.now() + 20_000; !done && Date.now() < end;) {
      await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(2_000);
    }
    expect((await pending).error).toMatchObject({ code: "PAYMENT_COMMITTED", settled: null, sendId: "send-1" });
    const dedup = process.env.SPARK_LN_DEDUP_PATH;
    expect(await readdir(dedup)).not.toEqual([]);

    sendStatus.status = "LIGHTNING_PAYMENT_FAILED";
    stubFetch([]);
    expect((await run(agent.fetchL402(URL_, { maxAmountSats: 3000 }))).error).toMatchObject({ code: "LIGHTNING_PAYMENT_FAILED", retryable: "check-first", sendId: "send-1" });
    expect(await readdir(dedup)).toEqual([]);
    expect(wallet.payLightningInvoice).toHaveBeenCalledTimes(1);
  });
});

// ToB review of 375e6fb..HEAD: settling a held invoice went through the budget
// again, so one 2,000-sat purchase filled a 10,000-sat budget in five calls.
describe("fetchL402 settling a held payment counts the spend once", () => {
  const KEYS = ["SPARK_LEAF_VAULT", "SPARK_DAILY_BUDGET_SATS", "SPARK_SPEND_LEDGER_PATH", "SPARK_LN_DEDUP_PATH"];
  const saved = {};
  let dir;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "agent-l402-budget-"));
    for (const k of KEYS) saved[k] = process.env[k];
    Object.assign(process.env, {
      SPARK_LEAF_VAULT: "off",
      SPARK_DAILY_BUDGET_SATS: "10000",
      SPARK_SPEND_LEDGER_PATH: join(dir, "ledger.json"),
      SPARK_LN_DEDUP_PATH: join(dir, "ln-dedup"),
    });
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("the first attempt is counted; settling it again is not", async () => {
    let attempt = 0;
    const replay = { id: "send-1", encodedInvoice: KNOWN_INVOICE, status: "TRANSFER_COMPLETED", paymentPreimage: KNOWN_PREIMAGE };
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: async () => {
        if (attempt++ === 0) throw new Error("deadline exceeded"); // proves nothing: money may have left
        return replay; // the dedup id replays the original payment
      },
      getLightningSendRequest: async () => replay,
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    const queue = [resp(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" }), resp(200, { ok: true })];
    vi.stubGlobal("fetch", async () => queue.shift());

    await expect(agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 })).rejects.toMatchObject({ code: "PAYMENT_COMMITTED" });
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 2000 });
    const r = await agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 });
    expect(r).toMatchObject({ recovered: true, data: { ok: true } });
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 2000 });
    expect(attempt).toBe(2);
  });

  // ToB review 2026-10-28: a first attempt refused because another payment of
  // the hash was open sent nothing, dropped its id and undid its spend; the
  // resume then skipped the budget, so the purchase's only payment was never
  // counted (and read paid: false).
  const preimageRequestExists = () => Object.assign(
    new Error("Failed to initiate preimage swap: rpc error: code = AlreadyExists desc = preimage request already exists for paymentHash 0f1e"),
    { name: "SparkRequestError" },
  );
  const refusedThenPaid = () => {
    let attempt = 0;
    const done = { id: "send-1", encodedInvoice: KNOWN_INVOICE, status: "TRANSFER_COMPLETED", paymentPreimage: KNOWN_PREIMAGE };
    const wallet = {
      getSparkAddress: async () => "sp1from",
      getLightningSendFeeEstimate: async () => 5,
      payLightningInvoice: vi.fn(async () => {
        if (attempt++ === 0) throw preimageRequestExists();
        return done;
      }),
      getLightningSendRequest: async () => done,
      transfer: async () => ({ id: "t1" }),
    };
    return { wallet, agent: new SparkAgent(wallet, "MAINNET") };
  };

  it("after EARLIER_ATTEMPT_OPEN the settling call is the real purchase: counted once, paid: true", async () => {
    const { wallet, agent } = refusedThenPaid();
    const queue = [resp(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" }), resp(200, { ok: true })];
    vi.stubGlobal("fetch", async () => queue.shift());

    await expect(agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 }))
      .rejects.toMatchObject({ code: "PAYMENT_COMMITTED", cause: { reason: "EARLIER_ATTEMPT_OPEN" } });
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 0 });
    const r = await agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 });
    expect(r).toMatchObject({ paid: true, recovered: true, data: { ok: true } });
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 2000 });
    expect(wallet.payLightningInvoice).toHaveBeenCalledTimes(2);
  });

  it("if that call's own payment is in doubt, it says so (paid: true), and the next call settles it uncounted", async () => {
    const { wallet, agent } = refusedThenPaid();
    const done = await wallet.getLightningSendRequest();
    wallet.payLightningInvoice
      .mockImplementationOnce(async () => { throw preimageRequestExists(); })
      .mockImplementationOnce(async () => { throw new Error("deadline exceeded"); })
      .mockImplementationOnce(async () => done);
    const queue = [resp(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" }), resp(200, { ok: true })];
    vi.stubGlobal("fetch", async () => queue.shift());

    await expect(agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 })).rejects.toMatchObject({ code: "PAYMENT_COMMITTED" });
    const err = await agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 }).catch((e) => e);
    expect(err).toMatchObject({ code: "PAYMENT_COMMITTED", paid: true, settled: null });
    expect(err.message).toMatch(/sent nothing, so this call paid its invoice/);
    expect(err.message).not.toMatch(/Nothing new was paid/);
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 2000 });
    const r = await agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 });
    expect(r).toMatchObject({ paid: false, recovered: true, data: { ok: true } });
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 2000 });
    expect(wallet.payLightningInvoice).toHaveBeenCalledTimes(3);
  });

  it("the budget can refuse that call: nothing is paid and the purchase stays held", async () => {
    process.env.SPARK_DAILY_BUDGET_SATS = "3000";
    const { wallet, agent } = refusedThenPaid();
    let fetches = 0;
    vi.stubGlobal("fetch", async () => { fetches++; return resp(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" }); });

    await expect(agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 })).rejects.toMatchObject({ code: "PAYMENT_COMMITTED" });
    await agent.transfer({ to: "sp1x", amount: 1500 });
    for (let i = 0; i < 2; i++) {
      const err = await agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 }).catch((e) => e);
      expect(err).toMatchObject({ code: "SPEND_BUDGET_EXCEEDED", retryable: "no" });
      expect(err.nextStep).toMatch(/^Nothing was paid: the earlier attempt to buy this resource sent nothing/);
    }
    expect(await agent.spendStatus()).toMatchObject({ spentSats: 1500 });
    expect(wallet.payLightningInvoice).toHaveBeenCalledTimes(1);
    expect(fetches).toBe(1); // held: no new challenge was fetched
  });
});
