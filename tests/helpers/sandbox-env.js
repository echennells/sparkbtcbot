// What a test run may take from the machine it runs on: nothing about the
// wallet. No tier of this suite may read or write the user's ~/.spark, or be
// steered by the wallet settings in their .env.
//
// Why (2026-11-10): tests/setup.js loaded the machine's .env and isolated the
// dedup store, the limits file and the L402 holds, but not the spend ledger.
// On a machine whose .env set SPARK_DAILY_BUDGET_SATS, `npm test` (which
// AGENTS.md says to run after every install) recorded its fake spends in the
// live ~/.spark/spend-ledger.json: 144 entries, 199,891 of a 200,000-sat
// budget, so every real payment was refused for a day; and once the shared
// ledger filled, tests got the budget refusal instead of the error they
// expected, a different set each run.
//
// So, for every tier:
//   - HOME is a throwaway directory, which moves every default path
//     (~/.spark/seed.enc, the ledger, the backup, the allowlist, ...);
//   - each path setting points into it explicitly as well;
//   - wallet settings (SPARK_*) from the environment or .env are dropped;
//   - `import "dotenv/config"` in the scripts under test, and in the CLI
//     processes tests spawn, reads an empty file instead of ./.env.
// Settings that exist only for tests pass through.
import { join } from "node:path";
import { parse } from "dotenv";

/** Settings that exist for the tests themselves (the funded REGTEST wallet, opt-in slow tiers). */
export const TEST_ONLY = /^(SPARK_TEST_[A-Z0-9_]+|SPARK_L1_TESTS|SPARK_SHOW_LEDGER_RACE)$/;
const WALLET_SETTING = /^SPARK_/;

/**
 * Pure: what to change in `env` so a test run is sealed off from the machine.
 * @param {{ env: Record<string, string | undefined>, dotenvText?: string | null, dir: string }} input
 *   `dir` is the throwaway directory; `dotenvText` the machine's .env, if any.
 * @returns {{ set: Record<string, string>, unset: string[] }}
 */
export function sandboxEnv({ env, dotenvText = null, dir }) {
  const home = join(dir, "home");
  const spark = join(home, ".spark");
  const set = {};
  // From .env: everything except wallet settings, and never over a value the
  // environment already has (as dotenv does it).
  for (const [k, v] of Object.entries(dotenvText ? parse(dotenvText) : {})) {
    if (WALLET_SETTING.test(k) && !TEST_ONLY.test(k)) continue;
    if (env[k] === undefined) set[k] = v;
  }
  const unset = Object.keys(env).filter((k) => WALLET_SETTING.test(k) && !TEST_ONLY.test(k));
  Object.assign(set, {
    HOME: home,
    USERPROFILE: home,
    SPARK_SEED_PATH: join(spark, "seed.enc"),
    SPARK_SPEND_LEDGER_PATH: join(spark, "spend-ledger.json"),
    SPARK_LIMITS_PATH: join(spark, "limits.json"),
    SPARK_LN_DEDUP_PATH: join(spark, "ln-dedup"),
    SPARK_L402_HOLDS_PATH: join(spark, "l402-holds"),
    SPARK_LEAF_VAULT_PATH: join(spark, "leaf-vault", "current.json"),
    DOTENV_CONFIG_PATH: join(dir, "empty.env"),
    DOTENV_CONFIG_QUIET: "true",
  });
  return { set, unset: unset.filter((k) => !(k in set)) };
}
