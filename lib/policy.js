// Sealed spending policy: validation, evaluation, and the executable hook.
//
// EXPORTS (quick reference):
//   POLICY_OPS / OUTBOUND_OPS   canonical operation names a policy can name
//   validatePolicyObject(policy) → normalized policy | null; throws on any
//                                 unknown key or unreadable value (a typo must
//                                 never silently mean "no rule")
//   evaluatePolicy(ctx, policy, deps) → { allow: true } | { allow: false, rule, reason }
//   runPolicyExec(exec, ctx, opts)   → the executable-hook verdict, never throws
//   PolicyDeniedError                → thrown by SparkAgent on a deny (code POLICY_DENIED)
//   sha256File(path)                 → hex digest, for pinning `exec.path`
//
// The policy object lives INSIDE the encrypted seed payload (lib/encrypted-seed.js
// v2), so it inherits the seed's protections: reading it needs the passphrase,
// changing it is the TTY-gated `sparkbtcbot set-policy` ceremony, and flipping
// bytes fails the GCM tag — no wallet, rather than a looser wallet. That is the
// whole reason the rules are sealed and not a sidecar JSON file the agent's own
// process could edit.
//
// Rule order (cheapest first, first deny wins, AND semantics):
//   expiresAt → allowedOps → allowedRecipients → maxPerTxSats → [ledger, in the
//   caller] → exec hook
// Fee ceilings and the cumulative budget stay where they are in SparkAgent —
// they depend on live quotes and the signed ledger. This module sees the
// REQUEST; the fee guards see the QUOTE.
//
// Honest scope, same sentence as SKILL.md: every rule here runs in the agent's
// own process. It bounds a mistaken or steered agent; a fully compromised
// process holding the passphrase can decrypt the seed with its own code and
// drive the raw SDK past all of it. The control that survives compromise is the
// funded balance, or a proxy/daemon that holds the seed elsewhere.

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

// Canonical operation names — the same strings SparkAgent already uses for the
// spend ledger and dry-run previews, so a policy author never learns a second
// vocabulary. `claim_deposit` is inbound (your own L1 UTXO into Spark, minus an
// SSP fee): allowedOps and the exec hook see it; the outbound-only rules don't.
export const POLICY_OPS = Object.freeze([
  "spark_transfer",
  "lightning_pay",
  "fulfill_spark_invoice",
  "token_transfer",
  "claim_deposit",
  "l1_withdraw",
]);
export const OUTBOUND_OPS = new Set(POLICY_OPS.filter((op) => op !== "claim_deposit"));

export const POLICY_EXEC_TIMEOUT_MS = 5_000;
const POLICY_EXEC_MAX_STDOUT = 64 * 1024;

const POLICY_KEYS = Object.freeze([
  "dailyBudgetSats",
  "maxPerTxSats",
  "allowedOps",
  "allowedRecipients",
  "expiresAt",
  "exec",
]);

export class PolicyDeniedError extends Error {
  constructor({ op, rule, reason, context = null }) {
    super(`Policy denied ${op}: ${reason} [rule: ${rule}]`);
    this.name = "PolicyDeniedError";
    this.code = "POLICY_DENIED";
    this.op = op;
    this.rule = rule;
    this.reason = reason;
    this.context = context;
  }
}

function positiveSats(name, value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`seed policy ${name} must be a positive integer number of sats, got ${JSON.stringify(value)}`);
  }
  return value;
}

