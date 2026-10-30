// agent.status(): one look at whether the agent can work. The pins: the shape,
// every problem's trigger (and its threshold, one step either side), the
// things that are deliberately NOT problems, a closed agent that makes no
// network call, the read deadlines, and that status() never throws for what
// it finds. Mock wallets throughout; the stream events are the ones create()
// hands the SDK at construction, fired by hand. The live REGTEST runs are
// tests/integration/status.test.js and tests/integration/funded/status-incoming.test.js.
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { STATUS_PROBLEMS } from "../../lib/agent-errors.js";
import { testSparkAddress } from "../helpers/spark-address.js";
import { freshInvoice } from "../helpers/bolt11.js";

// The backup is the leaf-vault's; its health is what status() reads, so the
// module is replaced by one whose health() each test sets.
const vault = vi.hoisted(() => ({ health: null }));
vi.mock("../../skills/sparkbtcbot/scripts/leaf-vault.js", () => ({
  enableLeafVault: () => ({ ready: Promise.resolve({ ok: true }), dispose: async () => {}, health: () => vault.health }),
}));

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const ADDRESS = testSparkAddress("REGTEST");
const T0 = Date.parse("2026-10-28T12:00:00Z");
const MIN = 60_000;
const healthy = (over = {}) => ({
  healthy: true, lastSuccessAt: T0, consecutiveFailures: 0, consecutiveTransientSkips: 0,
  lastError: null, anchorless: [], intervalMs: 20 * MIN, maxConsecutiveFailures: 3, ...over,
});
const sats = (available, owned = available, incoming = 0n) => ({ satsBalance: { available, owned, incoming }, tokenBalances: new Map() });

