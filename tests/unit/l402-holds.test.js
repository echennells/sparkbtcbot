// L402 holds on disk (lib/l402-holds.js): a chat agent runs each tool call as
// a new process, so a purchase in doubt, or paid but undelivered, must be
// finished by the NEXT process, not bought again. Each "process" here is a
// new SparkAgent over the same holds directory (tests/setup.js gives every
// test its own).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, readdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { l402HoldFileName } from "../../lib/l402-holds.js";
import { freshInvoice } from "../helpers/bolt11.js";

// A 2,000-sat invoice whose preimage is known (sha256(0x42 × 32) is its hash).
const KNOWN_INVOICE = freshInvoice("lnbc20u1p4tzwuqpp5gf0dfe9rdvcw5gdepcsuwykxf85zznpfkl40dqyf6ypecmj48pxqsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsdp5wdcxzuntvf6xxcn0wss8getnwsazq6mwdamkugrswfjkjmtpvajsxqrrssfgmzf4e3aygc36mfrkgfj23fs5l3v4a0ztu34u5uu0ws9eycv4psq4msf75685vluz7kg7n3pvvzme375yjx63zjt2nxs9vgspgspvcp45esgz");
const KNOWN_PREIMAGE = "42".repeat(32);
const URL_ = "https://api.example/paid?apiKey=SECRET";
const KEY = `GET ${URL_}`;
const DONE = { id: "send-1", encodedInvoice: KNOWN_INVOICE, status: "TRANSFER_COMPLETED", paymentPreimage: KNOWN_PREIMAGE };

const resp = (status, body) => ({ status, headers: { get: () => "application/json" }, json: async () => body, text: async () => JSON.stringify(body) });
const challenge = (macaroon = "mac1") => resp(402, { invoice: KNOWN_INVOICE, macaroon });

const saved = {};
beforeEach(async () => {
  for (const k of ["SPARK_LEAF_VAULT", "SPARK_LN_DEDUP_PATH", "SPARK_PRIVACY"]) saved[k] = process.env[k];
  process.env.SPARK_LEAF_VAULT = "off";
  process.env.SPARK_PRIVACY = "off";
  process.env.SPARK_LN_DEDUP_PATH = await mkdtemp(join(tmpdir(), "l402-holds-dedup-")); // shared by both "processes"
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  vi.unstubAllGlobals();
});

// A new process: its own SparkAgent and wallet, the same disk.
const processWith = (pay = async () => DONE) => {
  const wallet = {
    getSparkAddress: async () => "sp1from",
    getLightningSendFeeEstimate: async () => 5,
    payLightningInvoice: vi.fn(pay),
    getLightningSendRequest: vi.fn(async () => DONE),
    getBalance: async () => ({ satsBalance: { available: 10_000n, owned: 10_000n, incoming: 0n }, tokenBalances: new Map() }),
  };
  return { agent: new SparkAgent(wallet, "MAINNET"), wallet };
};
// fetch answers from a queue and records what it was sent.
const serve = (...answers) => {
  const seen = [];
  vi.stubGlobal("fetch", async (url, opts) => {
    seen.push({ url, auth: opts?.headers?.Authorization });
    const next = answers.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected fetch");
    return next;
  });
  return seen;
};
const holdFiles = async () => (await readdir(process.env.SPARK_L402_HOLDS_PATH).catch(() => [])).filter((n) => n.endsWith(".json"));
const holdFile = () => join(process.env.SPARK_L402_HOLDS_PATH, l402HoldFileName(KEY));
const writeRecord = (rec) => writeFile(holdFile(), JSON.stringify({
  version: 1, method: "GET", host: "api.example", path: "/paid", invoice: KNOWN_INVOICE, macaroon: "macX",
  amountSats: 2000, sendId: null, maxAmountSats: 3000, ...rec,
}));

