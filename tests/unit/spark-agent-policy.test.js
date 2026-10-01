// The sealed policy as SparkAgent enforces it: one gate (#authorize) in front
// of every money-moving method, before any SDK call. Pins: each rule denies
// with POLICY_DENIED + the rule name and the SDK is never reached; dry runs are
// refused by the declarative rules but do not fire the operator's hook; the
// hook sees real amounts and the real daily total; every denial and live
// outcome lands in the audit log with no secret-shaped key; and a v2 seed whose
// sealed policy has NO budget boots (the "sealed but unbound" guard must only
// fire when no policy reached the process at all).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, chmod, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SparkValidationError } from "@buildonspark/spark-sdk";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { sha256File } from "../../lib/policy.js";
import { saveEncryptedMnemonic, deriveLedgerHmacKey } from "../../lib/encrypted-seed.js";
import { initSignedLedger } from "../../lib/spend-ledger.js";

const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const PASS = "correct horse battery staple";
// Real bech32m token identifiers (32 bytes of 0x01 / 0x02): SparkAgent now
// decodes and canonicalizes every token id before the policy sees it.
const TOKEN = "btkn1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqst3p42v";
const TOKEN_B = "btkn1qgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqx8xjly";

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
    await expect(agent.transferTokens({ tokenIdentifier: TOKEN, amount: 5n, to: "sp1dest" }))
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
    await expect(agent.transferTokens({ tokenIdentifier: TOKEN, amount: 5n, to: "sp1evil" }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", rule: "allowedRecipients" });
    await agent.transfer({ to: "sp1good", amount: 10 });
    await agent.transferTokens({ tokenIdentifier: TOKEN, amount: 5n, to: "sp1good" });
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

  it("audit log: SPARK_AUDIT_LOG=off writes nothing; a failed SDK call is 'error' only when nothing was sent", async () => {
    process.env.SPARK_AUDIT_LOG = "off";
    const { agent } = agentWith({ maxPerTxSats: 500 });
    await agent.transfer({ to: "sp1dest", amount: 100 });
    await expect(access(join(dir, "audit.jsonl"))).rejects.toThrow();
    delete process.env.SPARK_AUDIT_LOG;
    const wallet = mkWallet();
    wallet.transfer = async () => { throw new Error("operator offline"); };
    const { agent: a2 } = agentWith({ maxPerTxSats: 500 }, wallet);
    await expect(a2.transfer({ to: "sp1dest", amount: 100 })).rejects.toMatchObject({ code: "PAYMENT_COMMITTED" });
    expect((await auditLines()).at(-1)).toMatchObject({ verdict: "allow", result: "unknown", error: /operator offline/ });
    wallet.transfer = async () => { throw new SparkValidationError("Amount must be greater than 0", { field: "amountSats" }); };
    await expect(a2.transfer({ to: "sp1dest", amount: 100 })).rejects.toMatchObject({ name: "SparkValidationError" });
    expect((await auditLines()).at(-1)).toMatchObject({ verdict: "allow", result: "error", error: /greater than 0/ });
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

// Token sends get the sats guards, per token (tokenLimits). Before this, a
// token send was bounded only by the allowlists: maxPerTxSats skipped tokens
// and the ledger recorded sats only, so a whole stablecoin balance could leave
// in one call — or a loop — with every sats limit in place. Limits are sealed
// as TOKEN amounts; the agent reads each token's decimals from the wallet's
// own metadata at send time. Here TOKEN has 2 decimals ("10" = 1000 base
// units) and TOKEN_B has 0.
describe("SparkAgent token guards (tokenLimits, ledger, outcome)", () => {
  const TOKEN_RT = "btknrt1qyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqszqgpqyqsg06rn8"; // same bytes, regtest
  const DECIMALS = { [TOKEN]: 2, [TOKEN_B]: 0 };
  const mkTokenWallet = ({ transferError, batchError, decimals = DECIMALS } = {}) => {
    const calls = { tokens: [], batches: [], fulfills: [], balances: 0 };
    return {
      calls,
      getSparkAddress: async () => "sp1from",
      getBalance: async () => {
        calls.balances++;
        return {
          satsBalance: { available: 0n, owned: 0n, incoming: 0n },
          tokenBalances: new Map(Object.entries(decimals).map(([id, d]) => [id, { ownedBalance: 10n ** 12n, tokenMetadata: { decimals: d, tokenTicker: "TKN" } }])),
        };
      },
      transferTokens: async (args) => { if (transferError) throw transferError; calls.tokens.push(args); return `tx${calls.tokens.length}`; },
      batchTransferTokens: async (outs) => { if (batchError) throw batchError; calls.batches.push(outs); return `btx${calls.batches.length}`; },
      fulfillSparkInvoice: async (inv) => { calls.fulfills.push(inv); return { satsTransactionSuccess: [], satsTransactionErrors: [], tokenTransactionSuccess: [], tokenTransactionErrors: [], invalidInvoices: [] }; },
    };
  };
  const sealedAgent = async (policy, wallet = mkTokenWallet()) => {
    const key = deriveLedgerHmacKey(MNEMONIC);
    await initSignedLedger({ path: join(dir, "ledger.json"), hmacKey: key }); // what set-policy writes
    return { agent: new SparkAgent(wallet, "MAINNET", { seedContext: { policy, ledgerHmacKey: key } }), wallet };
  };

  it("maxPerTx is a token amount, converted with the wallet's decimals; over it is denied (also on a dry run) before the SDK", async () => {
    const { agent, wallet } = agentWith({ tokenLimits: { [TOKEN]: { maxPerTx: "10" } } }, mkTokenWallet());
    await expect(agent.transferTokens({ tokenIdentifier: TOKEN, amount: 1001n, to: "sp1dest" }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", rule: "tokenLimits", reason: /10\.01 of btkn1.* exceeds its 10 per-transaction cap/ });
    await expect(agent.transferTokens({ tokenIdentifier: TOKEN, amount: 1001n, to: "sp1dest", dryRun: true }))
      .rejects.toMatchObject({ rule: "tokenLimits" });
    expect(wallet.calls.tokens).toHaveLength(0);
    await agent.transferTokens({ tokenIdentifier: TOKEN, amount: 1000, to: "sp1dest" }); // 10.00 exactly; a number is normalized
    expect(wallet.calls.tokens).toEqual([{ tokenIdentifier: TOKEN, tokenAmount: 1000n, receiverSparkAddress: "sp1dest" }]);
  });

  it("the wallet's decimals decide what a limit means: the same \"10\" is 10 base units of a 0-decimal token", async () => {
    const { agent } = agentWith({ tokenLimits: { [TOKEN_B]: { maxPerTx: "10" } } }, mkTokenWallet());
    await expect(agent.transferTokens({ tokenIdentifier: TOKEN_B, amount: 11n, to: "sp1dest" })).rejects.toMatchObject({ rule: "tokenLimits" });
    await agent.transferTokens({ tokenIdentifier: TOKEN_B, amount: 10n, to: "sp1dest" });
  });

  it("no decimals for the token (the wallet doesn't hold it), or a limit more precise than the token: refused, never rounded", async () => {
    const { agent: noMeta } = agentWith({ tokenLimits: { [TOKEN]: { maxPerTx: "10" } } }, mkTokenWallet({ decimals: {} }));
    await expect(noMeta.transferTokens({ tokenIdentifier: TOKEN, amount: 1n, to: "sp1dest" }))
      .rejects.toMatchObject({ rule: "tokenLimits", reason: /decimals .* are unknown .* does it hold this token/ });
    const { agent: precise } = agentWith({ tokenLimits: { [TOKEN]: { maxPerTx: "10.005" } } }, mkTokenWallet());
    await expect(precise.transferTokens({ tokenIdentifier: TOKEN, amount: 1n, to: "sp1dest" }))
      .rejects.toMatchObject({ rule: "tokenLimits", reason: /more decimal places than the token \(2\) — refusing rather than rounding/ });
  });

  it("without a sealed tokenLimits, token sends never read the wallet's balance", async () => {
    const { agent, wallet } = agentWith({ maxPerTxSats: 5 }, mkTokenWallet());
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await agent.transferTokens({ tokenIdentifier: TOKEN, amount: 1n, to: "sp1dest" });
    expect(wallet.calls.balances).toBe(0);
    vi.restoreAllMocks();
  });

  it("a sealed tokenLimits is the token allowlist: an unlisted token is refused", async () => {
    const { agent, wallet } = agentWith({ tokenLimits: { [TOKEN]: { maxPerTx: "10" } } }, mkTokenWallet());
    await expect(agent.transferTokens({ tokenIdentifier: TOKEN_B, amount: 1n, to: "sp1dest" }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", rule: "tokenLimits", reason: /not in the sealed tokenLimits/ });
    expect(wallet.calls.tokens).toHaveLength(0);
  });

  it("a batch is capped by each token's TOTAL, and its dry run shows the totals", async () => {
    const { agent, wallet } = agentWith({ tokenLimits: { [TOKEN]: { maxPerTx: "10" }, [TOKEN_B]: { maxPerTx: "10" } } }, mkTokenWallet());
    const split = [
      { tokenIdentifier: TOKEN, tokenAmount: 600n, receiverSparkAddress: "sp1a" },
      { tokenIdentifier: TOKEN, amount: 600n, to: "sp1b" }, // each under the cap, together over it
    ];
    await expect(agent.batchTransferTokens(split)).rejects.toMatchObject({ rule: "tokenLimits", reason: /^12 of/ });
    expect(wallet.calls.batches).toHaveLength(0);
    const ok = [
      { tokenIdentifier: TOKEN, tokenAmount: 600n, receiverSparkAddress: "sp1a" },
      { tokenIdentifier: TOKEN, tokenAmount: 400n, to: "sp1b" },
      { tokenIdentifier: TOKEN_B, tokenAmount: 10n, to: "sp1c" },
    ];
    const preview = await agent.batchTransferTokens(ok, { dryRun: true });
    expect(preview).toMatchObject({
      dryRun: true,
      operation: "token_transfer",
      totals: [{ tokenIdentifier: TOKEN, amount: "1000" }, { tokenIdentifier: TOKEN_B, amount: "10" }],
    });
    expect(preview.entries[1]).toEqual({ to: "sp1b", tokenIdentifier: TOKEN, amount: "400" });
    expect(wallet.calls.batches).toHaveLength(0);
    await agent.batchTransferTokens(ok);
    expect(wallet.calls.batches[0][1]).toEqual({ tokenIdentifier: TOKEN, tokenAmount: 400n, receiverSparkAddress: "sp1b" });
  });

  it("dailyBudget: token sends are recorded on the signed ledger and the loop stops at the budget, in token amounts", async () => {
    const { agent, wallet } = await sealedAgent({ tokenLimits: { [TOKEN]: { dailyBudget: "10" } } });
    await agent.transferTokens({ tokenIdentifier: TOKEN, amount: 400n, to: "sp1dest" });
    await agent.transferTokens({ tokenIdentifier: TOKEN, amount: 400n, to: "sp1dest" });
    await expect(agent.transferTokens({ tokenIdentifier: TOKEN, amount: 201n, to: "sp1dest" }))
      .rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED", tokenIdentifier: TOKEN, message: /spending 2\.01 of .* its 10 budget \(8 already spent/ });
    expect(wallet.calls.tokens).toHaveLength(2);
    expect((await agent.spendStatus()).tokens[TOKEN]).toEqual({ decimals: 2, spent: "8", spentBaseUnits: "800", budget: "10", remaining: "2" });
    const denial = (await auditLines()).find((l) => l.verdict === "deny");
    expect(denial).toMatchObject({
      rule: "tokenLimits.dailyBudget",
      tokens: [{ tokenIdentifier: TOKEN, amount: "201", decimals: 2, dailyTotal: "800", dailyBudget: "1000", remaining: "200" }],
    });
    await agent.transferTokens({ tokenIdentifier: TOKEN, amount: 200n, to: "sp1dest" }); // exactly the remainder still fits
  });

  it("a token budget alone binds the ledger: deleting it fails closed", async () => {
    const key = deriveLedgerHmacKey(MNEMONIC);
    const agent = new SparkAgent(mkTokenWallet(), "MAINNET", {
      seedContext: { policy: { tokenLimits: { [TOKEN]: { dailyBudget: "10" } } }, ledgerHmacKey: key },
    });
    await expect(agent.transferTokens({ tokenIdentifier: TOKEN, amount: 1n, to: "sp1dest" }))
      .rejects.toMatchObject({ code: "SPEND_LEDGER_MISSING" });
  });

  it("a failure that proves nothing left refunds; any other stays counted and throws PAYMENT_COMMITTED", async () => {
    const insufficient = new SparkValidationError("Insufficient token amount", { field: "tokenAmount" });
    let { agent } = await sealedAgent({ tokenLimits: { [TOKEN]: { dailyBudget: "10" } } }, mkTokenWallet({ transferError: insufficient }));
    await expect(agent.transferTokens({ tokenIdentifier: TOKEN, amount: 900n, to: "sp1dest" })).rejects.toBe(insufficient);
    expect((await agent.spendStatus()).tokens[TOKEN].spentBaseUnits).toBe("0");

    ({ agent } = await sealedAgent({ tokenLimits: { [TOKEN]: { dailyBudget: "10" } } }, mkTokenWallet({ batchError: new Error("deadline exceeded") })));
    await expect(agent.batchTransferTokens([{ tokenIdentifier: TOKEN, tokenAmount: 900n, to: "sp1dest" }]))
      .rejects.toMatchObject({ code: "PAYMENT_COMMITTED", op: "token_transfer" });
    expect((await agent.spendStatus()).tokens[TOKEN]).toMatchObject({ spent: "9", spentBaseUnits: "900" });
    expect((await auditLines()).at(-1)).toMatchObject({ verdict: "allow", result: "unknown" });
  });

  it("inputs are checked before the policy: wrong-network ids, bad amounts, unknown entry keys", async () => {
    const { agent, wallet } = agentWith(null, mkTokenWallet());
    await expect(agent.transferTokens({ tokenIdentifier: TOKEN_RT, amount: 1n, to: "sp1dest" })).rejects.toThrow(/not a MAINNET token identifier/);
    await expect(agent.transferTokens({ tokenIdentifier: TOKEN, amount: 1n })).rejects.toThrow(/`to`.*is required/);
    for (const amount of [0n, -5n, 1.5, "100", 2 ** 60]) {
      await expect(agent.transferTokens({ tokenIdentifier: TOKEN, amount, to: "sp1dest" }), String(amount)).rejects.toThrow(/positive integer/);
    }
    await expect(agent.batchTransferTokens([{ tokenIdentifier: TOKEN, tokenAmount: 1n, to: "sp1a", memo: "x" }])).rejects.toThrow(/unknown option.*memo/);
    await expect(agent.batchTransferTokens([{ tokenIdentifier: TOKEN, tokenAmount: 1n, amount: 1n, to: "sp1a" }])).rejects.toThrow(/both tokenAmount and amount/);
    await expect(agent.batchTransferTokens([])).rejects.toThrow(/non-empty array/);
    await expect(agent.batchTransferTokens([{ tokenIdentifier: TOKEN, tokenAmount: 1n, to: "sp1a" }], { dryrun: true })).rejects.toThrow(/unknown option.*dryrun/);
    // an uppercase id is the same token, canonicalized
    await agent.transferTokens({ tokenIdentifier: TOKEN.toUpperCase(), amount: 1n, to: "sp1dest" });
    expect(wallet.calls.tokens[0].tokenIdentifier).toBe(TOKEN);
  });

  it("a Spark invoice that pays tokens is capped like a token send (identifier decoded from the invoice)", async () => {
    const { secp256k1 } = await import("@noble/curves/secp256k1");
    const { encodeSparkAddress } = await import("@buildonspark/spark-sdk");
    const pk = Buffer.from(secp256k1.getPublicKey(Uint8Array.from([...new Uint8Array(31), 1]), true)).toString("hex");
    const tokenInvoice = (amount) => encodeSparkAddress({
      identityPublicKey: pk,
      network: "MAINNET",
      sparkInvoiceFields: {
        version: 1,
        id: new Uint8Array(16).fill(9),
        paymentType: { $case: "tokensPayment", tokensPayment: { tokenIdentifier: new Uint8Array(32).fill(1), amount: Uint8Array.from([amount >> 8, amount & 0xff]) } },
      },
    });
    const { agent, wallet } = agentWith({ tokenLimits: { [TOKEN]: { maxPerTx: "10" } } }, mkTokenWallet());
    await expect(agent.fulfillInvoice([{ invoice: tokenInvoice(2000) }]))
      .rejects.toMatchObject({ code: "POLICY_DENIED", rule: "tokenLimits", reason: new RegExp(`^20 of ${TOKEN}`) });
    const preview = await agent.fulfillInvoice([{ invoice: tokenInvoice(1000) }], { dryRun: true });
    expect(preview.entries[0]).toMatchObject({ type: "tokens", amount: "1000", tokenIdentifier: TOKEN });
    expect(wallet.calls.fulfills).toHaveLength(0);
  });

  // A sats limit reads like "the agent is bounded", but it never covers
  // tokens. The gap is said outright: in policy(), and once on the first token
  // send when a sats limit exists.
  it("policy().tokens says outright when token amounts are uncapped", async () => {
    expect((await agentWith(null, mkTokenWallet()).agent.policy()).tokens)
      .toEqual({ limited: false, note: expect.stringMatching(/UNCAPPED.*SPARK_DAILY_BUDGET_SATS/) });
    expect((await agentWith({ tokenLimits: { [TOKEN]: { maxPerTx: "5" } } }, mkTokenWallet()).agent.policy()).tokens)
      .toEqual({ limited: true });
  });

  it("warns once, on the first token send, when a sats limit is set and tokens are uncapped", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const warnings = () => warn.mock.calls.filter(([m]) => /does not cover this token send/.test(m)).length;
      process.env.SPARK_DAILY_BUDGET_SATS = "10000";
      const { agent } = agentWith(null, mkTokenWallet());
      await agent.transfer({ to: "sp1dest", amount: 10 }).catch(() => {}); // a sats send says nothing
      expect(warnings()).toBe(0);
      await agent.transferTokens({ tokenIdentifier: TOKEN, amount: 1n, to: "sp1dest", dryRun: true });
      await agent.transferTokens({ tokenIdentifier: TOKEN, amount: 1n, to: "sp1dest" });
      expect(warnings()).toBe(1);

      // a sealed per-tx sats cap counts as a sats limit too
      delete process.env.SPARK_DAILY_BUDGET_SATS;
      await agentWith({ maxPerTxSats: 500 }, mkTokenWallet()).agent.transferTokens({ tokenIdentifier: TOKEN, amount: 1n, to: "sp1dest" });
      expect(warnings()).toBe(2);

      // nothing to say: no sats limit at all, or tokens are capped
      await agentWith(null, mkTokenWallet()).agent.transferTokens({ tokenIdentifier: TOKEN, amount: 1n, to: "sp1dest" });
      await agentWith({ maxPerTxSats: 500, tokenLimits: { [TOKEN]: { maxPerTx: "5" } } }, mkTokenWallet())
        .agent.transferTokens({ tokenIdentifier: TOKEN, amount: 1n, to: "sp1dest" });
      expect(warnings()).toBe(2);
    } finally {
      warn.mockRestore();
    }
  });
});
