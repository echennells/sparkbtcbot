// lib/policy.js — the sealed policy's validator, declarative rules, and the
// executable hook. The hook's contract is the one place this project runs an
// operator-supplied program in the money path, so every failure class in the
// documented fail-closed table gets a pinned test: exit code, bad JSON, no
// boolean, timeout, missing file, modified file, not executable → deny.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  validatePolicyObject,
  evaluateDeclarativeRules,
  evaluatePolicy,
  runPolicyExec,
  sha256File,
  PolicyDeniedError,
  POLICY_OPS,
  OUTBOUND_OPS,
} from "../../lib/policy.js";

const ctxFor = (over = {}) => ({
  v: 1, op: "spark_transfer", outbound: true, amountSats: 1_000, unit: "sats", recipients: ["sp1pabc"],
  dailyTotalSats: 0, dailyBudgetSats: null, remainingSats: null, walletAddress: "sp1me", network: "MAINNET",
  dryRun: false, timestamp: "2026-09-19T00:00:00.000Z", ...over,
});

describe("validatePolicyObject", () => {
  it("null/undefined mean no policy; {} is an error, not an empty policy", () => {
    expect(validatePolicyObject(null)).toBeNull();
    expect(validatePolicyObject(undefined)).toBeNull();
    expect(() => validatePolicyObject({})).toThrow(/at least one rule/);
  });

  it("accepts every documented key and normalizes", () => {
    const p = validatePolicyObject({
      dailyBudgetSats: 50_000,
      maxPerTxSats: 10_000,
      allowedOps: ["lightning_pay", "spark_transfer", "lightning_pay"],
      allowedRecipients: [" sp1pabc ", "bc1qxyz"],
      expiresAt: "2026-12-31T23:59:59Z",
      exec: { path: "/usr/local/bin/approve", sha256: "a".repeat(64) },
    });
    expect(p).toEqual({
      dailyBudgetSats: 50_000,
      maxPerTxSats: 10_000,
      allowedOps: ["lightning_pay", "spark_transfer"],
      allowedRecipients: ["sp1pabc", "bc1qxyz"],
      expiresAt: "2026-12-31T23:59:59.000Z",
      exec: { path: "/usr/local/bin/approve", sha256: "a".repeat(64) },
    });
  });

  it("unknown keys, unknown ops, relative exec paths, and bad hashes are refused (a typo must not mean 'no rule')", () => {
    expect(() => validatePolicyObject({ allowedOp: ["spark_transfer"] })).toThrow(/unknown key/);
    expect(() => validatePolicyObject({ allowedOps: ["withdraw"] })).toThrow(/unknown operation/);
    expect(() => validatePolicyObject({ allowedOps: [] })).toThrow(/non-empty/);
    expect(() => validatePolicyObject({ allowedRecipients: ["", "x"] })).toThrow(/address strings/);
    expect(() => validatePolicyObject({ expiresAt: "tomorrow" })).toThrow(/ISO-8601/);
    expect(() => validatePolicyObject({ maxPerTxSats: 0 })).toThrow(/positive integer/);
    expect(() => validatePolicyObject({ maxPerTxSats: "100" })).toThrow(/positive integer/);
    expect(() => validatePolicyObject({ exec: { path: "approve.sh", sha256: "a".repeat(64) } })).toThrow(/absolute/);
    expect(() => validatePolicyObject({ exec: { path: "/x", sha256: "nope" } })).toThrow(/sha256/);
    expect(() => validatePolicyObject({ exec: { path: "/x", sha256: "a".repeat(64), args: [] } })).toThrow(/unknown key/);
  });

  it("op vocabulary: claim_deposit is the one inbound op", () => {
    expect(POLICY_OPS).toContain("claim_deposit");
    expect(OUTBOUND_OPS.has("claim_deposit")).toBe(false);
    for (const op of POLICY_OPS.filter((o) => o !== "claim_deposit")) expect(OUTBOUND_OPS.has(op)).toBe(true);
  });
});

