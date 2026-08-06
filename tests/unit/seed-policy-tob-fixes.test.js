// Regression pins for the Trail-of-Bits pass on the seed-bound policy work.
// Each test encodes a finding that was REAL against the first implementation:
//   F-A  agent-class.md shipped the pre-seal env-only resolver (doc/code drift)
//   F-C  a sealed seed whose policy didn't reach the agent ran SILENTLY unbound
//   F-C2 a policy-less load cleared an established sealed context
//   F-C3 a second copy of the module saw an empty context (module-scoped state)
//   F-H  the version byte was outside the GCM AAD: flipping 0x02 -> 0x01 passed
//        authentication and reinterpreted the payload as a bare mnemonic
//   F-F  the over-budget error told sealed-policy callers to edit .env
//   F-G  the ceremonies accepted the passphrase from .env, reducing "requires
//        the passphrase" to "requires a PTY"
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  saveEncryptedMnemonic, loadSeedPayload, loadMnemonicFromEnv,
  getLoadedSeedContext, seedFileIsSealed, deriveLedgerHmacKey,
} from "../../lib/encrypted-seed.js";
import { createSpendLedger, initSignedLedger } from "../../lib/spend-ledger.js";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

const MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const OTHER = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
const PASS = "correcthorsebatterystaple";
const run = promisify(execFile);
const SCRIPTS = fileURLToPath(new URL("../../skills/sparkbtcbot/scripts/", import.meta.url));

let dir;
const saved = {};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tobfix-"));
  for (const k of ["SPARK_SEED_PATH", "SPARK_SPEND_LEDGER_PATH", "SPARK_DAILY_BUDGET_SATS", "SPARK_PASSPHRASE", "SPARK_LEAF_VAULT"]) saved[k] = process.env[k];
  process.env.SPARK_LEAF_VAULT = "off";
  delete globalThis[Symbol.for("sparkbtcbot.loadedSeedContext")];
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  delete globalThis[Symbol.for("sparkbtcbot.loadedSeedContext")];
});

const fakeWallet = () => ({ getSparkAddress: async () => "sp1x", on() {}, off() {} });

describe("F-H: the seed header is authenticated (version-byte downgrade)", () => {
  it("flipping a v2 file's version byte to v1 now FAILS decryption instead of dropping the policy", async () => {
    const p = join(dir, "seed.enc");
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: PASS, path: p, policy: { dailyBudgetSats: 7000 } });
    const blob = await readFile(p);
    blob[0] = 0x01; // the attack: reinterpret the JSON envelope as a bare mnemonic
    await writeFile(p, blob);
    await expect(loadSeedPayload({ passphrase: PASS, path: p })).rejects.toMatchObject({ code: "BAD_PASSPHRASE" });
  });

  it("v1 files still load (AAD applies to v2 only — no back-compat break)", async () => {
    const p = join(dir, "seed.enc");
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: PASS, path: p });
    expect((await loadSeedPayload({ passphrase: PASS, path: p })).mnemonic).toBe(MNEMONIC);
  });
});