describe("L402 holds outlive the process", () => {
  it("a payment in doubt: the next process settles THE SAME invoice, no new challenge, one payment", async () => {
    const a = processWith(async () => { throw new Error("deadline exceeded"); });
    serve(challenge());
    await expect(a.agent.fetchL402(URL_, { maxAmountSats: 3000 })).rejects.toMatchObject({ code: "PAYMENT_COMMITTED" });
    expect(await holdFiles()).toHaveLength(1);
    const file = await readFile(holdFile(), "utf8");
    expect(JSON.parse(file)).toMatchObject({ state: "held", paid: false, invoice: KNOWN_INVOICE, macaroon: "mac1" });
    expect(file).not.toMatch(/SECRET|apiKey|42424242/); // never the query string, never the preimage

    const b = processWith(); // the dedup id replays the original result
    const seen = serve(resp(200, { ok: true }));
    const r = await b.agent.fetchL402(URL_, { maxAmountSats: 3000 });
    expect(r).toMatchObject({ paid: false, recovered: true, data: { ok: true } });
    expect(seen.map((s) => s.auth)).toEqual([`L402 mac1:${KNOWN_PREIMAGE}`]);
    expect(b.wallet.payLightningInvoice).toHaveBeenCalledTimes(1);
    expect(b.wallet.payLightningInvoice.mock.calls[0][0]).toMatchObject({
      invoice: KNOWN_INVOICE,
      transferId: a.wallet.payLightningInvoice.mock.calls[0][0].transferId, // same dedup id: no second payment
    });
    expect(await holdFiles()).toEqual([]); // delivered: nothing left
  });

  it("paid but undelivered: the next process reads the preimage back from Spark and presents the pass", async () => {
    const a = processWith();
    serve(challenge(), resp(503, {}), resp(503, {}), resp(503, {}));
    await expect(a.agent.fetchL402(URL_, { maxAmountSats: 3000 })).rejects.toMatchObject({ code: "PAYMENT_COMMITTED", settled: true, sendId: "send-1" });
    expect(JSON.parse(await readFile(holdFile(), "utf8"))).toMatchObject({ state: "held", paid: true, sendId: "send-1" });
    expect(await readFile(holdFile(), "utf8")).not.toMatch(/42424242/);

    const b = processWith();
    const seen = serve(resp(200, { ok: true }));
    expect(await b.agent.fetchL402(URL_, { maxAmountSats: 3000 })).toMatchObject({ recovered: true, data: { ok: true } });
    expect(seen.map((s) => s.auth)).toEqual([`L402 mac1:${KNOWN_PREIMAGE}`]);
    expect(b.wallet.payLightningInvoice).not.toHaveBeenCalled();
    expect(b.wallet.getLightningSendRequest).toHaveBeenCalledWith("send-1");
  });

  it("a block holds across processes until forgetL402, which removes the file", async () => {
    const a = processWith();
    serve(challenge(), resp(401, {}));
    await expect(a.agent.fetchL402(URL_, { maxAmountSats: 3000 })).rejects.toMatchObject({ reason: "L402_PASS_REFUSED" });
    const b = processWith();
    const seen = serve();
    await expect(b.agent.fetchL402(URL_, { maxAmountSats: 3000 })).rejects.toMatchObject({ reason: "L402_PASS_REFUSED" });
    expect(seen).toEqual([]);
    expect(b.agent.forgetL402(URL_)).toBe(true);
    expect(await holdFiles()).toEqual([]);
    expect(processWith().agent.forgetL402(URL_)).toBe(false);
  });

  it("status() in a new process lists the hold (L402_HELD), never its secrets", async () => {
    const a = processWith(async () => { throw new Error("deadline exceeded"); });
    serve(challenge());
    await a.agent.fetchL402(URL_, { maxAmountSats: 3000 }).catch(() => {});
    const s = await processWith().agent.status();
    expect(s.problems).toContain("L402_HELD");
    expect(s.l402.held).toEqual([{ method: "GET", host: "api.example", path: "/paid", reason: "pending" }]);
    expect(JSON.stringify(s)).not.toMatch(/mac1|SECRET/);
  });
});

