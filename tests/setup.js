import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "./helpers/sandbox-env.js";

// Seal the run off from the machine before any module under test is imported
// (lib/ works its default paths out from HOME at import): a throwaway HOME,
// every ~/.spark path inside it, no wallet settings from the environment or
// .env. The reasons, and the incident behind them, are in
// tests/helpers/sandbox-env.js. A test that needs a setting sets it itself.
//
// This file runs once per test file, so each file gets its own directory:
// a dedup store, a limits file, a spend ledger and a seed path no other file
// has touched. Test-only settings (SPARK_TEST_MNEMONIC for the funded tier)
// are the one thing read from the repo's .env.
const dir = mkdtempSync(join(tmpdir(), "sparkbtcbot-test-"));
let dotenvText = null;
try {
  dotenvText = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", ".env"), "utf8");
} catch { /* no .env: nothing to take from it */ }
const { set, unset } = sandboxEnv({ env: process.env, dotenvText, dir });
for (const k of unset) delete process.env[k];
Object.assign(process.env, set);
mkdirSync(join(set.HOME, ".spark"), { recursive: true, mode: 0o700 });
writeFileSync(set.DOTENV_CONFIG_PATH, ""); // what `import "dotenv/config"` reads from here on

// The L402 holds (lib/l402-holds.js) outlive the process by design: a fresh
// directory per test, so one test's hold never meets another's agent. Tests
// that need two agents to share holds construct both within one test.
const freshL402Holds = () => { process.env.SPARK_L402_HOLDS_PATH = mkdtempSync(join(dir, "l402-holds-")); };
freshL402Holds();
// Standalone scripts (tests/helpers/*-scenarios.mjs) import this file too,
// outside the vitest runner (with VITEST set when vitest spawned them), where
// registering a hook throws.
try {
  const { beforeEach } = await import("vitest");
  beforeEach(freshL402Holds);
} catch { /* not inside the vitest runner */ }
