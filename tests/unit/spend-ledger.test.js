// The spend ledger is the enforcement behind "a stated budget": per-call
// ceilings can't stop a LOOP of individually-valid sends. These tests pin the
// rolling-window math, the fail-closed postures (corrupt ledger, unreadable
// amount), and the persistence contract (two instances share state via disk).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, writeFile, readFile, stat, utimes, access } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createSpendLedger,
  checkSpendBudget,
  spentInWindow,
  DAY_MS,
  DEFAULT_SPEND_LEDGER_PATH,
  initSignedLedger,
  inspectLedgerForBinding,
} from "../../lib/spend-ledger.js";

let dir, path;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "spend-ledger-"));
  path = join(dir, "ledger.json");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

const T0 = 1_700_000_000_000;

describe("checkSpendBudget (pure)", () => {
  const entries = [
    { id: "a", ts: T0 - 1_000, sats: 400, operation: "x" },
    { id: "b", ts: T0 - DAY_MS - 1, sats: 9_999, operation: "aged-out" },
  ];
  it("counts only the rolling window", () => {
    expect(spentInWindow(entries, { now: T0 })).toBe(400);
  });
  it("passes a spend that fits and reports the remainder", () => {
    const c = checkSpendBudget({ entries, sats: 600, budgetSats: 1_000, now: T0 });
    expect(c).toMatchObject({ ok: true, spentSats: 400, remainingSats: 0 });
  });
  it("blocks the spend that would cross the budget", () => {
    const c = checkSpendBudget({ entries, sats: 601, budgetSats: 1_000, now: T0 });
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/exceed/);
  });
  it("no budget => ok (opt-in guard)", () => {
    expect(checkSpendBudget({ entries, sats: 10 ** 9, now: T0 }).ok).toBe(true);
  });
  it("an unreadable amount WITH a budget fails closed", () => {
    expect(checkSpendBudget({ entries, sats: undefined, budgetSats: 1_000, now: T0 }).ok).toBe(false);
    expect(checkSpendBudget({ entries, sats: NaN, budgetSats: 1_000, now: T0 }).ok).toBe(false);
  });
});