describe("the claim before paying (the semaphore)", () => {
  // L402-7 (review 2026-11-09): a claim whose process died before any attempt
  // reached the SDK was blocked for good once its invoice expired, as "may have
  // gone through", though the dedup store showed no attempt.
  const RAW = "lnbc20u1p4tzwuqpp5gf0dfe9rdvcw5gdepcsuwykxf85zznpfkl40dqyf6ypecmj48pxqsp5zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zyg3zygsdp5wdcxzuntvf6xxcn0wss8getnwsazq6mwdamkugrswfjkjmtpvajsxqrrssfgmzf4e3aygc36mfrkgfj23fs5l3v4a0ztu34u5uu0ws9eycv4psq4msf75685vluz7kg7n3pvvzme375yjx63zjt2nxs9vgspgspvcp45esgz";
  const expiredHourAgo = () => freshInvoice(RAW, Math.floor(Date.now() / 1000) - 7200); // a 3600 s invoice
  it("a dead claim whose invoice expired, with no dedup entry: nothing was paid, so it is dropped and the call buys afresh", async () => {
    await import("node:fs/promises").then((fs) => fs.mkdir(process.env.SPARK_L402_HOLDS_PATH, { recursive: true }));
    await writeRecord({ state: "buying", pid: 2_147_483_646, updatedAt: Date.now(), invoice: expiredHourAgo() });
    const b = processWith();
    const seen = serve(challenge(), resp(200, { ok: true }));
    expect(await b.agent.fetchL402(URL_, { maxAmountSats: 3000 })).toMatchObject({ paid: true, data: { ok: true } });
    expect(seen).toHaveLength(2); // a fresh challenge, then the resource
    expect(b.wallet.payLightningInvoice).toHaveBeenCalledTimes(1);
    expect(b.wallet.payLightningInvoice.mock.calls[0][0].invoice).toBe(KNOWN_INVOICE);
    expect(await holdFiles()).toEqual([]);
  });

  it("the same, but an attempt is on record for that invoice: still blocked, nothing paid", async () => {
    await import("node:fs/promises").then((fs) => fs.mkdir(process.env.SPARK_L402_HOLDS_PATH, { recursive: true }));
    const invoice = expiredHourAgo();
    const { createTransferIdStore } = await import("../../lib/transfer-ids.js");
    await createTransferIdStore({ dir: process.env.SPARK_LN_DEDUP_PATH }).idForInvoice(invoice, () => "0193f1a2-7b7c-7cc3-8a9e-2b1f0c3d4e5f");
    await writeRecord({ state: "buying", pid: 2_147_483_646, updatedAt: Date.now(), invoice });
    const b = processWith();
    const seen = serve();
    await expect(b.agent.fetchL402(URL_, { maxAmountSats: 3000 })).rejects.toMatchObject({ code: "PAYMENT_COMMITTED", reason: "L402_INVOICE_EXPIRED" });
    expect(seen).toEqual([]);
    expect(b.wallet.payLightningInvoice).not.toHaveBeenCalled();
  });

  it("a process that died mid-purchase left its invoice: the next one settles that invoice", async () => {
    await import("node:fs/promises").then((fs) => fs.mkdir(process.env.SPARK_L402_HOLDS_PATH, { recursive: true }));
    await writeRecord({ state: "buying", pid: 2_147_483_646, updatedAt: Date.now() }); // no such process
    const b = processWith();
    const seen = serve(resp(200, { ok: true }));
    expect(await b.agent.fetchL402(URL_, { maxAmountSats: 3000 })).toMatchObject({ data: { ok: true } });
    expect(seen.map((s) => s.auth)).toEqual([`L402 macX:${KNOWN_PREIMAGE}`]); // no new challenge
    expect(b.wallet.payLightningInvoice.mock.calls.map((c) => c[0].invoice)).toEqual([KNOWN_INVOICE]);
  });

  // Review 2026-11-09 (L402-2): the busy error said "call again: it finishes
  // that purchase", which was false once the other process had delivered and
  // removed its claim; the retry bought a second pass. fetchL402 now waits for
  // the other purchase and says what happened.
  describe("another live process buying the same request", () => {
    const live = (extra = {}) => writeRecord({ state: "buying", pid: process.ppid, updatedAt: Date.now(), ...extra });
    // The wait polls on setTimeout: step it, letting real file I/O run between polls.
    const settle = async (promise, onTick = async () => {}) => {
      let done = false;
      let tick = 0;
      const out = promise.then((value) => ({ value }), (error) => ({ error })).finally(() => { done = true; });
      while (!done) {
        await vi.runAllTimersAsync();
        await onTick(++tick);
        if (!done) await stat(tmpdir()); // let the real file reads between polls finish
      }
      return out;
    };
    // How many 1 s waits the call has started: the other process changes its
    // file only once this call is waiting, not after a count of steps, which
    // under load could land before the call had even looked.
    let polls;
    beforeEach(async () => {
      vi.useFakeTimers({ toFake: ["setTimeout"] });
      polls = 0;
      const fake = globalThis.setTimeout;
      vi.stubGlobal("setTimeout", (fn, ms, ...rest) => { if (ms === 1_000) polls += 1; return fake(fn, ms, ...rest); });
      await import("node:fs/promises").then((fs) => fs.mkdir(process.env.SPARK_L402_HOLDS_PATH, { recursive: true }));
    });
    afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });
    const once = (fn) => { let ran = false; return async () => { if (polls >= 1 && !ran) { ran = true; await fn(); } }; };

    it("still buying after the wait: nothing fetched or paid, its claim kept, and a later call is called a second purchase", async () => {
      await live();
      const b = processWith();
      const seen = serve();
      const { error } = await settle(b.agent.fetchL402(URL_, { maxAmountSats: 3000 }));
      expect(error).toMatchObject({ code: "CONCURRENT_PAYMENT_ATTEMPT", retryable: "check-first" });
      expect(error.nextStep).toMatch(/still buying this resource.*second purchase/);
      expect(seen).toEqual([]);
      expect(b.wallet.payLightningInvoice).not.toHaveBeenCalled();
      expect(await holdFiles()).toHaveLength(1);
    });

    it("it finishes and removes its claim while this call waits: nothing paid here, and calling again is a second purchase", async () => {
      await live();
      const b = processWith();
      const seen = serve();
      const { unlink } = await import("node:fs/promises");
      const { error } = await settle(b.agent.fetchL402(URL_, { maxAmountSats: 3000 }), once(() => unlink(holdFile())));
      expect(error).toMatchObject({ code: "CONCURRENT_PAYMENT_ATTEMPT", reason: "L402_BOUGHT_ELSEWHERE" });
      expect(error.nextStep).toMatch(/Calling fetchL402 again is a second purchase/);
      expect(seen).toEqual([]);
      expect(b.wallet.payLightningInvoice).not.toHaveBeenCalled();
    });

    it("it ends with a hold while this call waits: calling again finishes that purchase", async () => {
      await live();
      const b = processWith();
      serve();
      const { error } = await settle(b.agent.fetchL402(URL_, { maxAmountSats: 3000 }),
        once(() => writeRecord({ state: "held", pid: process.ppid, updatedAt: Date.now(), paid: false })));
      expect(error).toMatchObject({ code: "CONCURRENT_PAYMENT_ATTEMPT" });
      expect(error.nextStep).toMatch(/finishes that held purchase/);
      expect(b.wallet.payLightningInvoice).not.toHaveBeenCalled();
    });
  });

  // Review 2026-11-09 (L402-3): a process finishing late removed the file
  // without looking whose it was, deleting another process's fresh claim.
  it("a process that finishes late doesn't delete another live process's fresh claim", async () => {
    await import("node:fs/promises").then((fs) => fs.mkdir(process.env.SPARK_L402_HOLDS_PATH, { recursive: true }));
    const a = processWith();
    let n = 0;
    vi.stubGlobal("fetch", async () => {
      n += 1;
      if (n === 1) return challenge();
      // Before this delivery returns, another process claims a new purchase of the same request.
      await writeRecord({ state: "buying", pid: process.ppid, updatedAt: Date.now(), macaroon: "macB" });
      return resp(200, { ok: true });
    });
    expect(await a.agent.fetchL402(URL_, { maxAmountSats: 3000 })).toMatchObject({ data: { ok: true } });
    expect(JSON.parse(await readFile(holdFile(), "utf8"))).toMatchObject({ state: "buying", macaroon: "macB" });
  });

  it("a claim older than ten minutes is finished even if its pid is alive (pids get reused)", async () => {
    await import("node:fs/promises").then((fs) => fs.mkdir(process.env.SPARK_L402_HOLDS_PATH, { recursive: true }));
    await writeRecord({ state: "buying", pid: process.ppid, updatedAt: Date.now() - 11 * 60_000 });
    const b = processWith();
    serve(resp(200, { ok: true }));
    expect(await b.agent.fetchL402(URL_, { maxAmountSats: 3000 })).toMatchObject({ data: { ok: true } });
  });

  it("a refusal before paying leaves no claim behind", async () => {
    const a = processWith();
    serve(challenge());
    await expect(a.agent.fetchL402(URL_, { maxAmountSats: 100 })).rejects.toMatchObject({ code: "AMOUNT_OVER_LIMIT" });
    process.env.SPARK_DAILY_BUDGET_SATS = "1000";
    process.env.SPARK_SPEND_LEDGER_PATH = join(await mkdtemp(join(tmpdir(), "l402-holds-ledger-")), "ledger.json");
    try {
      serve(challenge());
      await expect(processWith().agent.fetchL402(URL_, { maxAmountSats: 3000 })).rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
    } finally {
      delete process.env.SPARK_DAILY_BUDGET_SATS;
      delete process.env.SPARK_SPEND_LEDGER_PATH;
    }
    expect(await holdFiles()).toEqual([]);
  });
});

