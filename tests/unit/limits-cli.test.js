// `sparkbtcbot limits`: the chat-only way to set the user's spending limits.
// Runs piped (no TTY, no passphrase), as a hosted agent runs it; says when a
// change loosens a limit and how to put it back; fails closed on bad input
// and on a file it can't read.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readFile, writeFile, access } from "node:fs/promises";

const run = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "../../skills/sparkbtcbot/scripts/cli.js");

let dir;
let path;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "limits-cli-"));
  path = join(dir, "limits.json");
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const limitsWith = (env, ...args) =>
  run("node", [CLI, "limits", ...args], {
    env: { ...process.env, SPARK_LIMITS_PATH: path, SPARK_SEED_PATH: join(dir, "no-seed.enc"), SPARK_DAILY_BUDGET_SATS: "", ...env },
  }).then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));
const limits = (...args) => limitsWith({}, ...args);
const onDisk = async () => JSON.parse(await readFile(path, "utf8"));
const exists = () => access(path).then(() => true, () => false);

describe("sparkbtcbot limits", () => {
  it("shows none when nothing is set", async () => {
    const r = await limits();
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/daily budget:\s+none/);
    expect(r.stdout).toMatch(/operations:\s+all/);
    expect(await exists()).toBe(false);
  });

  it("set writes the named rules and marks a new limit tighter", async () => {
    const r = await limits("set", "--daily-budget", "20000", "--max-payment=5000");
    expect(r.code).toBe(0);
    expect(await onDisk()).toMatchObject({ dailyBudgetSats: 20000, maxPaymentSats: 5000, updatedAt: expect.any(String) });
    expect(r.stdout).toMatch(/Changed dailyBudgetSats: none -> 20000 sats \(tighter\)/);
    expect(r.stdout).not.toMatch(/LOOSE/);
    expect(r.stdout).toMatch(/no restart needed/);
  });

  it("a looser change says so and prints the command that puts it back", async () => {
    await limits("set", "--daily-budget", "20000", "--ops", "spark_transfer,lightning_pay");
    let r = await limits("set", "--daily-budget", "50000");
    expect(r.stdout).toMatch(/Changed dailyBudgetSats: 20000 sats -> 50000 sats \(LOOSER\)/);
    expect(r.stdout).toMatch(/only because the user asked for this change in their own message, after being told what it unblocks/);
    expect(r.stdout).toMatch(/put it back now: sparkbtcbot limits set --daily-budget 20000$/m);
    expect(await onDisk()).toMatchObject({ dailyBudgetSats: 50000, allowedOps: ["spark_transfer", "lightning_pay"] });
    r = await limits("set", "--ops", "all");
    expect(r.stdout).toMatch(/put it back now: sparkbtcbot limits set --ops spark_transfer,lightning_pay$/m);
    expect((await onDisk()).allowedOps).toBeUndefined();
  });

  it("clear removes the file, every removal marked looser", async () => {
    await limits("set", "--max-payment", "100");
    const r = await limits("clear");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Changed maxPaymentSats: 100 sats -> none \(LOOSER\)/);
    expect(r.stdout).toMatch(/put it back now: sparkbtcbot limits set --max-payment 100/);
    expect(await exists()).toBe(false);
  });

  it("notes that Lightning has no address to check when recipients are limited", async () => {
    const r = await limits("set", "--recipients", "bcrt1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq");
    expect(r.stdout).toMatch(/leave lightning_pay out of --ops/);
  });

  it("refuses bad input and writes nothing", async () => {
    for (const args of [["set"], ["set", "--daily-budgett", "5"], ["set", "--daily-budget", "0"], ["set", "--daily-budget", "1e3"], ["set", "--max-payment"], ["bogus"], ["show", "x"]]) {
      const r = await limits(...args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr).toMatch(/Usage: sparkbtcbot limits/);
    }
    const r = await limits("set", "--ops", "spark_transfer,steal");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/unknown operation\(s\) steal/);
    expect(await exists()).toBe(false);
  });

  it("an unreadable file: a partial set refuses, a full set or clear replaces it", async () => {
    await writeFile(path, "{ not json");
    let r = await limits("set", "--daily-budget", "1000");
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Nothing changed\. Ask the user to state all their limits again/);
    expect(await readFile(path, "utf8")).toBe("{ not json");
    r = await limits("set", "--daily-budget", "1000", "--max-payment", "none", "--ops", "all", "--recipients", "any");
    expect(r.code).toBe(0);
    expect(await onDisk()).toMatchObject({ dailyBudgetSats: 1000 });
    await writeFile(path, "{ not json");
    expect((await limits("clear")).code).toBe(0);
    expect(await exists()).toBe(false);
  });

  // Eval 59 (2026-10-29) caught the docs saying "the tightest budget applies":
  // a sealed budget overrides SPARK_DAILY_BUDGET_SATS outright; the daily
  // limit here tightens whichever is in force.
  it("says which other budgets apply: the env one, or a sealed one that overrides it", async () => {
    let r = await limitsWith({ SPARK_DAILY_BUDGET_SATS: "50000" });
    expect(r.stdout).toMatch(/Also in force: SPARK_DAILY_BUDGET_SATS=50000\. The tighter of it and the daily budget here applies\./);
    const sealedSeed = join(dir, "sealed.enc");
    await writeFile(sealedSeed, Buffer.from([0x02, 0, 0, 0])); // the plaintext version byte is all it reads
    r = await limitsWith({ SPARK_DAILY_BUDGET_SATS: "50000", SPARK_SEED_PATH: sealedSeed });
    expect(r.stdout).toMatch(/Also in force: a budget sealed in the seed \(set-policy\)\. The tighter of it and the daily budget here applies\./);
    expect(r.stdout).toMatch(/SPARK_DAILY_BUDGET_SATS=50000 is ignored: the sealed budget overrides it\./);
  });

  it("--help prints usage and changes nothing", async () => {
    const r = await limits("--help");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/ONLY because the user asked in their own message/);
    expect(await exists()).toBe(false);
  });
});
