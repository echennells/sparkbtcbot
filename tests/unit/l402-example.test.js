// The runnable L402 example (scripts/l402-paywalls.js) used to hand-roll the
// purchase on the raw SDK, and every failure after paying (a cut body, a
// refused pass, no preimage yet) lost the paid pass so the next call bought
// another (ToB review 2026-10-28, F04). It now pays only through
// agent.fetchL402; these pin that a copy of it can't buy twice.
import { describe, it, expect, afterEach, vi } from "vitest";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { fetchL402Cached } from "../../skills/sparkbtcbot/scripts/l402-paywalls.js";
import { freshInvoice } from "../helpers/bolt11.js";

const KNOWN_INVOICE = freshInvoice("lnbc20u1p4tzwuqpp5gf0dfe9rdvcw5gdepcsuwykxf85zznpfkl40dqyf6ypecmj48pxqsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsdp5wdcxzuntvf6xxcn0wss8getnwsazq6mwdamkugrswfjkjmtpvajsxqrrssfgmzf4e3aygc36mfrkgfj23fs5l3v4a0ztu34u5uu0ws9eycv4psq4msf75685vluz7kg7n3pvvzme375yjx63zjt2nxs9vgspgspvcp45esgz");
const KNOWN_PREIMAGE = "42".repeat(32);
const DONE = { id: "send-1", encodedInvoice: KNOWN_INVOICE, status: "TRANSFER_COMPLETED", paymentPreimage: KNOWN_PREIMAGE };
const resp = (status, body, { json } = {}) => ({
  status, headers: { get: () => "application/json" },
  json: json ?? (async () => body), text: async () => JSON.stringify(body),
});
const challenge = () => resp(402, { invoice: KNOWN_INVOICE, macaroon: "mac1" });

const orig = process.env.SPARK_LEAF_VAULT;
afterEach(() => {
  vi.unstubAllGlobals();
  if (orig === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = orig;
});
const mk = () => {
  process.env.SPARK_LEAF_VAULT = "off";
  const wallet = {
    getSparkAddress: async () => "sp1from",
    getLightningSendFeeEstimate: async () => 5,
    payLightningInvoice: vi.fn(async () => DONE),
    getLightningSendRequest: async () => DONE,
  };
  return { agent: new SparkAgent(wallet, "MAINNET"), wallet };
};
const serve = (...answers) => {
  const seen = [];
  vi.stubGlobal("fetch", async (url, opts) => { seen.push(opts?.headers?.Authorization ?? null); return answers.shift(); });
  return seen;
};
const cut = () => ({ ...resp(200, null), json: async () => { throw new TypeError("terminated"); }, text: async () => { throw new TypeError("terminated"); } });

describe("the L402 example pays only through fetchL402", () => {
  it("a body cut off after paying: the next call presents the same pass, one payment", async () => {
    const { agent, wallet } = mk();
    serve(challenge(), cut(), cut(), cut());
    await expect(fetchL402Cached(agent, "https://ex1.example/a", { maxAmountSats: 3000 })).rejects.toMatchObject({ code: "PAYMENT_COMMITTED", settled: true });
    const seen = serve(resp(200, { ok: true }));
    expect(await fetchL402Cached(agent, "https://ex1.example/a", { maxAmountSats: 3000 })).toMatchObject({ recovered: true, data: { ok: true } });
    expect(seen).toEqual([`L402 mac1:${KNOWN_PREIMAGE}`]);
    expect(wallet.payLightningInvoice).toHaveBeenCalledTimes(1);
  });

  it("a refused pass stops: the next call pays nothing", async () => {
    const { agent, wallet } = mk();
    serve(challenge(), resp(401, {}));
    await expect(fetchL402Cached(agent, "https://ex2.example/a", { maxAmountSats: 3000 })).rejects.toMatchObject({ reason: "L402_PASS_REFUSED" });
    serve();
    await expect(fetchL402Cached(agent, "https://ex2.example/a", { maxAmountSats: 3000 })).rejects.toMatchObject({ reason: "L402_PASS_REFUSED" });
    expect(wallet.payLightningInvoice).toHaveBeenCalledTimes(1);
  });

  it("a paid pass is cached per origin and reused without paying", async () => {
    const { agent, wallet } = mk();
    serve(challenge(), resp(200, { a: 1 }));
    expect(await fetchL402Cached(agent, "https://ex3.example/a", { maxAmountSats: 3000 })).toMatchObject({ paid: true, data: { a: 1 } });
    const seen = serve(resp(200, { b: 2 }));
    expect(await fetchL402Cached(agent, "https://ex3.example/b")).toMatchObject({ paid: false, cached: true, data: { b: 2 } });
    expect(seen).toEqual([`L402 mac1:${KNOWN_PREIMAGE}`]);
    expect(wallet.payLightningInvoice).toHaveBeenCalledTimes(1);
  });

  it("refuses to send a pass over plain http", async () => {
    await expect(fetchL402Cached(mk().agent, "http://ex4.example/a")).rejects.toThrow(/refusing to send an L402 pass over http:/);
  });
  it("a redirect on the cached pass is handed back as the answer: not followed, nothing bought", async () => {
    const { agent, wallet } = mk();
    serve(challenge(), resp(200, { ok: true }));
    await fetchL402Cached(agent, "https://ex9.example/a", { maxAmountSats: 3000 });
    const inits = [];
    vi.stubGlobal("fetch", async (_url, opts) => {
      inits.push(opts);
      return { status: 302, headers: { get: (h) => (h === "location" ? "https://elsewhere.example/a" : null) }, text: async () => "" };
    });
    expect(await fetchL402Cached(agent, "https://ex9.example/b", { maxAmountSats: 3000 }))
      .toMatchObject({ paid: false, cached: true, status: 302, location: "https://elsewhere.example/a" });
    expect(inits).toHaveLength(1);
    expect(inits[0].redirect).toBe("manual");
    expect(wallet.payLightningInvoice).toHaveBeenCalledTimes(1);
  });
});