describe("fail closed", () => {
  it("an unreadable hold refuses the purchase (L402_HOLD_UNREADABLE), and status() lists it", async () => {
    await import("node:fs/promises").then((fs) => fs.mkdir(process.env.SPARK_L402_HOLDS_PATH, { recursive: true }));
    await writeFile(holdFile(), "{ not json");
    const b = processWith();
    const seen = serve();
    await expect(b.agent.fetchL402(URL_, { maxAmountSats: 3000 })).rejects.toMatchObject({ code: "L402_HOLD_UNREADABLE", retryable: "check-first" });
    expect(seen).toEqual([]);
    expect((await b.agent.status()).l402.held).toEqual([{ method: null, host: null, path: null, reason: "unreadable" }]);
  });

  it("a store that can't be used refuses before anything is fetched or paid", async () => {
    const notADir = join(await mkdtemp(join(tmpdir(), "l402-holds-file-")), "f");
    await writeFile(notADir, "x");
    process.env.SPARK_L402_HOLDS_PATH = notADir;
    const b = processWith();
    const seen = serve(challenge());
    const err = await b.agent.fetchL402(URL_, { maxAmountSats: 3000 }).catch((e) => e);
    expect(["L402_HOLD_UNREADABLE", "STORAGE_ERROR"]).toContain(err.code);
    expect(seen).toEqual([]);
    expect(b.wallet.payLightningInvoice).not.toHaveBeenCalled();
  });
});