// Validate + normalize. `null`/`undefined` → null (no policy). An empty object
// is an error, not "no policy": an operator who sealed `{}` meant to seal
// something. Every key is optional; unknown keys throw (misspelled-option
// doctrine — `allowedOp` must not silently allow everything).
export function validatePolicyObject(policy) {
  if (policy == null) return null;
  if (typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("seed policy must be an object like { dailyBudgetSats: <sats>, ... }");
  }
  const unknown = Object.keys(policy).filter((k) => !POLICY_KEYS.includes(k));
  if (unknown.length) {
    throw new Error(`seed policy has unknown key(s): ${unknown.join(", ")} — supported: ${POLICY_KEYS.join(", ")}`);
  }
  const out = {};
  if (policy.dailyBudgetSats !== undefined) out.dailyBudgetSats = positiveSats("dailyBudgetSats", policy.dailyBudgetSats);
  if (policy.maxPerTxSats !== undefined) out.maxPerTxSats = positiveSats("maxPerTxSats", policy.maxPerTxSats);
  if (policy.allowedOps !== undefined) {
    const ops = policy.allowedOps;
    if (!Array.isArray(ops) || ops.length === 0 || !ops.every((o) => typeof o === "string")) {
      throw new Error(`seed policy allowedOps must be a non-empty array of operation names (${POLICY_OPS.join(", ")})`);
    }
    const bad = ops.filter((o) => !POLICY_OPS.includes(o));
    if (bad.length) {
      throw new Error(`seed policy allowedOps has unknown operation(s): ${bad.join(", ")} — supported: ${POLICY_OPS.join(", ")}`);
    }
    out.allowedOps = [...new Set(ops)];
  }
  if (policy.allowedRecipients !== undefined) {
    const list = policy.allowedRecipients;
    if (!Array.isArray(list) || list.length === 0 || !list.every((a) => typeof a === "string" && a.trim())) {
      throw new Error("seed policy allowedRecipients must be a non-empty array of address strings");
    }
    out.allowedRecipients = [...new Set(list.map((a) => a.trim()))];
  }
  if (policy.expiresAt !== undefined) {
    const t = policy.expiresAt;
    if (typeof t !== "string" || !Number.isFinite(Date.parse(t))) {
      throw new Error(`seed policy expiresAt must be an ISO-8601 timestamp string, got ${JSON.stringify(t)}`);
    }
    out.expiresAt = new Date(Date.parse(t)).toISOString();
  }
  if (policy.exec !== undefined) {
    const e = policy.exec;
    if (e == null || typeof e !== "object" || Array.isArray(e)) {
      throw new Error("seed policy exec must be an object { path, sha256 }");
    }
    const extra = Object.keys(e).filter((k) => k !== "path" && k !== "sha256");
    if (extra.length) throw new Error(`seed policy exec has unknown key(s): ${extra.join(", ")} — supported: path, sha256`);
    if (typeof e.path !== "string" || !isAbsolute(e.path)) {
      throw new Error("seed policy exec.path must be an absolute path to the policy executable");
    }
    if (typeof e.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(e.sha256)) {
      throw new Error("seed policy exec.sha256 must be the 64-hex sha256 of the executable (set-policy computes it)");
    }
    out.exec = { path: e.path, sha256: e.sha256 };
  }
  if (Object.keys(out).length === 0) {
    throw new Error("seed policy must set at least one rule (or be null to remove the policy)");
  }
  return out;
}

export async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

// Declarative rules. `deps.matchRecipient(recipient, list)` is injected by the
// caller so Spark-invoice receivers (identity-key match across address
// encodings) and plain addresses share one matcher with the file allowlist.
export function evaluateDeclarativeRules(ctx, policy, { matchRecipient, now = Date.now() } = {}) {
  if (!policy) return { allow: true };
  const outbound = OUTBOUND_OPS.has(ctx.op);

  if (policy.expiresAt && outbound && now > Date.parse(policy.expiresAt)) {
    return {
      allow: false,
      rule: "expiresAt",
      reason: `this wallet's spend authority expired at ${policy.expiresAt} — reads still work; re-seal with set-policy to extend`,
    };
  }
  if (policy.allowedOps && !policy.allowedOps.includes(ctx.op)) {
    return {
      allow: false,
      rule: "allowedOps",
      reason: `${ctx.op} is not in allowedOps [${policy.allowedOps.join(", ")}]`,
    };
  }
  if (policy.allowedRecipients && outbound && ctx.recipients?.length) {
    const match = typeof matchRecipient === "function"
      ? matchRecipient
      : (recipient, list) => list.includes(recipient);
    for (const recipient of ctx.recipients) {
      if (!match(recipient, policy.allowedRecipients)) {
        return {
          allow: false,
          rule: "allowedRecipients",
          reason: `recipient ${recipient} is not in the sealed allowlist (${policy.allowedRecipients.length} entr${policy.allowedRecipients.length === 1 ? "y" : "ies"}) — add it with set-policy`,
        };
      }
    }
  }
  if (policy.maxPerTxSats != null && outbound && ctx.unit !== "tokens") {
    const amt = ctx.amountSats;
    if (typeof amt !== "number" || !Number.isFinite(amt)) {
      return {
        allow: false,
        rule: "maxPerTxSats",
        reason: `amount is unreadable, so it cannot be checked against the ${policy.maxPerTxSats}-sat per-transaction cap — refusing`,
      };
    }
    if (amt > policy.maxPerTxSats) {
      return {
        allow: false,
        rule: "maxPerTxSats",
        reason: `${amt} sats exceeds the ${policy.maxPerTxSats}-sat per-transaction cap`,
      };
    }
  }
  return { allow: true };
}