const ENV = ["SPARK_SEED_PATH", "SPARK_LEAF_VAULT", "SPARK_PRIVACY", "SPARK_DAILY_BUDGET_SATS", "SPARK_SPEND_LEDGER_PATH"];
const saved = {};
let scratch;
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "agent-status-"));
  for (const k of ENV) saved[k] = process.env[k];
});
afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  await rm(scratch, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.SPARK_SEED_PATH = join(scratch, "no-seed.enc"); // off the real ~/.spark
  for (const k of ["SPARK_LEAF_VAULT", "SPARK_PRIVACY", "SPARK_DAILY_BUDGET_SATS", "SPARK_SPEND_LEDGER_PATH"]) delete process.env[k];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vault.health = healthy();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const at = (ms) => vi.setSystemTime(T0 + ms);

const mkWallet = (over = {}) => ({
  getSparkAddress: vi.fn(async () => ADDRESS),
  getBalance: vi.fn(async () => sats(1000n)),
  getWalletSettings: vi.fn(async () => ({ ownerIdentityPublicKey: "02ab", privateEnabled: true })),
  setPrivacyEnabled: vi.fn(async (enabled) => ({ ownerIdentityPublicKey: "02ab", privateEnabled: enabled })),
  getSwapFeeEstimate: vi.fn(async () => ({ feeEstimate: { originalValue: 1, originalUnit: "SATOSHI" } })),
  cleanup: vi.fn(async () => {}),
  ...over,
});

// SparkAgent.create over a mock wallet, keeping the `events` it handed the SDK.
async function open(wallet = mkWallet(), network = "REGTEST") {
  let options;
  vi.spyOn(SparkWallet, "initialize").mockImplementation(async (args) => {
    options = args.options;
    return { wallet, mnemonic: undefined };
  });
  const { agent } = await SparkAgent.create("word ".repeat(12).trim(), network);
  const emit = (name, ...args) => options.events[name](...args);
  // The SDK emits stream:disconnected from cleanup(), just before it drops
  // every listener.
  wallet.cleanup.mockImplementation(async () => emit("stream:disconnected", "Wallet cleanup requested"));
  return { agent, wallet, emit, options };
}
const connected = async (wallet) => {
  const opened = await open(wallet);
  opened.emit("stream:connected");
  return opened;
};

describe("status(): a healthy agent", () => {
  it("reports every field, with no problems and no nextStep", async () => {
    const { agent } = await connected();
    expect(await agent.status()).toEqual({
      schema: "sparkbtcbot.status.v1",
      usable: true,
      problems: [],
      nextStep: null,
      checkedAt: new Date(T0).toISOString(),
      network: "REGTEST",
      address: ADDRESS,
      balance: { sats: "1000", incomingSats: "0", lockedSats: "0" },
      privacy: { state: "on", checkedAt: new Date(T0).toISOString() },
      backup: { state: "ok", ageMinutes: 0, lastError: null },
      budget: { state: "none", sealed: false, budgetSats: null, spentSats: null, remainingSats: null, windowHours: null, nextReleaseAt: null },
      limits: { state: "none" },
      l402: { held: [] },
      connections: { spark: "connected", lightning: "unchecked" },
    });
  });

  it("create() hands the SDK the stream and balance events at construction, before the stream can connect", async () => {
    const { options } = await open();
    expect(Object.keys(options.events).sort()).toEqual(["balance:update", "stream:connected", "stream:disconnected", "stream:reconnecting"]);
    expect(options.optimizationOptions).toEqual({ auto: true }); // the other options are untouched
  });

  it("reads the balance fresh, the privacy setting live, and nothing from the SSP by default", async () => {
    const { agent, wallet } = await connected();
    wallet.getBalance.mockClear();
    wallet.getWalletSettings.mockClear();
    await agent.status();
    expect(wallet.getBalance).toHaveBeenCalledTimes(1);
    expect(wallet.getWalletSettings).toHaveBeenCalledTimes(1);
    expect(wallet.getSwapFeeEstimate).not.toHaveBeenCalled();
  });
});

describe("status(): neutral states are never problems", () => {
  it("no budget, Lightning unchecked", async () => {
    const s = await (await connected()).agent.status();
    expect(s.budget.state).toBe("none");
    expect(s.connections.lightning).toBe("unchecked");
    expect(s.problems).toEqual([]);
  });

  it("privacy off by the user's choice (SPARK_PRIVACY=off), without reading the setting", async () => {
    process.env.SPARK_PRIVACY = "off";
    const { agent, wallet } = await connected(mkWallet({ getWalletSettings: vi.fn(async () => ({ privateEnabled: false })) }));
    const s = await agent.status();
    expect(s.privacy).toEqual({ state: "off-by-choice", checkedAt: null });
    expect(s.problems).toEqual([]);
    expect(wallet.getWalletSettings).not.toHaveBeenCalled();
  });

  it("a viewer key granted", async () => {
    const wallet = mkWallet({ getWalletSettings: vi.fn(async () => ({ ownerIdentityPublicKey: "02ab", privateEnabled: true, viewerIdentityPublicKey: "03cd" })) });
    const s = await (await connected(wallet)).agent.status();
    expect(s.privacy.state).toBe("on");
    expect(s.problems).toEqual([]);
  });

  it("the backup turned off, or on its first snapshot", async () => {
    process.env.SPARK_LEAF_VAULT = "off";
    let s = await (await connected()).agent.status();
    expect(s.backup).toEqual({ state: "off", ageMinutes: null, lastError: null });
    expect(s.problems).toEqual([]);
    delete process.env.SPARK_LEAF_VAULT;
    vault.health = healthy({ healthy: false, lastSuccessAt: null });
    s = await (await connected()).agent.status();
    expect(s.backup).toEqual({ state: "starting", ageMinutes: null, lastError: null });
    expect(s.problems).toEqual([]);
  });

  it("the stream connecting for under 30 s", async () => {
    const { agent } = await open(); // no stream:connected yet
    at(30_000 - 1);
    const s = await agent.status();
    expect(s.connections.spark).toBe("connecting");
    expect(s.problems).toEqual([]);
  });

  it("sats incoming for under a minute, locked for under 30 minutes", async () => {
    const { agent, emit } = await connected(mkWallet({ getBalance: vi.fn(async () => sats(700n, 1000n, 300n)) }));
    emit("balance:update", { available: 700n, owned: 1000n, incoming: 300n });
    at(MIN - 1);
    const s = await agent.status();
    expect(s.balance).toEqual({ sats: "700", incomingSats: "300", lockedSats: "300" });
    expect(s.problems).toEqual([]);
    at(30 * MIN - 1);
    expect((await agent.status()).problems).not.toContain("BALANCE_LOCKED");
  });
});

describe("status(): AGENT_CLOSED", () => {
  it("after cleanup(): blocking, and no network call at all, even with checkLightning", async () => {
    const { agent, wallet } = await connected();
    await agent.status(); // the address is remembered from here
    await agent.cleanup();
    for (const fn of ["getSparkAddress", "getBalance", "getWalletSettings", "getSwapFeeEstimate"]) wallet[fn].mockClear();
    const s = await agent.status({ checkLightning: true });
    for (const fn of ["getSparkAddress", "getBalance", "getWalletSettings", "getSwapFeeEstimate"]) expect(wallet[fn], fn).not.toHaveBeenCalled();
    expect(s).toMatchObject({
      usable: false,
      problems: ["AGENT_CLOSED"],
      nextStep: STATUS_PROBLEMS.AGENT_CLOSED.nextStep,
      address: ADDRESS,
      balance: null,
      privacy: { state: "unknown", checkedAt: null },
      connections: { spark: "closed", lightning: "unchecked" }, // not the SDK's last "disconnected"
    });
  });

  it("the backup reads off once the agent is closed", async () => {
    const { agent } = await connected();
    await agent.cleanup();
    at(5 * MIN);
    expect((await agent.status()).backup).toEqual({ state: "off", ageMinutes: 5, lastError: null });
  });

  // ToB review 2026-10-28 (F22): only status() knew the agent was closed. The
  // SDK recreates its clients on demand, so reads, receives and sends still
  // reached Spark after cleanup(), with the backup already stopped.
  it("after cleanup(): money methods refuse before any call, anything else is AGENT_CLOSED, and a second cleanup() does nothing", async () => {
    const { agent, wallet } = await connected();
    await Promise.all([agent.cleanup(), agent.cleanup()]);
    await agent.cleanup();
    expect(wallet.cleanup).toHaveBeenCalledTimes(1);
    for (const fn of Object.values(wallet)) if (vi.isMockFunction(fn)) fn.mockClear();
    const fetched = vi.fn();
    vi.stubGlobal("fetch", fetched);
    try {
      const other = testSparkAddress("REGTEST", "02c6047f9441ed7d6d3045406e95c07cd85c778e4b8cef3ca7abac09b95c709ee5");
      for (const [name, call] of [
        ["transfer", () => agent.transfer({ to: other, amount: 100 })],
        ["fetchL402", () => agent.fetchL402("https://api.example/paid", { maxAmountSats: 3000 })],
      ]) {
        await expect(call(), name).rejects.toMatchObject({ code: "AGENT_CLOSED", retryable: "no", message: expect.stringMatching(/Nothing was sent/) });
      }
      await expect(agent.getBalance()).rejects.toMatchObject({ code: "AGENT_CLOSED", retryable: "check-first" });
      await expect(agent.createLightningInvoice(1000, "after close")).rejects.toMatchObject({ code: "AGENT_CLOSED" });
      for (const [name, fn] of Object.entries(wallet)) if (vi.isMockFunction(fn)) expect(fn, name).not.toHaveBeenCalled();
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("status(): SPARK_UNREACHABLE", () => {
  it("the balance read fails: blocking, balance null", async () => {
    const { agent } = await connected(mkWallet({ getBalance: vi.fn(async () => { throw new Error("UNAVAILABLE"); }) }));
    const s = await agent.status();
    expect(s).toMatchObject({ usable: false, problems: ["SPARK_UNREACHABLE"], balance: null, nextStep: STATUS_PROBLEMS.SPARK_UNREACHABLE.nextStep });
  });

  it("an answer without the sats figures counts as no answer", async () => {
    const { agent } = await connected(mkWallet({ getBalance: vi.fn(async () => ({})) }));
    expect((await agent.status()).problems).toEqual(["SPARK_UNREACHABLE"]);
  });

  it("the balance read takes 10 s: reported, and its late rejection is caught", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(T0);
    let late;
    const wallet = mkWallet({ getBalance: vi.fn(() => new Promise((_, reject) => { late = reject; })) });
    const { agent } = await connected(wallet);
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let done = false;
      const pending = agent.status().then((s) => { done = true; return s; });
      await vi.advanceTimersByTimeAsync(10_000 - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      const s = await pending;
      expect(s.problems).toEqual(["SPARK_UNREACHABLE"]);
      expect(s.privacy.state).toBe("on"); // the settings read answered in time
      late(new Error("UNAVAILABLE, eventually"));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("status(): NETWORK_MISMATCH", () => {
  it("the agent's network isn't its wallet address's: blocking", async () => {
    const s = await new SparkAgent(mkWallet(), "MAINNET").status();
    expect(s).toMatchObject({ usable: false, network: "MAINNET", address: ADDRESS, problems: ["NETWORK_MISMATCH"] });
  });

  it("an agent constructed without a network", async () => {
    const s = await new SparkAgent(mkWallet()).status();
    expect(s).toMatchObject({ usable: false, network: null, problems: ["NETWORK_MISMATCH"] });
  });
});

describe("status(): SPARK_STREAM_DOWN", () => {
  it("not connected 30 s after opening; degraded, not blocking", async () => {
    const { agent } = await open();
    at(30_000);
    const s = await agent.status();
    expect(s).toMatchObject({ usable: true, problems: ["SPARK_STREAM_DOWN"], connections: { spark: "connecting" } });
  });

  it("a drop counts from the drop, and reconnect attempts don't restart the count", async () => {
    const { agent, emit } = await open();
    at(10 * MIN);
    emit("stream:connected");
    at(10 * MIN + 5_000);
    emit("stream:reconnecting", 1, Infinity, 1000, "heartbeat timeout");
    at(10 * MIN + 25_000);
    emit("stream:reconnecting", 2, Infinity, 2000, "heartbeat timeout");
    at(10 * MIN + 35_000 - 1);
    expect((await agent.status()).problems).toEqual([]);
    at(10 * MIN + 35_000);
    expect((await agent.status()).problems).toEqual(["SPARK_STREAM_DOWN"]);
    emit("stream:connected");
    expect((await agent.status())).toMatchObject({ problems: [], connections: { spark: "connected" } });
  });

  it("stream:disconnected without cleanup(): the stream won't retry", async () => {
    const { agent, emit } = await connected();
    emit("stream:disconnected", "gone");
    at(30_000);
    expect(await agent.status()).toMatchObject({ problems: ["SPARK_STREAM_DOWN"], connections: { spark: "disconnected" } });
  });

  it("an agent around a wallet opened elsewhere can't know: 'unknown', never down", async () => {
    process.env.SPARK_LEAF_VAULT = "off"; // an hour on, the backup is stale; not under test
    const agent = new SparkAgent(mkWallet(), "REGTEST");
    at(60 * MIN);
    expect(await agent.status()).toMatchObject({ problems: [], connections: { spark: "unknown" } });
  });
});

describe("status(): INCOMING_UNCLAIMED", () => {
  const incoming = () => mkWallet({ getBalance: vi.fn(async () => sats(0n, 0n, 300n)) });

  it("incoming for 60 s while the stream is connected", async () => {
    const { agent, emit } = await connected(incoming());
    emit("balance:update", { available: 0n, owned: 0n, incoming: 300n });
    at(MIN - 1);
    expect((await agent.status()).problems).toEqual([]);
    at(MIN);
    const s = await agent.status();
    expect(s).toMatchObject({ usable: true, problems: ["INCOMING_UNCLAIMED"], balance: { incomingSats: "300" } });
    expect(s.nextStep).toMatch(/not lost/);
  });

  it("the wait counts from when the stream connected, since that's when the SDK claims", async () => {
    const { agent, emit } = await open(incoming());
    emit("balance:update", { available: 0n, owned: 0n, incoming: 300n }); // at boot
    at(29_000);
    emit("stream:connected");
    at(29_000 + MIN - 1);
    expect((await agent.status()).problems).toEqual([]);
    at(29_000 + MIN);
    expect((await agent.status()).problems).toEqual(["INCOMING_UNCLAIMED"]);
  });

  it("while the stream is down, SPARK_STREAM_DOWN explains it instead", async () => {
    const { agent, emit } = await open(incoming());
    emit("balance:update", { available: 0n, owned: 0n, incoming: 300n });
    at(5 * MIN);
    expect((await agent.status()).problems).toEqual(["SPARK_STREAM_DOWN"]);
  });

  it("a claim clears it", async () => {
    let figures = sats(0n, 0n, 300n);
    const { agent, emit } = await connected(mkWallet({ getBalance: vi.fn(async () => figures) }));
    emit("balance:update", { available: 0n, owned: 0n, incoming: 300n });
    at(50_000);
    emit("balance:update", { available: 300n, owned: 300n, incoming: 0n });
    figures = sats(300n);
    at(2 * MIN);
    expect((await agent.status()).problems).toEqual([]);
  });

  it("without create(), counted from the first status() that saw it", async () => {
    const agent = new SparkAgent(incoming(), "REGTEST");
    expect((await agent.status()).problems).toEqual([]);
    at(MIN);
    expect((await agent.status()).problems).toEqual(["INCOMING_UNCLAIMED"]);
  });
});

describe("status(): BALANCE_LOCKED", () => {
  it("lockedSats above 0 for 30 minutes", async () => {
    const { agent, emit } = await connected(mkWallet({ getBalance: vi.fn(async () => sats(700n, 1000n)) }));
    emit("balance:update", { available: 700n, owned: 1000n, incoming: 0n });
    at(30 * MIN);
    const s = await agent.status();
    expect(s).toMatchObject({ usable: true, problems: ["BALANCE_LOCKED"], balance: { lockedSats: "300" } });
    expect(s.nextStep).toMatch(/getTransfers\(\).*If the check itself fails, don't pay; check again later\.$/);
  });
});

describe("status(): LIGHTNING_UNREACHABLE (only with checkLightning)", () => {
  it("probes the SSP with a 1,000-sat swap fee estimate", async () => {
    const { agent, wallet } = await connected();
    expect((await agent.status({ checkLightning: true })).connections.lightning).toBe("reachable");
    expect(wallet.getSwapFeeEstimate).toHaveBeenCalledWith(1000);
  });

  it("a failed probe: degraded", async () => {
    const { agent } = await connected(mkWallet({ getSwapFeeEstimate: vi.fn(async () => { throw new Error("fetch failed"); }) }));
    expect(await agent.status({ checkLightning: true })).toMatchObject({
      usable: true, problems: ["LIGHTNING_UNREACHABLE"], connections: { lightning: "unreachable" },
    });
  });

  it("a probe that takes 5 s; its late rejection is caught", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
    vi.setSystemTime(T0);
    let late;
    const { agent } = await connected(mkWallet({ getSwapFeeEstimate: vi.fn(() => new Promise((_, reject) => { late = reject; })) }));
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const pending = agent.status({ checkLightning: true });
      await vi.advanceTimersByTimeAsync(5_000);
      expect((await pending).problems).toEqual(["LIGHTNING_UNREACHABLE"]);
      late(new Error("SSP gave up"));
      await new Promise((r) => setImmediate(r));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("status(): BACKUP_BROKEN and BACKUP_STALE", () => {
  const backup = async (health, ms = 0) => {
    vault.health = health;
    const { agent } = await connected();
    at(ms);
    return agent.status();
  };

  it.each([
    ["leaves the exit tool can't fee-bump", { anchorless: ["leaf-1"] }],
    ["3 failures in a row", { consecutiveFailures: 3, lastError: "EACCES" }],
    ["3 empty reads in a row while funded", { consecutiveTransientSkips: 3 }],
    ["failed and never succeeded", { lastSuccessAt: null, consecutiveFailures: 1 }],
    ["the vault's own threshold", { consecutiveFailures: 2, maxConsecutiveFailures: 2 }],
  ])("broken: %s", async (_, over) => {
    const s = await backup(healthy({ healthy: false, ...over }));
    expect(s).toMatchObject({ usable: true, problems: ["BACKUP_BROKEN"], backup: { state: "broken" } });
  });

  it("stale after one failure, with the error", async () => {
    const s = await backup(healthy({ consecutiveFailures: 1, lastError: "disk full" }));
    expect(s).toMatchObject({ problems: ["BACKUP_STALE"], backup: { state: "stale", ageMinutes: 0, lastError: "disk full" } });
  });

  it("stale past two timer periods plus 5 minutes (45 at the default 20)", async () => {
    expect((await backup(healthy(), 45 * MIN + 59_999)).backup).toEqual({ state: "ok", ageMinutes: 45, lastError: null });
    expect((await backup(healthy(), 46 * MIN)).backup.state).toBe("stale");
    expect((await backup(healthy({ intervalMs: 10 * MIN }), 26 * MIN)).backup.state).toBe("stale");
  });
});

describe("status(): PRIVACY_OFF", () => {
  const privacy = async (getWalletSettings) => {
    const wallet = mkWallet();
    const opened = await connected(wallet); // create() turned it on; now it reads otherwise
    wallet.getWalletSettings = getWalletSettings;
    return opened.agent.status();
  };

  it("the setting is off though privacy is wanted", async () => {
    expect(await privacy(vi.fn(async () => ({ privateEnabled: false })))).toMatchObject({
      usable: true, problems: ["PRIVACY_OFF"], privacy: { state: "off", checkedAt: new Date(T0).toISOString() },
    });
  });

  it("no settings row is the public default", async () => {
    expect((await privacy(vi.fn(async () => undefined))).privacy.state).toBe("off");
  });

  // ToB review 2026-10-28: only the coordinator answers the settings read, so
  // it can fail while the balance read works; that went unreported.
  it("a failed read with the balance answered is PRIVACY_UNKNOWN (degraded)", async () => {
    const s = await privacy(vi.fn(async () => { throw new Error("UNAVAILABLE"); }));
    expect(s).toMatchObject({ usable: true, problems: ["PRIVACY_UNKNOWN"], privacy: { state: "unknown", checkedAt: null } });
    expect(s.nextStep).toMatch(/may be publicly readable.*change SPARK_PRIVACY only when the user asks/);
  });

  it("with the balance unanswered too, SPARK_UNREACHABLE says why and PRIVACY_UNKNOWN stays out", async () => {
    const wallet = mkWallet();
    const { agent } = await connected(wallet);
    wallet.getWalletSettings = vi.fn(async () => { throw new Error("UNAVAILABLE"); });
    wallet.getBalance = vi.fn(async () => { throw new Error("UNAVAILABLE"); });
    expect((await agent.status()).problems).toEqual(["SPARK_UNREACHABLE"]);
  });

  it("off by the user's choice is never unknown", async () => {
    process.env.SPARK_PRIVACY = "off";
    const { agent } = await connected();
    expect(await agent.status()).toMatchObject({ problems: [], privacy: { state: "off-by-choice" } });
  });
});

describe("status(): the spend budget", () => {
  const ledgerAt = async (doc) => {
    const path = join(await mkdtemp(join(scratch, "ledger-")), "ledger.json");
    if (doc !== undefined) await writeFile(path, typeof doc === "string" ? doc : JSON.stringify(doc));
    process.env.SPARK_SPEND_LEDGER_PATH = path;
    return path;
  };
  const entry = (id, ts, n) => ({ id, ts, sats: n, operation: "spark_transfer" });

  it("within the budget: ok, with when the oldest spend leaves the window", async () => {
    process.env.SPARK_DAILY_BUDGET_SATS = "1000";
    await ledgerAt({ version: 1, entries: [entry("a", T0 - 3 * 3_600_000, 300), entry("b", T0 - 3_600_000, 100)] });
    const s = await (await connected()).agent.status();
    expect(s.problems).toEqual([]);
    expect(s.budget).toEqual({
      state: "ok", sealed: false, budgetSats: 1000, spentSats: 400, remainingSats: 600, windowHours: 24,
      nextReleaseAt: new Date(T0 - 3 * 3_600_000 + 24 * 3_600_000).toISOString(),
    });
  });

  it("BUDGET_EXHAUSTED: degraded (receiving still works)", async () => {
    process.env.SPARK_DAILY_BUDGET_SATS = "1000";
    await ledgerAt({ version: 1, entries: [entry("a", T0 - 3_600_000, 1000)] });
    const s = await (await connected()).agent.status();
    expect(s).toMatchObject({ usable: true, problems: ["BUDGET_EXHAUSTED"], budget: { state: "exhausted", remainingSats: 0 } });
    expect(s.nextStep).toMatch(/budget\.nextReleaseAt/);
  });

  it("an unreadable ledger is the SPEND_LEDGER_* code every send would throw", async () => {
    process.env.SPARK_DAILY_BUDGET_SATS = "1000";
    await ledgerAt("{ not json");
    const s = await (await connected()).agent.status();
    expect(s).toMatchObject({ usable: true, problems: ["SPEND_LEDGER_UNREADABLE"], budget: { state: "broken", budgetSats: 1000 } });
    expect(s.nextStep).toBe(STATUS_PROBLEMS.SPEND_LEDGER_UNREADABLE.nextStep);
  });

  it("a ledger the system won't read (STORAGE_ERROR) reads as unreadable", async () => {
    process.env.SPARK_DAILY_BUDGET_SATS = "1000";
    const path = await ledgerAt();
    await mkdir(path); // a directory: EISDIR
    expect((await (await connected()).agent.status()).problems).toEqual(["SPEND_LEDGER_UNREADABLE"]);
  });

  it("a sealed budget whose ledger is missing: SPEND_LEDGER_MISSING, sealed true", async () => {
    await ledgerAt();
    const agent = new SparkAgent(mkWallet(), "REGTEST", { seedContext: { policy: { dailyBudgetSats: 5000 }, ledgerHmacKey: Buffer.alloc(32, 7) } });
    expect(await agent.status()).toMatchObject({
      problems: ["SPEND_LEDGER_MISSING"], budget: { state: "broken", sealed: true, budgetSats: 5000, windowHours: 24 },
    });
  });
});

describe("status(): the user's spending limits", () => {
  const limitsAt = async (doc) => {
    const path = join(await mkdtemp(join(scratch, "limits-")), "limits.json");
    if (doc !== undefined) await writeFile(path, typeof doc === "string" ? doc : JSON.stringify(doc));
    process.env.SPARK_LIMITS_PATH = path;
  };
  const before = process.env.SPARK_LIMITS_PATH;
  afterEach(() => { process.env.SPARK_LIMITS_PATH = before; });

  it("shows the rules; a daily limit is the budget, the tighter of it and the env budget", async () => {
    await limitsAt({ dailyBudgetSats: 600, maxPaymentSats: 200, allowedOps: ["spark_transfer"] });
    process.env.SPARK_SPEND_LEDGER_PATH = join(await mkdtemp(join(scratch, "ledger-")), "ledger.json");
    let s = await (await connected()).agent.status();
    expect(s.problems).toEqual([]);
    expect(s.limits).toEqual({ state: "set", dailyBudgetSats: 600, maxPaymentSats: 200, allowedOps: ["spark_transfer"] });
    expect(s.budget).toMatchObject({ state: "ok", sealed: false, budgetSats: 600, spentSats: 0, remainingSats: 600 });
    process.env.SPARK_DAILY_BUDGET_SATS = "400";
    s = await (await connected()).agent.status();
    expect(s.budget).toMatchObject({ budgetSats: 400, remainingSats: 400 });
  });

  it("LIMITS_UNREADABLE: degraded, and its nextStep says to ask the user, not to delete the file", async () => {
    await limitsAt("{ not json");
    const s = await (await connected()).agent.status();
    expect(s).toMatchObject({ usable: true, problems: ["LIMITS_UNREADABLE"], limits: { state: "unreadable" } });
    expect(s.nextStep).toMatch(/ask them to state their limits again/);
    expect(s.nextStep).toMatch(/Don't delete the file/);
  });
});

// ToB review 2026-10-28: the restart problems' nextSteps restarted the
// process with L402 purchases held in memory, so a paid, undelivered pass was
// lost and the next process bought again. Holds are on disk now
// (lib/l402-holds.js); status() still lists the unfinished ones.
describe("status(): L402_HELD", () => {
  afterEach(() => vi.unstubAllGlobals());
  const holdOne = async (agent) => {
    const md = await readFile(join(ROOT, "node_modules/light-bolt11-decoder/README.md"), "utf8");
    const invoice = freshInvoice(md.match(/lnbc20u[a-z0-9]+/)[0]);
    vi.stubGlobal("fetch", async () => ({ status: 402, headers: { get: () => "application/json" }, json: async () => ({ invoice, macaroon: "mac-secret" }), text: async () => "" }));
    await expect(agent.fetchL402("https://api.example/paid?key=SECRET", { maxAmountSats: 3000 })).rejects.toMatchObject({ code: "PAYMENT_COMMITTED" });
  };
  const payWallet = () => mkWallet({
    getLightningSendFeeEstimate: vi.fn(async () => 5),
    payLightningInvoice: vi.fn(async () => { throw new Error("deadline exceeded"); }),
  });

  it("lists each held purchase without its secrets or query string, ranked above the restart problems", async () => {
    const { agent, emit } = await connected(payWallet());
    await holdOne(agent);
    emit("stream:disconnected", "gone");
    at(31_000);
    const s = await agent.status();
    expect(s.problems).toEqual(["L402_HELD", "SPARK_STREAM_DOWN"]);
    expect(s.l402).toEqual({ held: [{ method: "GET", host: "api.example", path: "/paid", reason: "pending" }] });
    expect(JSON.stringify(s)).not.toMatch(/mac-secret|SECRET/);
    expect(s.nextStep).toBe(STATUS_PROBLEMS.L402_HELD.nextStep);
    expect(s.nextStep).toMatch(/call fetchL402 again for each, same URL and method, to finish it without paying again/);
  });

  it("a closed agent holds nothing it can finish", async () => {
    const { agent } = await connected(payWallet());
    await holdOne(agent);
    await agent.cleanup();
    expect((await agent.status()).l402).toEqual({ held: [] });
  });
});

describe("status(): order, nextStep, and never throwing for what it finds", () => {
  it("lists problems most severe first, and gives the first one's nextStep", async () => {
    process.env.SPARK_DAILY_BUDGET_SATS = "1000";
    const path = join(await mkdtemp(join(scratch, "ledger-")), "ledger.json");
    await writeFile(path, JSON.stringify({ version: 1, entries: [{ id: "a", ts: T0, sats: 1000, operation: "x" }] }));
    process.env.SPARK_SPEND_LEDGER_PATH = path;
    vault.health = healthy({ healthy: false, anchorless: ["leaf-1"] });
    const wallet = mkWallet();
    const { agent } = await connected(wallet);
    wallet.getBalance = vi.fn(async () => { throw new Error("UNAVAILABLE"); });
    wallet.getWalletSettings = vi.fn(async () => ({ privateEnabled: false }));
    wallet.getSwapFeeEstimate = vi.fn(async () => { throw new Error("fetch failed"); });
    const s = await agent.status({ checkLightning: true });
    expect(s.problems).toEqual(["SPARK_UNREACHABLE", "LIGHTNING_UNREACHABLE", "BACKUP_BROKEN", "PRIVACY_OFF", "BUDGET_EXHAUSTED"]);
    expect(s.usable).toBe(false);
    expect(s.nextStep).toBe(STATUS_PROBLEMS.SPARK_UNREACHABLE.nextStep);
  });

  it("a broken ledger outranks a stream that is down: every send would throw", async () => {
    process.env.SPARK_DAILY_BUDGET_SATS = "1000";
    const path = join(await mkdtemp(join(scratch, "ledger-")), "ledger.json");
    await writeFile(path, "{ not json");
    process.env.SPARK_SPEND_LEDGER_PATH = path;
    const { agent } = await open();
    at(30_000);
    const s = await agent.status();
    expect(s.problems).toEqual(["SPEND_LEDGER_UNREADABLE", "SPARK_STREAM_DOWN"]);
    expect(s.nextStep).toBe(STATUS_PROBLEMS.SPEND_LEDGER_UNREADABLE.nextStep);
  });

  it("a wallet with nothing to call, or whose calls throw: a report, not a throw", async () => {
    expect(await new SparkAgent({}, "REGTEST").status()).toMatchObject({ usable: false, address: null, balance: null, problems: ["SPARK_UNREACHABLE"] });
    const boom = () => { throw new TypeError("boom"); };
    const s = await new SparkAgent({ getSparkAddress: boom, getBalance: boom, getWalletSettings: boom, getSwapFeeEstimate: boom }, "REGTEST")
      .status({ checkLightning: true });
    expect(s.problems).toEqual(["SPARK_UNREACHABLE", "LIGHTNING_UNREACHABLE"]);
  });

  it("an unknown option or a non-boolean checkLightning is BAD_INPUT, before any call", async () => {
    const wallet = mkWallet();
    const agent = new SparkAgent(wallet, "REGTEST");
    await expect(agent.status({ checkLightening: true })).rejects.toMatchObject({ code: "BAD_INPUT", retryable: "no", field: "checkLightening" });
    await expect(agent.status({ checkLightning: "yes" })).rejects.toMatchObject({ code: "BAD_INPUT", field: "checkLightning" });
    expect(wallet.getBalance).not.toHaveBeenCalled();
  });

  // ToB review 2026-10-28: AGENT_CLOSED and NETWORK_MISMATCH sent the agent
  // to an in-process create(), which ends at NO_PASSPHRASE (the first open
  // cleared it). Reopening means restarting the process.
  it("every nextStep that reopens the wallet says to restart the process", () => {
    for (const [code, { nextStep }] of Object.entries(STATUS_PROBLEMS)) {
      if (/\b(re)?open|SparkAgent\.create/i.test(nextStep)) expect(nextStep, code).toMatch(/restart the agent's process/);
    }
    expect(STATUS_PROBLEMS.NETWORK_MISMATCH.nextStep).toMatch(/set SPARK_NETWORK to it only on their answer/);
  });

  it("every problem it can report is in STATUS_PROBLEMS; exactly three block", () => {
    expect(Object.entries(STATUS_PROBLEMS).filter(([, p]) => p.blocking).map(([c]) => c)).toEqual(["AGENT_CLOSED", "SPARK_UNREACHABLE", "NETWORK_MISMATCH"]);
    expect(Object.keys(STATUS_PROBLEMS).sort()).toEqual([
      "AGENT_CLOSED", "BACKUP_BROKEN", "BACKUP_STALE", "BALANCE_LOCKED", "BUDGET_EXHAUSTED", "INCOMING_UNCLAIMED",
      "L402_HELD", "LIGHTNING_UNREACHABLE", "LIMITS_UNREADABLE", "NETWORK_MISMATCH", "PRIVACY_OFF", "PRIVACY_UNKNOWN", "SPARK_STREAM_DOWN", "SPARK_UNREACHABLE",
      "SPEND_LEDGER_BAD_SIGNATURE", "SPEND_LEDGER_MISSING", "SPEND_LEDGER_UNREADABLE",
    ]);
  });
});

// Claiming is the SDK's: its claimTransfers() and startPeriodicClaimTransfers()
// are private in its types, and whether to call them is a decision not made
// (status() reports INCOMING_UNCLAIMED instead).
it("SparkAgent doesn't call the SDK's private claim methods", async () => {
  const src = await readFile(join(ROOT, "skills/sparkbtcbot/scripts/spark-agent.js"), "utf8");
  expect(src).not.toMatch(/\.claimTransfers\(|startPeriodicClaimTransfers/);
});
