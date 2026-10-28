// agent.status() against Spark's hosted REGTEST, on a fresh throwaway wallet
// opened the way an agent opens one (SparkAgent.create): usable with no
// problems, privacy on (create() turned it on and status() reads it live),
// the backup written, the stream's state tracked from the SDK's events, an
// answer within a few seconds, and after cleanup() a closed report with no
// network call. No funds move; nothing is written outside a temp directory.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

const ENV = ["SPARK_SEED_PATH", "SPARK_LEAF_VAULT", "SPARK_LEAF_VAULT_PATH", "SPARK_PRIVACY", "SPARK_DAILY_BUDGET_SATS", "SPARK_SPEND_LEDGER_PATH"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe("status() on a fresh wallet (REGTEST)", () => {
  const saved = {};
  let dir, agent;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "status-regtest-"));
    for (const k of ENV) saved[k] = process.env[k];
    process.env.SPARK_SEED_PATH = join(dir, "no-seed.enc"); // the agent checks for a sealed seed: not the real one
    process.env.SPARK_LEAF_VAULT_PATH = join(dir, "leaf-vault", "current.json");
    for (const k of ["SPARK_LEAF_VAULT", "SPARK_PRIVACY", "SPARK_DAILY_BUDGET_SATS", "SPARK_SPEND_LEDGER_PATH"]) delete process.env[k];
    ({ agent } = await SparkAgent.create(generateMnemonic(wordlist), "REGTEST", { optimizeLeaves: false }));
  }, 90_000);

  afterAll(async () => {
    await agent?.cleanup().catch(() => {});
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  });

  it("usable, no problems, privacy on, answered within a few seconds", async () => {
    const started = performance.now();
    const s = await agent.status();
    const ms = performance.now() - started;
    console.log(`status() took ${Math.round(ms)} ms; spark ${s.connections.spark}`);
    expect(s).toMatchObject({
      schema: "sparkbtcbot.status.v1",
      usable: true,
      problems: [],
      nextStep: null,
      network: "REGTEST",
      balance: { sats: "0", incomingSats: "0", lockedSats: "0" },
      privacy: { state: "on" },
      backup: { state: "ok", ageMinutes: 0, lastError: null },
      budget: { state: "none" },
      connections: { lightning: "unchecked" },
    });
    expect(s.address).toMatch(/^sparkrt1/);
    expect(["connected", "connecting"]).toContain(s.connections.spark); // create() can return before the stream connects
    expect(ms).toBeLessThan(3_000);
  }, 30_000);

  it("tracks the stream from the events create() handed the SDK: connected within seconds", async () => {
    let s;
    for (let i = 0; i < 30; i++) {
      s = await agent.status();
      if (s.connections.spark === "connected") break;
      await sleep(500);
    }
    expect(s).toMatchObject({ usable: true, problems: [], connections: { spark: "connected" } });
  }, 60_000);

  it("checkLightning: the SSP answers", async () => {
    const s = await agent.status({ checkLightning: true });
    expect(s).toMatchObject({ usable: true, problems: [], connections: { lightning: "reachable" } });
  }, 30_000);

  it("after cleanup(): AGENT_CLOSED, with no network call (it answers at once)", async () => {
    const address = (await agent.status()).address;
    await agent.cleanup();
    const started = performance.now();
    const s = await agent.status({ checkLightning: true });
    expect(performance.now() - started).toBeLessThan(100);
    expect(s).toMatchObject({
      usable: false,
      problems: ["AGENT_CLOSED"],
      address,
      balance: null,
      backup: { state: "off" },
      connections: { spark: "closed", lightning: "unchecked" },
    });
  }, 30_000);
});
