// `sparkbtcbot rekey` — change the passphrase, keep the mnemonic and the sealed
// policy. Library half: a round-trip under the new passphrase, the old one
// dead, the policy carried over byte-for-byte, a wrong current passphrase or a
// weak/identical new one leaving the file untouched. CLI half: the same
// arg/TTY gates as every other ceremony (help exits 0, unknown args exit 2,
// piped stdin/stdout exit 3 before any prompt). Plus SPARK_PASSPHRASE_FILE,
// which the rekey checklist tells operators to update.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  saveEncryptedMnemonic,
  loadSeedPayload,
  loadSeedPayloadFromEnv,
  rekeyEncryptedSeed,
} from "../../lib/encrypted-seed.js";

const run = promisify(execFile);
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "../../skills/sparkbtcbot/scripts");
const exec = (args, env = {}) =>
  run("node", [join(SCRIPTS, "rekey.js"), ...args], { env: { ...process.env, ...env } }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }),
  );

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const OLD = "correct horse battery staple";
const NEW = "staple battery horse correct!";
const POLICY = { dailyBudgetSats: 5000, allowedOps: ["lightning_pay"], expiresAt: "2030-01-01T00:00:00.000Z" };

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "rekey-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("rekeyEncryptedSeed (lib)", () => {
  it("v2: the new passphrase opens the file, the old one does not, the sealed policy is unchanged, salt+iv are fresh", async () => {
    const path = join(dir, "seed.enc");
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: OLD, path, policy: POLICY });
    const before = await readFile(path);
    const r = await rekeyEncryptedSeed({ path, passphrase: OLD, newPassphrase: NEW });
    expect(r).toEqual({ version: 2, policy: POLICY });
    const after = await readFile(path);
    expect(after[0]).toBe(0x02);
    expect(after.subarray(4, 32).equals(before.subarray(4, 32))).toBe(false); // salt + iv differ
    const opened = await loadSeedPayload({ passphrase: NEW, path });
    expect(opened).toEqual({ mnemonic: MNEMONIC, policy: POLICY, version: 2 });
    await expect(loadSeedPayload({ passphrase: OLD, path })).rejects.toMatchObject({ code: "BAD_PASSPHRASE" });
  });

  it("v1 (no policy) stays v1", async () => {
    const path = join(dir, "seed.enc");
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: OLD, path });
    expect(await rekeyEncryptedSeed({ path, passphrase: OLD, newPassphrase: NEW })).toEqual({ version: 1, policy: null });
    expect((await readFile(path))[0]).toBe(0x01);
    expect(await loadSeedPayload({ passphrase: NEW, path })).toEqual({ mnemonic: MNEMONIC, policy: null, version: 1 });
  });

  it("wrong current passphrase, short new passphrase, or identical passphrase → throws and the file is byte-identical", async () => {
    const path = join(dir, "seed.enc");
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: OLD, path, policy: POLICY });
    const before = await readFile(path);
    await expect(rekeyEncryptedSeed({ path, passphrase: "wrong wrong wrong", newPassphrase: NEW })).rejects.toMatchObject({ code: "BAD_PASSPHRASE" });
    await expect(rekeyEncryptedSeed({ path, passphrase: OLD, newPassphrase: "short" })).rejects.toThrow(/at least 12/);
    await expect(rekeyEncryptedSeed({ path, passphrase: OLD, newPassphrase: OLD })).rejects.toThrow(/identical/);
    expect((await readFile(path)).equals(before)).toBe(true);
  });
});

describe("rekey CLI gates", () => {
  it("--help prints usage and exits 0 even piped", async () => {
    const r = await exec(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage: sparkbtcbot rekey \[--generate\]/);
    expect(r.stdout).toMatch(/rotate/); // the file-was-copied caveat is in the usage itself
  });

  it("an unknown argument exits 2 with usage", async () => {
    const r = await exec(["--force"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown argument.*--force/i);
  });

  it("without a TTY it refuses (exit 3) before any prompt — with or without --generate, ignoring SPARK_PASSPHRASE in env", async () => {
    for (const args of [[], ["--generate"]]) {
      const r = await exec(args, { SPARK_PASSPHRASE: OLD, SPARK_SEED_PATH: join(dir, "nope.enc") });
      expect(r.code).toBe(3);
      expect(r.stderr).toMatch(/refusing to run without a real interactive terminal/);
      expect(r.stderr).not.toMatch(/passphrase for/i); // never reached the prompt
    }
  });
});

describe("SPARK_PASSPHRASE_FILE", () => {
  const ENV = ["SPARK_PASSPHRASE", "SPARK_PASSPHRASE_FILE", "SPARK_SEED_PATH"];
  const saved = {};
  beforeEach(() => { for (const k of ENV) { saved[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

  it("reads the passphrase from the file with its trailing newline stripped", async () => {
    const seed = join(dir, "seed.enc");
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: OLD, path: seed });
    const pf = join(dir, "passphrase");
    await writeFile(pf, OLD + "\n"); // every secrets tool writes one
    process.env.SPARK_SEED_PATH = seed;
    process.env.SPARK_PASSPHRASE_FILE = pf;
    expect((await loadSeedPayloadFromEnv()).mnemonic).toBe(MNEMONIC);
  });

  it("SPARK_PASSPHRASE wins over the file; an unreadable file is NO_PASSPHRASE, not a crash", async () => {
    const seed = join(dir, "seed.enc");
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: OLD, path: seed });
    process.env.SPARK_SEED_PATH = seed;
    process.env.SPARK_PASSPHRASE_FILE = join(dir, "missing");
    process.env.SPARK_PASSPHRASE = OLD;
    expect((await loadSeedPayloadFromEnv({ clearEnv: false })).mnemonic).toBe(MNEMONIC);
    delete process.env.SPARK_PASSPHRASE;
    await expect(loadSeedPayloadFromEnv()).rejects.toMatchObject({ code: "NO_PASSPHRASE" });
  });
});
