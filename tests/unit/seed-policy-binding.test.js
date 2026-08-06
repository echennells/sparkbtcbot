// Seed-bound guard policy — binding the budget to the seed so guard enforcement
// stops depending on files the agent can silently delete or edit.
//
// The pre-fix attacks these tests encode (each used to succeed SILENTLY):
//   rm ~/.spark/spend-ledger.json          -> full budget restored
//   truncate ledger to {v1, entries: []}   -> full budget restored (smarter rm)
//   edit an entry's sats down              -> spent total shrinks
//   edit .env to drop SPARK_DAILY_BUDGET   -> budget gone (env was the policy)
// Post-fix: policy rides INSIDE seed.enc (v2, GCM-authenticated, passphrase-
// gated, deleting it deletes the wallet) and the ledger is HMAC-signed with a
// seed-derived key — all four now fail CLOSED. Documented residuals, on
// purpose: replay of a validly-signed old ledger, and in-process code that
// re-derives everything (the raised bar is `rm` -> code execution, not
// impossibility).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  saveEncryptedMnemonic, loadSeedPayload, loadMnemonic, validateSeedPolicy, deriveLedgerHmacKey,
} from "../../lib/encrypted-seed.js";
import { createSpendLedger, initSignedLedger } from "../../lib/spend-ledger.js";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

const MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const PASS = "correcthorsebatterystaple";

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "seedpol-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("seed.enc v2: policy bound into the encrypted payload", () => {
  it("round-trips policy through save/load; file is v2; loadMnemonic stays back-compat", async () => {
    const p = join(dir, "seed.enc");
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: PASS, path: p, policy: { dailyBudgetSats: 50_000 } });
    expect((await readFile(p))[0]).toBe(0x02); // version byte
    const payload = await loadSeedPayload({ passphrase: PASS, path: p });
    expect(payload).toMatchObject({ mnemonic: MNEMONIC, policy: { dailyBudgetSats: 50_000 }, version: 2 });
    expect(await loadMnemonic({ passphrase: PASS, path: p })).toBe(MNEMONIC);
  });

  it("no policy still writes v1 (byte-compatible with older readers)", async () => {
    const p = join(dir, "seed.enc");
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: PASS, path: p });
    expect((await readFile(p))[0]).toBe(0x01);
    expect(await loadSeedPayload({ passphrase: PASS, path: p })).toMatchObject({ policy: null, version: 1 });
  });

  it("policy validation fails closed: unknown keys and garbage budgets throw", () => {
    expect(() => validateSeedPolicy({ dailyBudgetSat: 5000 })).toThrow(/unknown key/);      // typo'd key
    expect(() => validateSeedPolicy({ dailyBudgetSats: "5000" })).toThrow(/positive integer/);
    expect(() => validateSeedPolicy({ dailyBudgetSats: -1 })).toThrow(/positive integer/);
    expect(validateSeedPolicy(null)).toBe(null);
  });

  it("overwrite stays refused by default; allowOverwrite performs the atomic swap", async () => {
    const p = join(dir, "seed.enc");
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: PASS, path: p });
    await expect(saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: PASS, path: p })).rejects.toThrow();
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: PASS, path: p, policy: { dailyBudgetSats: 9 }, allowOverwrite: true });
    expect((await loadSeedPayload({ passphrase: PASS, path: p })).policy.dailyBudgetSats).toBe(9);
  });
});