describe("evaluateDeclarativeRules", () => {
  it("no policy → allow", () => {
    expect(evaluateDeclarativeRules(ctxFor(), null)).toEqual({ allow: true });
  });

  it("expiresAt blocks outbound ops after the deadline, never inbound claims, never before", () => {
    const policy = { expiresAt: "2026-09-01T00:00:00.000Z" };
    const late = Date.parse("2026-09-02T00:00:00Z");
    const early = Date.parse("2026-08-01T00:00:00Z");
    expect(evaluateDeclarativeRules(ctxFor(), policy, { now: late })).toMatchObject({ allow: false, rule: "expiresAt" });
    expect(evaluateDeclarativeRules(ctxFor(), policy, { now: early })).toEqual({ allow: true });
    expect(evaluateDeclarativeRules(ctxFor({ op: "claim_deposit", outbound: false, recipients: [] }), policy, { now: late })).toEqual({ allow: true });
  });

  it("allowedOps gates every op including claims", () => {
    const policy = { allowedOps: ["lightning_pay"] };
    expect(evaluateDeclarativeRules(ctxFor({ op: "lightning_pay", recipients: [] }), policy)).toEqual({ allow: true });
    expect(evaluateDeclarativeRules(ctxFor(), policy)).toMatchObject({ allow: false, rule: "allowedOps", reason: /spark_transfer is not in allowedOps/ });
    expect(evaluateDeclarativeRules(ctxFor({ op: "claim_deposit", outbound: false, recipients: [] }), policy)).toMatchObject({ allow: false, rule: "allowedOps" });
  });

  it("allowedRecipients: every recipient must match; the caller's matcher is used when given", () => {
    const policy = { allowedRecipients: ["sp1pabc", "bc1qxyz"] };
    expect(evaluateDeclarativeRules(ctxFor({ recipients: ["sp1pabc"] }), policy)).toEqual({ allow: true });
    expect(evaluateDeclarativeRules(ctxFor({ recipients: ["sp1pabc", "sp1pEVIL"] }), policy))
      .toMatchObject({ allow: false, rule: "allowedRecipients", reason: /sp1pEVIL/ });
    // identity-key style matcher: anything starting with "sp1p" counts
    const matchRecipient = (r, list) => list.some((e) => e.slice(0, 4) === r.slice(0, 4));
    expect(evaluateDeclarativeRules(ctxFor({ recipients: ["sp1pOTHER"] }), policy, { matchRecipient })).toEqual({ allow: true });
    // no recipients (lightning) → the rule has nothing to check
    expect(evaluateDeclarativeRules(ctxFor({ op: "lightning_pay", recipients: [] }), policy)).toEqual({ allow: true });
  });

  it("maxPerTxSats: over → deny, unreadable amount → deny (fail closed), token transfers exempt", () => {
    const policy = { maxPerTxSats: 10_000 };
    expect(evaluateDeclarativeRules(ctxFor({ amountSats: 10_000 }), policy)).toEqual({ allow: true });
    expect(evaluateDeclarativeRules(ctxFor({ amountSats: 10_001 }), policy)).toMatchObject({ allow: false, rule: "maxPerTxSats", reason: /10001 sats exceeds/ });
    expect(evaluateDeclarativeRules(ctxFor({ amountSats: null }), policy)).toMatchObject({ allow: false, rule: "maxPerTxSats", reason: /unreadable/ });
    expect(evaluateDeclarativeRules(ctxFor({ op: "token_transfer", unit: "tokens", amountSats: null }), policy)).toEqual({ allow: true });
  });

  it("first deny wins in documented order: expiresAt before allowedOps before recipients before cap", () => {
    const policy = { expiresAt: "2000-01-01T00:00:00.000Z", allowedOps: ["l1_withdraw"], allowedRecipients: ["x"], maxPerTxSats: 1 };
    expect(evaluateDeclarativeRules(ctxFor(), policy).rule).toBe("expiresAt");
    expect(evaluateDeclarativeRules(ctxFor(), { ...policy, expiresAt: undefined }).rule).toBe("allowedOps");
    expect(evaluateDeclarativeRules(ctxFor(), { allowedRecipients: ["x"], maxPerTxSats: 1 }).rule).toBe("allowedRecipients");
    expect(evaluateDeclarativeRules(ctxFor(), { maxPerTxSats: 1 }).rule).toBe("maxPerTxSats");
  });
});

