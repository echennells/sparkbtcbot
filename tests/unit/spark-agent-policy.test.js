// The sealed policy as SparkAgent enforces it: one gate (#authorize) in front
// of every money-moving method, before any SDK call. Pins: each rule denies
// with POLICY_DENIED + the rule name and the SDK is never reached; dry runs are
// refused by the declarative rules but do not fire the operator's hook; the
// hook sees real amounts and the real daily total; every denial and live
// outcome lands in the audit log with no secret-shaped key; and a v2 seed whose
// sealed policy has NO budget boots (the "sealed but unbound" guard must only
// fire when no policy reached the process at all).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, chmod, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { sha256File } from "../../lib/policy.js";
import { saveEncryptedMnemonic, deriveLedgerHmacKey } from "../../lib/encrypted-seed.js";
import { initSignedLedger } from "../../lib/spend-ledger.js";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASS = "correct horse battery staple";

let dir;
const ENV_KEYS = ["SPARK_LEAF_VAULT", "SPARK_DAILY_BUDGET_SATS", "SPARK_SPEND_LEDGER_PATH", "SPARK_AUDIT_LOG_PATH", "SPARK_AUDIT_LOG", "SPARK_SEED_PATH"];
const saved = {};
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "agent-policy-"));
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.SPARK_LEAF_VAULT = "off";
  delete process.env.SPARK_DAILY_BUDGET_SATS;
  process.env.SPARK_SPEND_LEDGER_PATH = join(dir, "ledger.json");
  process.env.SPARK_AUDIT_LOG_PATH = join(dir, "audit.jsonl");
  delete process.env.SPARK_AUDIT_LOG;
  process.env.SPARK_SEED_PATH = join(dir, "seed.enc"); // absent → not sealed
});
afterEach(async () => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(dir, { recursive: true, force: true });
});

const mkWallet = () => {
  const calls = { transfers: 0, withdraws: 0, tokens: 0, claims: 0, quotes: 0 };
  return {
    calls,
    getSparkAddress: async () => "sp1from",
    transfer: async () => { calls.transfers++; return { id: `t${calls.transfers}` }; },
    getWithdrawalFeeQuote: async () => { calls.quotes++; return { id: "q1", userFeeFast: { originalValue: 10 }, l1BroadcastFeeFast: { originalValue: 10 }, userFeeMedium: { originalValue: 10 }, l1BroadcastFeeMedium: { originalValue: 10 } }; },
    withdraw: async () => { calls.withdraws++; return { id: `w${calls.withdraws}` }; },
    transferTokens: async () => { calls.tokens++; return { id: `k${calls.tokens}` }; },
    getClaimStaticDepositQuote: async () => ({ creditAmountSats: 5000 }),
    claimStaticDepositWithMaxFee: async () => { calls.claims++; return { id: `c${calls.claims}` }; },
  };
};

const agentWith = (policy, wallet = mkWallet(), extra = {}) => {
  const seedContext = policy ? { policy, ledgerHmacKey: deriveLedgerHmacKey(MNEMONIC), ...extra } : null;
  return { agent: new SparkAgent(wallet, "MAINNET", { seedContext }), wallet };
};