describe("signed ledger: the rm/truncate/edit attacks fail closed", () => {
  const key = deriveLedgerHmacKey(MNEMONIC);
  const mkBound = (path) => createSpendLedger({ path, budgetSats: 10_000, hmacKey: key, bound: true });

  it("deriveLedgerHmacKey is deterministic and never the AES key path (32-byte HKDF output)", () => {
    expect(deriveLedgerHmacKey(MNEMONIC).equals(key)).toBe(true);
    expect(key.length).toBe(32);
    expect(deriveLedgerHmacKey("other seed words here twelve okay").equals(key)).toBe(false);
  });

  it("happy path: init -> record -> verify -> spend within budget", async () => {
    const p = join(dir, "ledger.json");
    await initSignedLedger({ path: p, hmacKey: key });
    const ledger = mkBound(p);
    await ledger.record(4_000, "test");
    const status = await ledger.status();
    expect(status.spentSats).toBe(4_000);
    await ledger.assertCanSpend(5_000); // 9k <= 10k
    await expect(ledger.assertCanSpend(7_000)).rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
  });

  it("ATTACK rm: a missing ledger under a bound policy THROWS instead of restoring the budget", async () => {
    const p = join(dir, "ledger.json"); // never created = deleted
    await expect(mkBound(p).assertCanSpend(1)).rejects.toMatchObject({ code: "SPEND_LEDGER_MISSING" });
  });

  it("ATTACK truncate: an unsigned/empty replacement THROWS (truncation is the smarter rm)", async () => {
    const p = join(dir, "ledger.json");
    await initSignedLedger({ path: p, hmacKey: key });
    await mkBound(p).record(9_999, "nearly all of it");
    await writeFile(p, JSON.stringify({ version: 1, entries: [] })); // the old legit format, spoofed
    await expect(mkBound(p).assertCanSpend(1)).rejects.toMatchObject({ code: "SPEND_LEDGER_BAD_SIGNATURE" });
  });

  it("ATTACK edit: tampering an entry's sats invalidates the signature", async () => {
    const p = join(dir, "ledger.json");
    await initSignedLedger({ path: p, hmacKey: key });
    await mkBound(p).record(9_000, "big spend");
    const doc = JSON.parse(await readFile(p, "utf8"));
    doc.entries[0].sats = 1; // shrink the spent total, keep the old mac
    await writeFile(p, JSON.stringify(doc));
    await expect(mkBound(p).assertCanSpend(5_000)).rejects.toMatchObject({ code: "SPEND_LEDGER_BAD_SIGNATURE" });
  });

  it("unbound ledgers keep the exact legacy behavior (absent = fresh, v1 accepted)", async () => {
    const p = join(dir, "ledger.json");
    const ledger = createSpendLedger({ path: p, budgetSats: 10_000 });
    await ledger.assertCanSpend(1); // absent file is legitimately fresh
    await ledger.record(1, "ok");
    expect(JSON.parse(await readFile(p, "utf8")).version).toBe(1); // unsigned, as before
  });
});

describe("SparkAgent precedence: seed-bound budget beats the env var", () => {
  const key = deriveLedgerHmacKey(MNEMONIC);
  const mkWallet = () => ({ getSparkAddress: async () => "sp1x" });
  const origBudget = process.env.SPARK_DAILY_BUDGET_SATS;
  const origLedger = process.env.SPARK_SPEND_LEDGER_PATH;
  const origVault = process.env.SPARK_LEAF_VAULT;
  afterEach(() => {
    for (const [k, v] of [["SPARK_DAILY_BUDGET_SATS", origBudget], ["SPARK_SPEND_LEDGER_PATH", origLedger], ["SPARK_LEAF_VAULT", origVault]]) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  it("seed policy wins over a looser env var, with a warning; ledger is bound", async () => {
    process.env.SPARK_LEAF_VAULT = "off";
    process.env.SPARK_DAILY_BUDGET_SATS = "999999"; // agent-writable .env trying to loosen
    process.env.SPARK_SPEND_LEDGER_PATH = join(dir, "ledger.json");
    await initSignedLedger({ path: process.env.SPARK_SPEND_LEDGER_PATH, hmacKey: key });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agent = new SparkAgent(mkWallet(), "MAINNET", { seedContext: { policy: { dailyBudgetSats: 7_000 }, ledgerHmacKey: key } });
    const status = await agent.spendStatus();
    expect(status.budgetSats).toBe(7_000); // NOT 999999
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/SEED-BOUND budget/));
  });

  it("no seed policy: env var behavior is unchanged (v1 wallets untouched)", async () => {
    process.env.SPARK_LEAF_VAULT = "off";
    process.env.SPARK_DAILY_BUDGET_SATS = "5000";
    process.env.SPARK_SPEND_LEDGER_PATH = join(dir, "ledger.json");
    const agent = new SparkAgent(mkWallet(), "MAINNET", { seedContext: null });
    expect((await agent.spendStatus()).budgetSats).toBe(5000);
  });
});

describe("policy CLIs are operator ceremonies (TTY-gated, arg-gated)", () => {
  const run = promisify(execFile);
  const SCRIPTS = fileURLToPath(new URL("../../skills/sparkbtcbot/scripts/", import.meta.url));
  const exec = (script, args = [], input) =>
    run("node", [join(SCRIPTS, script), ...args], { env: { ...process.env }, ...(input !== undefined ? { input } : {}) })
      .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));

  for (const script of ["set-policy.js", "reset-ledger.js"]) {
    it(`${script}: --help exits 0 with usage; unknown arg exits 2; piped run refuses (exit 3)`, async () => {
      const help = await exec(script, ["--help"]);
      expect(help.code).toBe(0);
      expect(help.stdout).toMatch(/Usage: sparkbtcbot-/);
      const bad = await exec(script, ["--force"]);
      expect(bad.code).toBe(2);
      // piped stdio + a canned "yes" must NOT drive the ceremony
      const piped = await exec(script, [], "yes\n");
      expect(piped.code).toBe(3);
      expect(piped.stderr).toMatch(/refusing to run without a real interactive terminal/);
    });
  }
});
