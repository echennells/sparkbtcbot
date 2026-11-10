// The suite must not read or write the machine's wallet state. On 2026-11-10
// `npm test`, run after an install as AGENTS.md says, wrote 144 fake spends
// into a live ~/.spark/spend-ledger.json and used up the user's daily budget:
// tests/setup.js loaded the machine's .env (with its SPARK_DAILY_BUDGET_SATS)
// and never pointed the spend ledger anywhere else. These tests pin the
// sandbox tests/setup.js now builds (tests/helpers/sandbox-env.js).
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv, TEST_ONLY } from "../helpers/sandbox-env.js";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const inside = (path, dir) => path === dir || path.startsWith(dir + sep);

describe("sandboxEnv: what a test run takes from the machine", () => {
  const live = {
    PATH: "/usr/bin", HOME: "/home/user",
    SPARK_DAILY_BUDGET_SATS: "200000", SPARK_PASSPHRASE: "the live passphrase", SPARK_NETWORK: "MAINNET",
    SPARK_SEED_PATH: "/home/user/.spark/seed.enc", SPARK_SPEND_LEDGER_PATH: "/home/user/.spark/spend-ledger.json",
    SPARK_LN_DEDUP: "off", SPARK_PRIVACY: "off", SPARK_LEAF_VAULT: "off", SPARK_ACCOUNT_NUMBER: "3",
    SPARK_L1_TESTS: "1",
  };
  const dotenvText = "SPARK_PASSPHRASE=from-dotenv\nSPARK_DAILY_BUDGET_SATS=50000\nSPARK_LIMITS_PATH=/live/limits.json\nSPARK_TEST_MNEMONIC=test words\nL402_TEST_CERT_DIR=/certs\nPATH=/not/this\n";
  const { set, unset } = sandboxEnv({ env: live, dotenvText, dir: "/tmp/sb" });
  const after = { ...live, ...set };
  for (const k of unset) delete after[k];

  it("drops every wallet setting, from the environment and from .env", () => {
    for (const k of ["SPARK_DAILY_BUDGET_SATS", "SPARK_PASSPHRASE", "SPARK_NETWORK", "SPARK_LN_DEDUP", "SPARK_PRIVACY", "SPARK_LEAF_VAULT", "SPARK_ACCOUNT_NUMBER"]) {
      expect(after[k], k).toBeUndefined();
    }
  });

  it("puts HOME and every ~/.spark path inside the throwaway directory", () => {
    const paths = ["HOME", "USERPROFILE", "SPARK_SEED_PATH", "SPARK_SPEND_LEDGER_PATH", "SPARK_LIMITS_PATH", "SPARK_LN_DEDUP_PATH", "SPARK_L402_HOLDS_PATH", "SPARK_LEAF_VAULT_PATH", "DOTENV_CONFIG_PATH"];
    for (const k of paths) expect(inside(after[k], "/tmp/sb"), `${k}=${after[k]}`).toBe(true);
    // Every path variable the library reads is one of those: a new one must be added to the sandbox.
    const known = new Set(paths);
    const read = new Set();
    return (async () => {
      for (const dir of ["lib", "skills/sparkbtcbot/scripts"]) {
        for (const name of (await readdir(join(REPO, dir))).filter((n) => n.endsWith(".js"))) {
          for (const m of (await readFile(join(REPO, dir, name), "utf8")).matchAll(/\bSPARK_[A-Z0-9_]*_PATH\b/g)) read.add(m[0]);
        }
      }
      expect([...read].filter((k) => !known.has(k))).toEqual([]);
    })();
  });

  it("keeps settings that exist only for tests, and anything in .env that isn't a wallet setting", () => {
    expect(after).toMatchObject({ SPARK_L1_TESTS: "1", SPARK_TEST_MNEMONIC: "test words", L402_TEST_CERT_DIR: "/certs", PATH: "/usr/bin" });
    expect(TEST_ONLY.test("SPARK_DAILY_BUDGET_SATS")).toBe(false);
  });
});

