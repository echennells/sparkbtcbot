// QA ran `sparkbtcbot-setup --help` expecting usage — and it IGNORED the flag
// and bootstrapped a wallet (harmless on their REGTEST run; on MAINNET an agent
// probing the CLI silently mints a real wallet nobody backed up). Same class in
// the siblings: leaf-vault's no-arg default snapshots, reveal's default reveals
// the seed — so an unrecognized argument falling through to the default action
// is fail-open in all three. These tests pin the gates: -h/--help prints usage
// and exits 0 BEFORE any side effect (no seed file appears), and unknown args
// fail closed (exit 2) instead of running the default.
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readdir } from "node:fs/promises";

const run = promisify(execFile);
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "../../skills/sparkbtcbot/scripts");

const exec = (script, args, env = {}) =>
  run("node", [join(SCRIPTS, script), ...args], { env: { ...process.env, ...env } }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }),
  );

describe("setup-encrypted-seed arg gate (the QA wallet-on---help bug)", () => {
  it("--help prints usage, exits 0, and creates NO seed file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-gate-"));
    try {
      const seedPath = join(dir, "seed.enc");
      for (const flag of ["--help", "-h"]) {
        const r = await exec("setup-encrypted-seed.js", [flag], {
          SPARK_SEED_PATH: seedPath,
          SPARK_PASSPHRASE: "correcthorsebatterystaple",
        });
        expect(r.code).toBe(0);
        expect(r.stdout).toMatch(/Usage: sparkbtcbot-setup/);
        expect(await readdir(dir)).toEqual([]); // the load-bearing assertion
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it("an unknown flag fails closed (exit 2, usage, nothing created) — a typo must not mint a wallet", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cli-gate-"));
    try {
      const r = await exec("setup-encrypted-seed.js", ["--imprt"], {
        SPARK_SEED_PATH: join(dir, "seed.enc"),
        SPARK_PASSPHRASE: "correcthorsebatterystaple",
      });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/Unknown argument.*--imprt/);
      expect(await readdir(dir)).toEqual([]);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe("reveal-mnemonic arg gate", () => {
  it("--help prints usage and exits 0 even piped (usage holds no secrets)", async () => {
    const r = await exec("reveal-mnemonic.js", ["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage: sparkbtcbot-reveal-mnemonic/);
    expect(r.stdout).not.toMatch(/[a-z]+( [a-z]+){11}/); // and definitely no 12 words
  });

  it("an unknown argument exits 2 with usage — never falls through toward a reveal", async () => {
    const r = await exec("reveal-mnemonic.js", ["--force"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown argument.*--force/i);
  });
});

describe("leaf-vault-cli arg gate", () => {
  it("--help prints usage and exits 0 without attempting a snapshot", async () => {
    const r = await exec("leaf-vault-cli.js", ["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage: sparkbtcbot-leaf-vault/);
  });

  it("a typo'd command (vreify) exits 2 instead of snapshotting", async () => {
    const r = await exec("leaf-vault-cli.js", ["vreify"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown argument "vreify"/);
  });
});