// The executable hook — the same wire contract as OWS executable policies
// (docs/03-policy-engine.md there, MIT): PolicyContext JSON on stdin, ONE JSON
// object `{ "allow": bool, "reason"?: string }` on stdout. Everything that is
// not a well-formed allow is a deny, with a reason naming the failure class:
//   exit != 0 / not JSON / no boolean `allow` / > timeout / not found / not
//   executable / sha256 mismatch → deny.
// The path AND its hash come from the sealed policy, so the agent's process
// cannot repoint the hook or swap the script (the two ways the same design is
// hollow when the policy file is plaintext). Never throws.
export async function runPolicyExec(exec, ctx, { timeoutMs = POLICY_EXEC_TIMEOUT_MS } = {}) {
  const deny = (reason) => ({ allow: false, rule: "exec", reason });
  if (!exec?.path) return { allow: true };
  let digest;
  try {
    const st = await stat(exec.path);
    if (!st.isFile()) return deny(`policy executable ${exec.path} is not a regular file`);
    digest = await sha256File(exec.path);
  } catch (err) {
    return deny(`policy executable ${exec.path} is unreadable (${err?.code ?? err?.message ?? err})`);
  }
  if (digest !== exec.sha256) {
    return deny(`policy executable ${exec.path} does not match the sealed sha256 (${digest.slice(0, 12)}… vs ${exec.sha256.slice(0, 12)}…) — it was modified since set-policy pinned it`);
  }
  return await new Promise((resolve) => {
    // The hook inherits the environment minus the passphrase: SparkAgent's boot
    // already deleted it from process.env, but a hook must never be the path by
    // which it leaks into a child process's /proc/[pid]/environ.
    const env = { ...process.env };
    delete env.SPARK_PASSPHRASE;
    let child;
    try {
      child = spawn(exec.path, [], { stdio: ["pipe", "pipe", "pipe"], env });
    } catch (err) {
      return resolve(deny(`policy executable failed to start: ${err?.message ?? err}`));
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (verdict) => { if (!settled) { settled = true; resolve(verdict); } };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      finish(deny(`policy executable did not answer within ${timeoutMs} ms — killed`));
    }, timeoutMs);
    child.on("error", (err) => {
      clearTimeout(timer);
      finish(deny(`policy executable failed to start: ${err?.code === "ENOENT" ? "not found" : err?.code === "EACCES" ? "not executable" : (err?.message ?? err)}`));
    });
    child.stdout.on("data", (d) => { if (stdout.length < POLICY_EXEC_MAX_STDOUT) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length < 4096) stderr += d; });
    child.on("close", (code) => {
      clearTimeout(timer);
      const tail = stderr.trim() ? ` (stderr: ${stderr.trim().slice(0, 200)})` : "";
      if (code !== 0) return finish(deny(`policy executable exited with code ${code}${tail}`));
      let parsed;
      try { parsed = JSON.parse(stdout); } catch { return finish(deny(`policy executable did not print a JSON object${tail}`)); }
      if (parsed == null || typeof parsed !== "object" || typeof parsed.allow !== "boolean") {
        return finish(deny(`policy executable's JSON has no boolean "allow"${tail}`));
      }
      if (parsed.allow) return finish({ allow: true });
      const reason = typeof parsed.reason === "string" && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 500)
        : "denied by the policy executable (no reason given)";
      finish(deny(reason));
    });
    try {
      child.stdin.on("error", () => { /* child exited before reading — verdict comes from close */ });
      child.stdin.end(JSON.stringify(ctx));
    } catch { /* same */ }
  });
}

// Declarative rules, then (for LIVE calls only) the exec hook. A dry run is a
// preview: the built-in rules answer truthfully so a preview can't be used to
// confirm a send the policy would refuse, but the operator's own hook — which
// may page a human — is not fired for a look.
export async function evaluatePolicy(ctx, policy, deps = {}) {
  const v = evaluateDeclarativeRules(ctx, policy, deps);
  if (!v.allow) return v;
  if (policy?.exec && !ctx.dryRun) return await runPolicyExec(policy.exec, ctx, deps);
  return { allow: true };
}