describe("createSpendLedger persistence", () => {
  it("default path lives under ~/.spark", () => {
    expect(DEFAULT_SPEND_LEDGER_PATH).toMatch(/\.spark\/spend-ledger\.json$/);
  });

  it("accumulates spends across instances (shared disk state) and blocks at the budget", async () => {
    let now = T0;
    const clock = () => now;
    const a = createSpendLedger({ path, budgetSats: 1_000, clock });
    await a.assertCanSpend(700, "send-1");
    await a.record(700, "send-1");
    // a SECOND instance on the same path sees the first instance's spend
    const b = createSpendLedger({ path, budgetSats: 1_000, clock });
    await expect(b.assertCanSpend(400, "send-2")).rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
    await b.assertCanSpend(300, "send-2"); // exactly the remainder still fits
  });

  it("the window rolls: aged-out spends stop counting and get pruned on write", async () => {
    let now = T0;
    const ledger = createSpendLedger({ path, budgetSats: 1_000, clock: () => now });
    await ledger.record(1_000, "yesterday");
    await expect(ledger.assertCanSpend(1, "today")).rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
    now = T0 + DAY_MS + 1;
    await ledger.assertCanSpend(1_000, "today"); // budget is fresh again
    await ledger.record(1_000, "today");
    const persisted = JSON.parse(await readFile(path, "utf8"));
    expect(persisted.entries).toHaveLength(1); // yesterday's entry pruned
    expect(persisted.entries[0].operation).toBe("today");
  });

  it("a corrupt ledger fails CLOSED, not as a fresh ledger", async () => {
    await writeFile(path, "{ not json");
    const ledger = createSpendLedger({ path, budgetSats: 1_000 });
    await expect(ledger.assertCanSpend(1)).rejects.toMatchObject({ code: "SPEND_LEDGER_UNREADABLE" });
    await expect(ledger.record(1)).rejects.toMatchObject({ code: "SPEND_LEDGER_UNREADABLE" });
  });

  it("a valid-JSON ledger with a broken shape also fails closed", async () => {
    await writeFile(path, JSON.stringify({ version: 1, entries: [{ sats: "much" }] }));
    const ledger = createSpendLedger({ path, budgetSats: 1_000 });
    await expect(ledger.status()).rejects.toMatchObject({ code: "SPEND_LEDGER_UNREADABLE" });
  });

  it("unrecord refunds a spend that provably never happened", async () => {
    const ledger = createSpendLedger({ path, budgetSats: 1_000, clock: () => T0 });
    const entry = await ledger.record(900, "failed-send");
    await ledger.unrecord(entry.id);
    await ledger.assertCanSpend(1_000, "next"); // full budget back
  });

  it("the ledger file is written 0600", async () => {
    const ledger = createSpendLedger({ path, budgetSats: 1_000 });
    await ledger.record(1, "x");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("rejects a nonsensical budget loudly at construction", () => {
    expect(() => createSpendLedger({ path, budgetSats: "all of it" })).toThrow(/positive number/);
    expect(() => createSpendLedger({ path, budgetSats: 0 })).toThrow(/positive number/);
    expect(() => createSpendLedger({ path, budgetSats: -5 })).toThrow(/positive number/);
  });

  it("record rejects an unreadable amount", async () => {
    const ledger = createSpendLedger({ path, budgetSats: 1_000 });
    await expect(ledger.record(NaN)).rejects.toThrow(/non-negative number/);
  });

  it("status reports spent/remaining inside the window", async () => {
    const ledger = createSpendLedger({ path, budgetSats: 1_000, clock: () => T0 });
    await ledger.record(250, "x");
    const s = await ledger.status();
    expect(s).toMatchObject({ spentSats: 250, budgetSats: 1_000, remainingSats: 750 });
    expect(s.entries).toHaveLength(1);
  });
});

// ToB review of 375e6fb..HEAD: record() wrote a fractional amount that every
// later read rejected, so one 150.5-sat fee made the ledger unreadable
// (unsigned) or "tampered" (signed), and every send after it failed.
describe("record() writes whole sats the reader accepts", () => {
  it("rounds a fractional amount up, and the ledger still reads, unsigned and signed", async () => {
    const plain = createSpendLedger({ path, budgetSats: 1_000, clock: () => T0 });
    expect((await plain.record(150.5, "l1_withdraw")).sats).toBe(151);
    expect(await plain.status()).toMatchObject({ spentSats: 151 });
    await plain.assertCanSpend(849, "next");

    const key = randomBytes(32);
    const signedPath = path + ".signed";
    await initSignedLedger({ path: signedPath, hmacKey: key });
    const sealed = createSpendLedger({ path: signedPath, budgetSats: 1_000, hmacKey: key, bound: true, clock: () => T0 });
    await sealed.record(0.2, "lightning_pay");
    expect(await sealed.status()).toMatchObject({ spentSats: 1 });
  });
});

// set-policy keeps the spend window: it signs or keeps the ledger it finds
// instead of writing an empty one, which freed headroom when a budget tightened.
describe("inspectLedgerForBinding + initSignedLedger({ entries })", () => {
  const key = randomBytes(32);
  const bound = () => createSpendLedger({ path, budgetSats: 50_000, hmacKey: key, bound: true, clock: () => T0 });

  it("missing → create; a signed ledger that verifies is kept with its spends", async () => {
    expect(await inspectLedgerForBinding({ path, hmacKey: key })).toEqual({ state: "missing", entries: [] });
    await initSignedLedger({ path, hmacKey: key });
    await bound().record(49_000, "spark_transfer");
    const found = await inspectLedgerForBinding({ path, hmacKey: key });
    expect(found.state).toBe("signed");
    expect(found.entries).toHaveLength(1);
  });

  it("an unsigned env-budget ledger is signed as it stands, so what was spent still counts", async () => {
    await createSpendLedger({ path, budgetSats: 50_000, clock: () => T0 }).record(49_000, "spark_transfer");
    const found = await inspectLedgerForBinding({ path, hmacKey: key });
    expect(found.state).toBe("unsigned");
    await initSignedLedger({ path, hmacKey: key, entries: found.entries });
    await expect(bound().assertCanSpend(1_001)).rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
    expect((await bound().status()).spentSats).toBe(49_000);
  });

  it("a ledger that fails verification or can't be read throws instead of being replaced", async () => {
    await initSignedLedger({ path, hmacKey: randomBytes(32) }); // another seed's key
    await expect(inspectLedgerForBinding({ path, hmacKey: key })).rejects.toMatchObject({ code: "SPEND_LEDGER_BAD_SIGNATURE" });
    await writeFile(path, "{ not json");
    await expect(inspectLedgerForBinding({ path, hmacKey: key })).rejects.toMatchObject({ code: "SPEND_LEDGER_UNREADABLE" });
  });

  it("initSignedLedger refuses malformed entries", async () => {
    await expect(initSignedLedger({ path, hmacKey: key, entries: [{ sats: "much" }] })).rejects.toThrow(/well-formed/);
  });
});

// ToB review 2026-10-26: set-policy signed an unsigned, agent-writable ledger
// as it stood, and the validator accepted a negative entry, so one planted
// { sats: -1e9 } became a trusted hole in a sealed budget.
describe("a negative or fractional entry is never a valid ledger entry", () => {
  const key = randomBytes(32);
  const forged = (sats) => JSON.stringify({ version: 1, entries: [{ id: "x", ts: T0, sats, operation: "spark_transfer" }] });

  it("set-policy's inspection refuses an unsigned ledger holding one", async () => {
    for (const sats of [-15_000_000, 1.5]) {
      await writeFile(path, forged(sats));
      await expect(inspectLedgerForBinding({ path, hmacKey: key })).rejects.toMatchObject({ code: "SPEND_LEDGER_UNREADABLE" });
    }
  });

  it("initSignedLedger refuses to sign one", async () => {
    await expect(initSignedLedger({ path, hmacKey: key, entries: [{ id: "x", ts: T0, sats: -1 }] })).rejects.toThrow(/well-formed/);
  });

  it("an env-budget ledger holding one fails closed instead of granting headroom", async () => {
    await writeFile(path, forged(-15_000_000));
    const ledger = createSpendLedger({ path, budgetSats: 20_000, clock: () => T0 });
    await expect(ledger.assertCanSpend(1_000)).rejects.toThrow();
  });
});

// GATE-2 (review 2026-11-09): the check and the record were separate file
// reads and writes, so parallel processes all passed the same check and their
// appends clobbered each other. reserve() does both under `<ledger>.lock`.
describe("reserve(): one spend gate across processes and ledger objects", () => {
  const LEDGER_JS = fileURLToPath(new URL("../../lib/spend-ledger.js", import.meta.url));
  const CHILD = `
    const { createSpendLedger } = await import(process.argv[1]);
    const ledger = createSpendLedger({ path: process.argv[2], budgetSats: 3000 });
    const twoStep = process.argv[3] === "two-step";
    try {
      if (twoStep) { await ledger.assertCanSpend(1000, "x"); await ledger.record(1000, "x"); }
      else await ledger.reserve(1000, "x");
      console.log("sent");
    } catch (err) { console.log(err.code); }`;
  // Each child stands for one tool call paying 1,000 sats, all started at once.
  const burst = (n, mode = "reserve") =>
    Promise.all(Array.from({ length: n }, () =>
      promisify(execFile)(process.execPath, ["--input-type=module", "-e", CHILD, LEDGER_JS, path, mode]).then((r) => r.stdout.trim())));
  const spent = async () => JSON.parse(await readFile(path, "utf8")).entries.reduce((s, e) => s + e.sats, 0);

  it("six processes paying 1,000 each under a 3,000 budget: exactly three go through, and the ledger holds 3,000", async () => {
    for (let trial = 0; trial < 3; trial++) {
      await rm(path, { force: true });
      const results = await burst(6);
      expect(results.filter((r) => r === "sent")).toHaveLength(3);
      expect(results.filter((r) => r === "SPEND_BUDGET_EXCEEDED")).toHaveLength(3);
      expect(await spent()).toBe(3_000);
      await expect(access(`${path}.lock`)).rejects.toThrow();
    }
  }, 60_000);

  it("two ledger objects on one file in one process share the gate", async () => {
    const a = createSpendLedger({ path, budgetSats: 3_000 });
    const b = createSpendLedger({ path, budgetSats: 3_000 });
    const results = await Promise.allSettled([a, b, a, b, a, b].map((l) => l.reserve(1_000, "x")));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
    expect(results.filter((r) => r.reason?.code === "SPEND_BUDGET_EXCEEDED")).toHaveLength(3);
    expect(await spent()).toBe(3_000);
  });

  it("unrecord and record take the same lock: an undo can't erase a spend recorded meanwhile", async () => {
    const a = createSpendLedger({ path, budgetSats: 10_000 });
    const b = createSpendLedger({ path, budgetSats: 10_000 });
    const first = await a.reserve(1_000, "failed-send");
    await Promise.all([a.unrecord(first.id), ...Array.from({ length: 5 }, () => b.reserve(1_000, "real"))]);
    expect(await spent()).toBe(5_000);
  });

  it("a lock left by a process that died, or one older than 10 s, is broken; a live holder is waited for", async () => {
    const lock = `${path}.lock`;
    const ledger = createSpendLedger({ path, budgetSats: 10_000 });
    // A dead holder on this host.
    const dead = (await promisify(execFile)(process.execPath, ["-e", "console.log(process.pid)"])).stdout.trim();
    await writeFile(lock, JSON.stringify({ pid: Number(dead), host: hostname(), ts: Date.now(), token: "x" }));
    await ledger.reserve(1_000, "x");
    // An old lock whose holder can't be checked (another host).
    await writeFile(lock, JSON.stringify({ pid: 1, host: "elsewhere", ts: 0, token: "y" }));
    const old = new Date(Date.now() - 11_000);
    await utimes(lock, old, old);
    await ledger.reserve(1_000, "x");
    // A live holder (the test runner's parent) with a fresh lock: wait until it lets go.
    await writeFile(lock, JSON.stringify({ pid: process.ppid, host: hostname(), ts: Date.now(), token: "z" }));
    let done = false;
    const pending = ledger.reserve(1_000, "x").then(() => { done = true; });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    expect(JSON.parse(await readFile(lock, "utf8")).token).toBe("z");
    await rm(lock);
    await pending;
    expect(await spent()).toBe(3_000);
  });

  // The harness can see the race: the two-call form still overruns.
  it.skipIf(!process.env.SPARK_SHOW_LEDGER_RACE)("(demo) assertCanSpend then record from parallel processes overruns", async () => {
    await rm(path, { force: true });
    const results = await burst(6, "two-step");
    expect(results.filter((r) => r === "sent").length).toBeGreaterThan(3);
  }, 60_000);
});
