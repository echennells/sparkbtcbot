// fetchL402/previewL402 were documented on the agent for two releases but only
// existed in the reference doc — a deployed bot got `TypeError: not a function`.
// Now they ship on SparkAgent; these tests pin the 402 flow with a stubbed fetch.
import { describe, it, expect, afterEach, vi } from "vitest";
import { readFile } from "node:fs/promises";
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
    const { agent, calls } = mkAgent();
    const r = await agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 });
    expect(r).toMatchObject({ paid: true, amountSats: 2000, preimage: "abc123preimage", data: { premium: true } });
    expect(calls.pay.invoice).toBe(inv);
    expect(fetches[1].headers.Authorization).toBe("L402 mac1:abc123preimage");
  });

  it("blocks an over-limit invoice BEFORE paying (amount ceiling)", async () => {
    const inv = await invoice2000(); // 2,000 sats > 1,000 cap
    vi.stubGlobal("fetch", async () => resp(402, { invoice: inv, macaroon: "mac1" }));
    const { agent, calls } = mkAgent();
    await expect(agent.fetchL402("https://api.example/paid", { maxAmountSats: 1000 })).rejects.toThrow(/blocked/i);
    expect(calls.pay).toBeNull(); // never paid
  });
});