const auditLines = async () => (await readFile(join(dir, "audit.jsonl"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));

describe("SparkAgent sealed policy (lib/policy.js via #authorize)", () => {
  it("allowedOps: a forbidden op is denied before the SDK, an allowed one goes through", async () => {
    const { agent, wallet } = agentWith({ allowedOps: ["spark_transfer"] });
    await expect(agent.withdraw({ to: "bc1qdest", amount: 5000 }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", rule: "allowedOps" });
    expect(wallet.calls.quotes).toBe(0); // denied before the (side-effecting) quote
    await expect(agent.transferTokens({ tokenIdentifier: "btkn1x", amount: 5n, to: "sp1dest" }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", rule: "allowedOps" });
    await expect(agent.claimDeposit({ txid: "ab".repeat(32) }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", rule: "allowedOps" });
    await agent.transfer({ to: "sp1dest", amount: 100 });
    expect(wallet.calls.transfers).toBe(1);
  });

  it("maxPerTxSats: over the cap is denied (also on a dry run); at the cap passes", async () => {
    const { agent, wallet } = agentWith({ maxPerTxSats: 1_000 });
    await expect(agent.transfer({ to: "sp1dest", amount: 1_001 }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", rule: "maxPerTxSats", reason: /1001 sats exceeds the 1000-sat/ });
    await expect(agent.transfer({ to: "sp1dest", amount: 1_001, dryRun: true }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", rule: "maxPerTxSats" });
    const preview = await agent.transfer({ to: "sp1dest", amount: 1_000, dryRun: true });
    expect(preview.dryRun).toBe(true);
    await agent.transfer({ to: "sp1dest", amount: 1_000 });
    expect(wallet.calls.transfers).toBe(1);
  });

  it("allowedRecipients (sealed): unlisted destinations are refused for transfers, withdrawals, and token sends", async () => {
    const { agent, wallet } = agentWith({ allowedRecipients: ["sp1good", "bc1qgood"] });
    await expect(agent.transfer({ to: "sp1evil", amount: 10 }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", rule: "allowedRecipients", reason: /sp1evil/ });
    await expect(agent.withdraw({ to: "bc1qevil", amount: 10_000 }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", rule: "allowedRecipients" });
    await expect(agent.transferTokens({ tokenIdentifier: "btkn1x", amount: 5n, to: "sp1evil" }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", rule: "allowedRecipients" });
    await agent.transfer({ to: "sp1good", amount: 10 });
    await agent.transferTokens({ tokenIdentifier: "btkn1x", amount: 5n, to: "sp1good" });
    expect(wallet.calls.transfers).toBe(1);
    expect(wallet.calls.tokens).toBe(1);
  });

  it("expiresAt: spends stop at the deadline; an inbound claim still works", async () => {
    const { agent, wallet } = agentWith({ expiresAt: "2000-01-01T00:00:00Z" });
    await expect(agent.transfer({ to: "sp1dest", amount: 10 }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", rule: "expiresAt" });
    await agent.claimDeposit({ txid: "ab".repeat(32) });
    expect(wallet.calls.claims).toBe(1);
  });

  it("exec hook: sees real amount + daily total, can deny, is skipped on dry runs, and blocks the SDK", async () => {
    const hook = join(dir, "hook.sh");
    // allow anything under 500 sats when the daily total is still under 1000; record every call
    await writeFile(hook, [
      "#!/bin/sh",
      "CTX=$(cat)",
      `printf '%s\\n' "$CTX" >> "${dir}/hook.log"`,
      `printf '%s' "$CTX" | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8"));const ok=c.amountSats<500&&c.dailyTotalSats<1000;process.stdout.write(JSON.stringify(ok?{allow:true}:{allow:false,reason:"hook: "+c.amountSats+" sats with "+c.dailyTotalSats+" spent today"}))'`,
    ].join("\n"), { mode: 0o700 });
    await chmod(hook, 0o700);
    const exec = { path: hook, sha256: await sha256File(hook) };
    process.env.SPARK_DAILY_BUDGET_SATS = "10000"; // unbound env ledger so dailyTotalSats is real
    const { agent, wallet } = agentWith({ exec });
    // dry run: declarative pass, hook NOT consulted
    await agent.transfer({ to: "sp1dest", amount: 400, dryRun: true });
    await expect(access(join(dir, "hook.log"))).rejects.toThrow();
    // live: allowed
    await agent.transfer({ to: "sp1dest", amount: 400 });
    expect(wallet.calls.transfers).toBe(1);
    // live: denied by the hook with its reason; SDK untouched
    await expect(agent.transfer({ to: "sp1dest", amount: 600 }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", rule: "exec", reason: /hook: 600 sats with 400 spent today/ });
    expect(wallet.calls.transfers).toBe(1);
    const seen = (await readFile(join(dir, "hook.log"), "utf8")).trim().split("\n").map((l) => JSON.parse(l));
    expect(seen.map((c) => [c.op, c.amountSats, c.dailyTotalSats, c.dryRun])).toEqual([
      ["spark_transfer", 400, 0, false],
      ["spark_transfer", 600, 400, false],
    ]);
    expect(seen[0]).not.toHaveProperty("mnemonic");
    expect(seen[0]).not.toHaveProperty("passphrase");
  });

  it("budget denial happens BEFORE the hook (no paging a human for a spend the ledger refuses) and is audited", async () => {
    const hook = join(dir, "hook.sh");
    await writeFile(hook, `#!/bin/sh\ntouch "${dir}/hook.ran"\nprintf '{"allow":true}'\n`, { mode: 0o700 });
    const exec = { path: hook, sha256: await sha256File(hook) };
    process.env.SPARK_DAILY_BUDGET_SATS = "500";
    const { agent, wallet } = agentWith({ exec });
    await expect(agent.transfer({ to: "sp1dest", amount: 900 })).rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
    await expect(access(join(dir, "hook.ran"))).rejects.toThrow(); // hook never consulted
    expect(wallet.calls.transfers).toBe(0);
    expect((await auditLines()).at(-1)).toMatchObject({ verdict: "deny", rule: "dailyBudgetSats", amountSats: 900 });
    await agent.transfer({ to: "sp1dest", amount: 400 });
    await access(join(dir, "hook.ran")); // within budget → hook consulted → allowed
    expect(wallet.calls.transfers).toBe(1);
  });

  it("policy() reports a fail-closed ledger instead of throwing", async () => {
    // a bound budget with NO signed ledger on disk: spends must refuse, policy() must explain
    const { agent } = agentWith({ dailyBudgetSats: 1000 });
    const p = await agent.policy();
    expect(p.budget).toMatchObject({ error: "SPEND_LEDGER_MISSING", message: /reset-ledger/ });
    await expect(agent.transfer({ to: "sp1dest", amount: 10 })).rejects.toMatchObject({ code: "SPEND_LEDGER_MISSING" });
  });

  it("exec hook: a modified script fails closed", async () => {
    const hook = join(dir, "hook.sh");
    await writeFile(hook, "#!/bin/sh\nprintf '{\"allow\":true}'\n", { mode: 0o700 });
    const exec = { path: hook, sha256: await sha256File(hook) };
    const { agent, wallet } = agentWith({ exec });
    await agent.transfer({ to: "sp1dest", amount: 10 });
    await writeFile(hook, "#!/bin/sh\nprintf '{\"allow\":true}' # tampered\n");
    await expect(agent.transfer({ to: "sp1dest", amount: 10 }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", rule: "exec", reason: /does not match the sealed sha256/ });
    expect(wallet.calls.transfers).toBe(1);
  });

  it("audit log: denials and live outcomes are recorded, with the request but never a secret", async () => {
    const { agent } = agentWith({ maxPerTxSats: 500 });
    await agent.transfer({ to: "sp1dest", amount: 100 });
    await expect(agent.transfer({ to: "sp1dest", amount: 900 })).rejects.toMatchObject({ code: "POLICY_DENIED" });
    await agent.transfer({ to: "sp1dest", amount: 100, dryRun: true }); // previews are not events
    const lines = await auditLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ op: "spark_transfer", amountSats: 100, recipients: ["sp1dest"], verdict: "allow", result: "ok", id: "t1" });
    expect(lines[1]).toMatchObject({ op: "spark_transfer", amountSats: 900, verdict: "deny", rule: "maxPerTxSats" });
    for (const l of lines) {
      expect(typeof l.ts).toBe("string");
      for (const k of Object.keys(l)) expect(k).not.toMatch(/mnemonic|passphrase|preimage|invoice$|bolt11/i);
    }
  });

  it("audit log: SPARK_AUDIT_LOG=off writes nothing; a failing SDK call is recorded as an error", async () => {
    process.env.SPARK_AUDIT_LOG = "off";
    const { agent } = agentWith({ maxPerTxSats: 500 });
    await agent.transfer({ to: "sp1dest", amount: 100 });
    await expect(access(join(dir, "audit.jsonl"))).rejects.toThrow();
    delete process.env.SPARK_AUDIT_LOG;
    const wallet = mkWallet();
    wallet.transfer = async () => { throw new Error("operator offline"); };
    const { agent: a2 } = agentWith({ maxPerTxSats: 500 }, wallet);
    await expect(a2.transfer({ to: "sp1dest", amount: 100 })).rejects.toThrow(/operator offline/);
    expect((await auditLines()).at(-1)).toMatchObject({ verdict: "allow", result: "error", error: /operator offline/ });
  });

  it("policy() reports the sealed rules, live budget, and paths — read-only", async () => {
    const policy = { maxPerTxSats: 500, allowedOps: ["spark_transfer"] };
    const { agent } = agentWith(policy);
    const p = await agent.policy();
    expect(p.sealed).toEqual(policy);
    expect(p.budget).toEqual({ disabled: true });
    expect(p.allowlistPath).toMatch(/recipients\.allow$/);
    expect(p.auditLogPath).toBe(join(dir, "audit.jsonl"));
    p.sealed.maxPerTxSats = 1_000_000; // a copy — the agent's rules are unchanged
    await expect(agent.transfer({ to: "sp1dest", amount: 900 })).rejects.toMatchObject({ rule: "maxPerTxSats" });
  });

  it("a sealed seed whose policy has no budget boots; a sealed seed with NO policy in the process still fails closed", async () => {
    const seedPath = process.env.SPARK_SEED_PATH;
    await saveEncryptedMnemonic({ mnemonic: MNEMONIC, passphrase: PASS, path: seedPath, policy: { allowedOps: ["spark_transfer"] } });
    // the policy reached the process (as loadMnemonicFromEnv would deliver it) → fine, no ledger
    const { agent } = agentWith({ allowedOps: ["spark_transfer"] });
    expect(await agent.spendStatus()).toEqual({ disabled: true });
    // nothing reached the process → the pre-existing "sealed but unbound" guard
    expect(() => new SparkAgent(mkWallet(), "MAINNET", { seedContext: null })).toThrow(/SEALED spending policy/);
    // and a sealed BUDGET still binds the ledger exactly as before
    await initSignedLedger({ path: process.env.SPARK_SPEND_LEDGER_PATH, hmacKey: deriveLedgerHmacKey(MNEMONIC) });
    const { agent: budgeted } = agentWith({ dailyBudgetSats: 150, allowedOps: ["spark_transfer"] });
    await budgeted.transfer({ to: "sp1dest", amount: 100 });
    await expect(budgeted.transfer({ to: "sp1dest", amount: 100 })).rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED" });
  });
});