describe("this run is sandboxed", () => {
  it("HOME, and every default path the library works out from it, is a throwaway directory", async () => {
    const home = homedir();
    expect(inside(home, tmpdir()), home).toBe(true);
    const { DEFAULT_SPEND_LEDGER_PATH } = await import("../../lib/spend-ledger.js");
    const { DEFAULT_SEED_PATH } = await import("../../lib/encrypted-seed.js");
    const { DEFAULT_LIMITS_PATH } = await import("../../lib/spending-limits.js");
    const { DEFAULT_TRANSFER_IDS_DIR } = await import("../../lib/transfer-ids.js");
    const { DEFAULT_ALLOWLIST_PATH } = await import("../../lib/recipients-allowlist.js");
    const { DEFAULT_L402_HOLDS_DIR } = await import("../../lib/l402-holds.js");
    const { defaultVaultPath } = await import("../../skills/sparkbtcbot/scripts/leaf-vault.js");
    for (const p of [DEFAULT_SPEND_LEDGER_PATH, DEFAULT_SEED_PATH, DEFAULT_LIMITS_PATH, DEFAULT_TRANSFER_IDS_DIR, DEFAULT_ALLOWLIST_PATH, DEFAULT_L402_HOLDS_DIR, defaultVaultPath()]) {
      expect(inside(p, home), p).toBe(true);
    }
  });

  it("no budget, passphrase or other wallet setting came in with the environment", () => {
    const leaked = Object.keys(process.env).filter((k) => /^SPARK_/.test(k) && !TEST_ONLY.test(k) && !/_PATH$/.test(k));
    expect(leaked).toEqual([]);
  });

  it("a script that loads dotenv reads the sandbox's empty file, not the repo's .env", async () => {
    expect(inside(process.env.DOTENV_CONFIG_PATH, tmpdir())).toBe(true);
    expect((await stat(process.env.DOTENV_CONFIG_PATH)).size).toBe(0);
    await import("../../skills/sparkbtcbot/scripts/rotate.js"); // `import "dotenv/config"` at its top
    expect(process.env.SPARK_DAILY_BUDGET_SATS).toBeUndefined();
    expect(process.env.SPARK_PASSPHRASE).toBeUndefined();
  });
});

// The incident itself, replayed: a machine with a daily budget and a ledger in
// its home runs test files that spend through SparkAgent.
describe("a machine with a live budget", () => {
  it("runs the suite's spending tests green and its ~/.spark is left exactly as it was", async () => {
    const home = await mkdtemp(join(tmpdir(), "live-home-"));
    try {
      await mkdir(join(home, ".spark"));
      const ledger = join(home, ".spark", "spend-ledger.json");
      const before = '{"version":1,"entries":[]}\n';
      await writeFile(ledger, before);
      const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(VITEST|SPARK_|DOTENV_)/.test(k) && k !== "NODE_OPTIONS"));
      Object.assign(env, { HOME: home, USERPROFILE: home, SPARK_DAILY_BUDGET_SATS: "200000", SPARK_PASSPHRASE: "the live passphrase", SPARK_NETWORK: "MAINNET" });
      const run = await promisify(execFile)(
        process.execPath,
        [join(REPO, "node_modules", "vitest", "vitest.mjs"), "run", "tests/unit/withdraw-fee-guard.test.js", "tests/unit/spark-agent-budget.test.js"],
        { cwd: REPO, env, timeout: 120_000 },
      ).then((r) => ({ code: 0, out: r.stdout }), (e) => ({ code: e.code, out: `${e.stdout}\n${e.stderr}` }));
      expect(run.code, run.out.slice(-1_500)).toBe(0);
      expect(await readFile(ledger, "utf8")).toBe(before);
      expect(await readdir(join(home, ".spark"))).toEqual(["spend-ledger.json"]);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 150_000);
});
