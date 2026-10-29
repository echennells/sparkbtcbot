import "dotenv/config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the Lightning dedup store (lib/transfer-ids.js): SparkAgent creates
// it from env at construction, so without this every test that pays through
// the wrapper would write real entries under ~/.spark/ln-dedup. Tests that
// need their own store set SPARK_LN_DEDUP_PATH themselves before constructing.
process.env.SPARK_LN_DEDUP_PATH = mkdtempSync(join(tmpdir(), "ln-dedup-test-"));

// Same for the user's spending limits (lib/spending-limits.js), read on every
// money call: a real ~/.spark/limits.json must never leak into a test. Tests
// that set limits point SPARK_LIMITS_PATH at their own file.
process.env.SPARK_LIMITS_PATH = join(mkdtempSync(join(tmpdir(), "limits-test-")), "limits.json");

// And the L402 holds (lib/l402-holds.js), which outlive the process by
// design: a fresh directory per test, so one test's hold never meets
// another's agent. Tests that need two agents to share holds construct both
// within one test.
const freshL402Holds = () => { process.env.SPARK_L402_HOLDS_PATH = mkdtempSync(join(tmpdir(), "l402-holds-test-")); };
freshL402Holds();
// Standalone scripts (tests/helpers/*-scenarios.mjs) import this file too,
// outside the vitest runner (with VITEST set when vitest spawned them), where
// registering a hook throws.
try {
  const { beforeEach } = await import("vitest");
  beforeEach(freshL402Holds);
} catch { /* not inside the vitest runner */ }