describe("runPolicyExec — the fail-closed table", () => {
  let dir;
  const script = async (name, body, mode = 0o700) => {
    const p = join(dir, name);
    await writeFile(p, body, { mode });
    await chmod(p, mode);
    return { path: p, sha256: await sha256File(p) };
  };
  beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), "policy-exec-")); });
  afterAll(async () => { await rm(dir, { recursive: true, force: true }); });

  it("a well-formed allow passes; the context arrives on stdin", async () => {
    const exec = await script("allow.sh", "#!/bin/sh\ncat > \"$0.ctx\"\nprintf '{\"allow\":true}'\n");
    const ctx = ctxFor({ amountSats: 4242 });
    expect(await runPolicyExec(exec, ctx)).toEqual({ allow: true });
    const { readFile } = await import("node:fs/promises");
    expect(JSON.parse(await readFile(exec.path + ".ctx", "utf8"))).toMatchObject({ op: "spark_transfer", amountSats: 4242 });
  });

  it("a deny carries the script's reason (trimmed, bounded)", async () => {
    const exec = await script("deny.sh", "#!/bin/sh\nprintf '{\"allow\":false,\"reason\":\"  over the per-merchant cap  \"}'\n");
    expect(await runPolicyExec(exec, ctxFor())).toEqual({ allow: false, rule: "exec", reason: "over the per-merchant cap" });
  });

  it("non-zero exit → deny, even if stdout says allow", async () => {
    const exec = await script("crash.sh", "#!/bin/sh\nprintf '{\"allow\":true}'\necho boom >&2\nexit 3\n");
    expect(await runPolicyExec(exec, ctxFor())).toMatchObject({ allow: false, rule: "exec", reason: /exited with code 3.*boom/ });
  });

  it("not JSON / no boolean allow → deny", async () => {
    const a = await script("text.sh", "#!/bin/sh\necho yes\n");
    expect(await runPolicyExec(a, ctxFor())).toMatchObject({ allow: false, reason: /JSON object/ });
    const b = await script("string.sh", "#!/bin/sh\nprintf '{\"allow\":\"true\"}'\n");
    expect(await runPolicyExec(b, ctxFor())).toMatchObject({ allow: false, reason: /boolean "allow"/ });
  });

  it("timeout → killed and denied", async () => {
    const exec = await script("slow.sh", "#!/bin/sh\nsleep 5\nprintf '{\"allow\":true}'\n");
    const t0 = Date.now();
    expect(await runPolicyExec(exec, ctxFor(), { timeoutMs: 300 })).toMatchObject({ allow: false, reason: /did not answer within 300 ms/ });
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  it("missing file, modified file (sha mismatch), and not-executable → deny", async () => {
    expect(await runPolicyExec({ path: join(dir, "nope.sh"), sha256: "a".repeat(64) }, ctxFor()))
      .toMatchObject({ allow: false, reason: /unreadable/ });
    const exec = await script("mod.sh", "#!/bin/sh\nprintf '{\"allow\":true}'\n");
    await writeFile(exec.path, "#!/bin/sh\nprintf '{\"allow\":true}' # edited\n");
    expect(await runPolicyExec(exec, ctxFor())).toMatchObject({ allow: false, reason: /does not match the sealed sha256/ });
    const noexec = await script("noexec.sh", "#!/bin/sh\nprintf '{\"allow\":true}'\n", 0o600);
    expect(await runPolicyExec(noexec, ctxFor())).toMatchObject({ allow: false, reason: /not executable|EACCES|failed to start/ });
  });

  it("the hook never inherits SPARK_PASSPHRASE", async () => {
    const exec = await script("env.sh", "#!/bin/sh\nif [ -n \"$SPARK_PASSPHRASE\" ]; then printf '{\"allow\":false,\"reason\":\"leaked\"}'; else printf '{\"allow\":true}'; fi\n");
    const saved = process.env.SPARK_PASSPHRASE;
    process.env.SPARK_PASSPHRASE = "hunter2hunter2";
    try {
      expect(await runPolicyExec(exec, ctxFor())).toEqual({ allow: true });
    } finally {
      if (saved === undefined) delete process.env.SPARK_PASSPHRASE; else process.env.SPARK_PASSPHRASE = saved;
    }
  });

  it("evaluatePolicy runs declarative rules first and skips the hook on a dry run", async () => {
    const exec = await script("marker.sh", "#!/bin/sh\ntouch \"$0.ran\"\nprintf '{\"allow\":true}'\n");
    const policy = { allowedOps: ["spark_transfer"], exec };
    expect(await evaluatePolicy(ctxFor({ dryRun: true }), policy)).toEqual({ allow: true });
    const { access } = await import("node:fs/promises");
    await expect(access(exec.path + ".ran")).rejects.toThrow(); // hook not fired for a preview
    expect(await evaluatePolicy(ctxFor({ op: "l1_withdraw" }), policy)).toMatchObject({ allow: false, rule: "allowedOps" });
    await expect(access(exec.path + ".ran")).rejects.toThrow(); // and not for a declarative deny
    expect(await evaluatePolicy(ctxFor(), policy)).toEqual({ allow: true });
    await access(exec.path + ".ran"); // live + rules passed → hook ran
  });
});

describe("PolicyDeniedError", () => {
  it("carries code, op, rule, reason, and context", () => {
    const e = new PolicyDeniedError({ op: "l1_withdraw", rule: "allowedOps", reason: "nope", context: { op: "l1_withdraw" } });
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe("POLICY_DENIED");
    expect(e.rule).toBe("allowedOps");
    expect(e.message).toMatch(/Policy denied l1_withdraw: nope \[rule: allowedOps\]/);
  });
});
