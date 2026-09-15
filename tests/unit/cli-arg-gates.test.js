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
        expect(r.stdout).toMatch(/Usage: sparkbtcbot setup/);
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
    expect(r.stdout).toMatch(/Usage: sparkbtcbot reveal-mnemonic/);
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
    expect(r.stdout).toMatch(/Usage: sparkbtcbot leaf-vault/);
  });

  it("a typo'd command (vreify) exits 2 instead of snapshotting", async () => {
    const r = await exec("leaf-vault-cli.js", ["vreify"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown argument "vreify"/);
  });
});

describe("viewer arg gate", () => {
  // No SPARK_PASSPHRASE in any of these: every gate must fire BEFORE the seed
  // is touched, so a decrypt attempt would surface as a different failure.
  const noSeed = { SPARK_PASSPHRASE: "", SPARK_SEED_PATH: "/nonexistent/seed.enc" };
  it("--help prints usage and exits 0", async () => {
    const r = await exec("viewer-key.js", ["--help"], noSeed);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage: sparkbtcbot viewer/);
  });
  it("no verb / typo'd verb / stray argument exit 2 with usage", async () => {
    for (const args of [[], ["grnt"], ["status", "extra"], ["revoke", "now"]]) {
      const r = await exec("viewer-key.js", args, noSeed);
      expect(r.code, `args=${args}`).toBe(2);
      expect(r.stderr).toMatch(/Usage: sparkbtcbot viewer/);
    }
  });
  it("grant validates the key shape before anything else", async () => {
    for (const bad of [[], ["02ab"], ["04" + "a".repeat(64)], ["zz" + "a".repeat(64)]]) {
      const r = await exec("viewer-key.js", ["grant", ...bad], noSeed);
      expect(r.code, `key=${bad}`).toBe(2);
    }
  });
  it("grant with a valid key proceeds to the seed (no TTY wall — a consent step, not a seed-tier ceremony)", async () => {
    // With no passphrase the next thing it hits is the seed decrypt, which is
    // the proof the arg gate passed; exit 3 with the old TTY message would be
    // the regression.
    const r = await exec("viewer-key.js", ["grant", "02" + "a".repeat(64)], noSeed);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toMatch(/interactive terminal/);
    expect(r.stderr).toMatch(/SPARK_PASSPHRASE|seed/i);
  });
  it("balance validates the address shape", async () => {
    const r = await exec("viewer-key.js", ["balance", "bc1qnotaspark"], noSeed);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/does not look like a Spark address/);
  });
});

describe("sparkbtcbot dispatcher gate (one argument gate, no default action)", () => {
  it("no command prints the subcommand list and exits 1 — nothing runs by default", async () => {
    const r = await exec("cli.js", []);
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/Usage: sparkbtcbot <command>/);
    expect(r.stderr).toMatch(/setup/);
    expect(r.stderr).toMatch(/reveal-mnemonic/);
  });

  it("an unknown command exits 2 with usage — a typo can't reach any ceremony", async () => {
    const r = await exec("cli.js", ["stup"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown command "stup"/);
  });

  it("help exits 0 on stdout; version prints the package version", async () => {
    const h = await exec("cli.js", ["help"]);
    expect(h.code).toBe(0);
    expect(h.stdout).toMatch(/Usage: sparkbtcbot <command>/);
    const v = await exec("cli.js", ["version"]);
    expect(v.code).toBe(0);
    expect(v.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("dispatch actually reaches the subcommand's main() — the silent-no-op-setup regression", async () => {
    // If the dispatcher imported setup without its main() running (the old
    // direct-run guard would see argv[1]=cli.js and skip), this would exit 0
    // with NO output. Reaching setup's own --help usage proves execution;
    // reaching its unknown-arg gate proves argv propagation.
    const help = await exec("cli.js", ["setup", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/Usage: sparkbtcbot setup/);
    const typo = await exec("cli.js", ["setup", "--imprt"]);
    expect(typo.code).toBe(2);
    expect(typo.stderr).toMatch(/Unknown argument.*--imprt/);
    const lv = await exec("cli.js", ["leaf-vault", "vreify"]);
    expect(lv.code).toBe(2);
    expect(lv.stderr).toMatch(/unknown argument "vreify"/);
  });
});