describe("F-C: a sealed seed can never be silently unbound", () => {
  it("seedFileIsSealed reads the plaintext version byte without a passphrase", async () => {
    const v2 = join(dir, "v2.enc"), v1 = join(dir, "v1.enc");
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: PASS, path: v2, policy: { dailyBudgetSats: 7000 } });
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: PASS, path: v1 });
    expect(seedFileIsSealed(v2)).toBe(true);
    expect(seedFileIsSealed(v1)).toBe(false);
    expect(seedFileIsSealed(join(dir, "nope.enc"))).toBe(false); // absent = nothing to enforce
  });

  it("constructing SparkAgent with a sealed seed but NO policy context THROWS (was: silent unbound)", async () => {
    const p = join(dir, "seed.enc");
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: PASS, path: p, policy: { dailyBudgetSats: 7000 } });
    process.env.SPARK_SEED_PATH = p;
    expect(() => new SparkAgent(fakeWallet(), "MAINNET", { seedContext: null }))
      .toThrow(/SEALED spending policy, but this process did not receive it/);
  });

  it("END-TO-END: loadMnemonicFromEnv -> SparkAgent enforces the sealed budget (the real product path)", async () => {
    const p = join(dir, "seed.enc"), ledger = join(dir, "ledger.json");
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: PASS, path: p, policy: { dailyBudgetSats: 7000 } });
    await initSignedLedger({ path: ledger, hmacKey: deriveLedgerHmacKey(MNEMONIC) });
    process.env.SPARK_SEED_PATH = p;
    process.env.SPARK_SPEND_LEDGER_PATH = ledger;
    process.env.SPARK_PASSPHRASE = PASS;
    await loadMnemonicFromEnv();                       // this is what carries the policy
    const agent = new SparkAgent(fakeWallet(), "MAINNET");
    expect((await agent.spendStatus()).budgetSats).toBe(7000);
  });

  it("F-C2: a later policy-less load does NOT clear an established sealed context", async () => {
    const sealed = join(dir, "a.enc"), plain = join(dir, "b.enc");
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: PASS, path: sealed, policy: { dailyBudgetSats: 7000 } });
    await saveEncryptedMnemonic({ mnemonic: OTHER, passphrase: PASS, path: plain });
    process.env.SPARK_PASSPHRASE = PASS; process.env.SPARK_SEED_PATH = sealed;
    await loadMnemonicFromEnv({ clearEnv: false });
    process.env.SPARK_SEED_PATH = plain;
    await loadMnemonicFromEnv({ clearEnv: false });    // the disarm attempt
    expect(getLoadedSeedContext()?.policy?.dailyBudgetSats).toBe(7000);
  });

  it("F-C3: the context lives on globalThis, so a second module copy sees it", async () => {
    const p = join(dir, "seed.enc");
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: PASS, path: p, policy: { dailyBudgetSats: 7000 } });
    process.env.SPARK_PASSPHRASE = PASS; process.env.SPARK_SEED_PATH = p;
    await loadMnemonicFromEnv({ clearEnv: false });
    const second = await import("../../lib/encrypted-seed.js?copy=1"); // distinct module instance
    expect(second.getLoadedSeedContext()?.policy?.dailyBudgetSats).toBe(7000);
  });
});

describe("F-F: over-budget remediation matches the mode", () => {
  it("bound: points at set-policy, never at .env", async () => {
    const p = join(dir, "ledger.json");
    const key = deriveLedgerHmacKey(MNEMONIC);
    await initSignedLedger({ path: p, hmacKey: key });
    const ledger = createSpendLedger({ path: p, budgetSats: 100, hmacKey: key, bound: true });
    await expect(ledger.assertCanSpend(500)).rejects.toThrow(/sparkbtcbot-set-policy/);
    await expect(ledger.assertCanSpend(500)).rejects.not.toThrow(/raise SPARK_DAILY_BUDGET_SATS/);
  });

  it("unbound: keeps the env-var advice (correct there)", async () => {
    const ledger = createSpendLedger({ path: join(dir, "l.json"), budgetSats: 100 });
    await expect(ledger.assertCanSpend(500)).rejects.toThrow(/raise SPARK_DAILY_BUDGET_SATS/);
  });
});

describe("F-G: the ceremonies never take the passphrase from the environment", () => {
  for (const script of ["set-policy.js", "reset-ledger.js"]) {
    it(`${script} does not read SPARK_PASSPHRASE`, async () => {
      const src = await readFile(join(SCRIPTS, script), "utf8");
      expect(src).not.toMatch(/env\.SPARK_PASSPHRASE/);
      const help = await run("node", [join(SCRIPTS, script), "--help"]).catch((e) => e);
      expect(help.stdout ?? "").not.toMatch(/SPARK_PASSPHRASE/); // usage must not advertise it either
    });
  }
});

describe("F-A: the reference class doc matches the shipped resolver", () => {
  it("agent-class.md carries the seed-context wiring, not the pre-seal env-only version", async () => {
    const doc = await readFile(fileURLToPath(new URL("../../skills/sparkbtcbot/references/agent-class.md", import.meta.url)), "utf8");
    expect(doc).toMatch(/getLoadedSeedContext/);
    expect(doc).toMatch(/seedFileIsSealed/);
    expect(doc).toMatch(/spendLedgerFromEnv\(seedContext !== undefined/);
  });
});
