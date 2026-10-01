// SparkAgent on REGTEST for integration tests — the wrapper the skill ships,
// not the raw SDK. Each agent gets its own temp dir for every file SparkAgent
// writes (spend ledger, audit log, Lightning dedup store) and a seed path that
// doesn't exist, so a developer's real ~/.spark state can neither leak in nor
// be written to. Privacy and the leaf vault are off: the funded test wallet is
// shared, and its operator-side privacy setting is the funded privacy test's
// to manage.
import { mkdtempSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { DEFAULT_ALLOWLIST_PATH } from "../../lib/recipients-allowlist.js";
import { saveEncryptedMnemonic, deriveLedgerHmacKey, loadMnemonicFromEnv } from "../../lib/encrypted-seed.js";
import { initSignedLedger } from "../../lib/spend-ledger.js";

const NETWORK = "REGTEST";
const tracked = new Set();

// env: extra variables for THIS agent (e.g. SPARK_DAILY_BUDGET_SATS). SparkAgent
// reads its env at construction, so they apply to this agent only.
// sealedPolicy: seal it the way production does: write a real v2 seed.enc
// carrying the policy plus the signed ledger set-policy creates, and open it
// with loadMnemonicFromEnv (which records the policy SparkAgent enforces). The
// recorded policy is module state: later agents in the same test file see it
// too, until another sealedPolicy agent replaces it.
export async function createTestAgent({ mnemonic, env = {}, sealedPolicy } = {}) {
  if (existsSync(DEFAULT_ALLOWLIST_PATH)) {
    throw new Error(
      `${DEFAULT_ALLOWLIST_PATH} exists — SparkAgent enforces it on every send, so these tests would ` +
        "fail on fresh REGTEST addresses. Move it aside while running the integration tests.",
    );
  }
  const dir = mkdtempSync(join(tmpdir(), "agent-it-"));
  const keys = ["SPARK_PASSPHRASE", "SPARK_LEAF_VAULT", "SPARK_PRIVACY", "SPARK_SEED_PATH", "SPARK_SPEND_LEDGER_PATH", "SPARK_AUDIT_LOG_PATH", "SPARK_LN_DEDUP_PATH", "SPARK_AUDIT_LOG", "SPARK_DAILY_BUDGET_SATS", ...Object.keys(env)];
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  Object.assign(process.env, {
    SPARK_LEAF_VAULT: "off",
    SPARK_PRIVACY: "off",
    SPARK_SEED_PATH: join(dir, "seed.enc"), // absent unless sealedPolicy writes it
    SPARK_SPEND_LEDGER_PATH: join(dir, "ledger.json"),
    SPARK_AUDIT_LOG_PATH: join(dir, "audit.jsonl"),
    SPARK_LN_DEDUP_PATH: join(dir, "ln-dedup"),
  });
  delete process.env.SPARK_AUDIT_LOG;
  delete process.env.SPARK_DAILY_BUDGET_SATS;
  Object.assign(process.env, env);
  let created;
  try {
    const seed = mnemonic ?? (await import("@scure/bip39")).generateMnemonic((await import("@scure/bip39/wordlists/english")).wordlist);
    if (sealedPolicy) {
      const passphrase = "regtest sealed-policy test passphrase";
      await saveEncryptedMnemonic({ mnemonic: seed, passphrase, path: process.env.SPARK_SEED_PATH, policy: sealedPolicy });
      await initSignedLedger({ path: process.env.SPARK_SPEND_LEDGER_PATH, hmacKey: deriveLedgerHmacKey(seed) });
      process.env.SPARK_PASSPHRASE = passphrase;
      await loadMnemonicFromEnv({ clearEnv: false });
    }
    created = await SparkAgent.create(seed, NETWORK, { optimizeLeaves: false });
    created.mnemonic = seed;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  tracked.add(created.agent);
  const auditLines = async () => {
    try {
      return (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    } catch (err) {
      if (err.code === "ENOENT") return [];
      throw err;
    }
  };
  return { agent: created.agent, mnemonic: created.mnemonic, dir, auditLines };
}

export async function cleanupAllAgents() {
  for (const a of tracked) {
    try {
      await a.cleanup();
    } catch {}
  }
  tracked.clear();
}

// A transfer shows up as `incoming` first and `available` after the receiver
// claims it; poll until available + incoming reaches `atLeast` (bigint), or
// return the last reading. Callers assert on what comes back.
export async function waitForSats(wallet, atLeast, { timeoutMs = 45_000, everyMs = 1_500 } = {}) {
  const end = Date.now() + timeoutMs;
  let b;
  for (;;) {
    ({ satsBalance: b } = await wallet.getBalance());
    if (b.available + b.incoming >= atLeast || Date.now() > end) return b;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// Poll until the wallet has claimed everything (incoming 0) and holds exactly
// `expected` (bigint), or the timeout passes; returns the last reading. Use a
// FRESH receiver per payment: mid-claim, available + incoming can read low or
// high, so a before/after delta on a busy wallet is not reliable.
export async function waitForSettled(wallet, expected, { timeoutMs = 45_000, everyMs = 1_500 } = {}) {
  const end = Date.now() + timeoutMs;
  let b;
  for (;;) {
    ({ satsBalance: b } = await wallet.getBalance());
    if ((b.incoming === 0n && b.available === expected) || Date.now() > end) return { available: b.available, incoming: b.incoming };
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

// Send a throwaway wallet's claimed balance back to the funded wallet, so a
// run doesn't bleed the shared REGTEST float. Waits for incoming transfers to
// be claimed first. Returns the sats sent (0n if none, or on failure). Best
// effort: a failure is logged, never thrown.
export async function returnSats(wallet, toAddress) {
  try {
    const end = Date.now() + 30_000;
    let b;
    for (;;) {
      ({ satsBalance: b } = await wallet.getBalance());
      if (b.incoming === 0n || Date.now() > end) break;
      await new Promise((r) => setTimeout(r, 1_500));
    }
    if (b.available === 0n) return 0n;
    await wallet.transfer({ receiverSparkAddress: toAddress, amountSats: Number(b.available) });
    return b.available;
  } catch (err) {
    console.warn(`returnSats: could not return funds (${err?.message ?? err})`);
    return 0n;
  }
}

// After returning funds, wait until the funded wallet has CLAIMED them:
// `readAvailable()` (the funded wallet's available sats, bigint) reaches
// `target`. Otherwise the claim lands during the next test file and moves a
// balance that test is comparing (the funded privacy test did exactly that).
export async function waitForClaimed(readAvailable, target, { timeoutMs = 60_000, everyMs = 1_500 } = {}) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    if ((await readAvailable()) >= target || Date.now() > end) return;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
