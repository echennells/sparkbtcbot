// Sealed spending policy: validation, evaluation, and the executable hook.
//
// EXPORTS (quick reference):
//   POLICY_OPS / OUTBOUND_OPS   canonical operation names a policy can name
//   validatePolicyObject(policy) → normalized policy | null; throws on any
//                                 unknown key or unreadable value (a typo must
//                                 never silently mean "no rule")
//   sealedTokenBudgets(policy)   → { [tokenIdentifier]: dailyBudget } | null
//   policyHasLedgerBudget(policy) → true when a sealed budget (sats or token)
//                                 binds the signed spend ledger
//   tokenLimitBaseUnits(limit, decimals, id) → a token's sealed limits in base
//                                 units, or { error } (decimals unknown, or a
//                                 limit more precise than the token)
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
//   expiresAt → allowedOps → deniedHosts → allowedHosts → allowedRecipients →
//   maxPerTxSats → tokenLimits → [ledger, in the caller] → exec hook
// The host rules apply only to HTTP 402 purchases (a ctx.purchase from
// fetchL402) — the one kind of payment with a host to check.
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
import { parseHumanAmount, toBaseUnits, formatUnits } from "./token-units.js";

// Canonical operation names — the same strings SparkAgent already uses for the
// spend ledger and dry-run previews, so a policy author never learns a second
// vocabulary. `claim_deposit` is inbound (your own L1 UTXO into Spark, minus an
// SSP fee): allowedOps and the exec hook see it; the outbound-only rules don't.
// lightning_pay is a bare BOLT11 payment; http402_pay is a Lightning payment
// SparkAgent makes for an HTTP 402 resource (fetchL402), which carries the
// host it bought from. Separate names let a sealed allowedOps permit paid APIs
// without permitting bare invoices, or the reverse: a host allowlist means
// little while an agent can pay any invoice pasted into its context.
export const POLICY_OPS = Object.freeze([
  "spark_transfer",
  "lightning_pay",
  "http402_pay",
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
  "allowedHosts",
  "deniedHosts",
  "tokenLimits",
  "expiresAt",
  "exec",
]);

// Token caps are per token: sats have one unit, tokens have one per
// identifier (a 6-decimal stablecoin, a 0-decimal points token), so no single
// number can bound them. Keys are bech32m token identifiers (btkn1… mainnet,
// btknrt1… regtest). Amounts are HUMAN token amounts ("25.00" — normalized to
// "25"), as the operator thinks of them; the token's decimals are not in the
// policy. SparkAgent reads them from the wallet's own token metadata at send
// time (a wallet can only send a token it holds, and holding it means the SDK
// has its metadata) and puts them in ctx.tokens[].decimals. Sealing
// tokenLimits also makes it the token allowlist: a token it does not name is
// refused. The checksum is not verified here (this module stays SDK-free);
// set-policy verifies it, and a typo'd key can only refuse the real token,
// never uncap it.
const TOKEN_ID_RE = /^btkn(?:rt|t|s|l)?1[qpzry9x8gf2tvdw0s3jn54khce6mua7l]{6,}$/;
const TOKEN_LIMIT_KEYS = Object.freeze(["maxPerTx", "dailyBudget"]);

function positiveTokenAmount(name, value) {
  const human = parseHumanAmount(value);
  if (human === null) {
    throw new Error(
      `seed policy ${name} must be a positive token amount like "25" or "25.50" (in the token's own units, ` +
        `not base units), got ${JSON.stringify(value)}`,
    );
  }
  return human;
}

function tokenLimitsObject(limits) {
  if (limits == null || typeof limits !== "object" || Array.isArray(limits) || Object.keys(limits).length === 0) {
    throw new Error(
      'seed policy tokenLimits must be a non-empty object keyed by token identifier, like ' +
        '{ "btkn1…": { "maxPerTx": "25", "dailyBudget": "100" } } (amounts in the token\'s own units)',
    );
  }
  const out = {};
  for (const [rawId, entry] of Object.entries(limits)) {
    const id = rawId.trim();
    if (!TOKEN_ID_RE.test(id)) {
      throw new Error(
        `seed policy tokenLimits key ${JSON.stringify(rawId)} is not a lowercase bech32m token identifier ` +
          "(btkn1… on mainnet, btknrt1… on regtest)",
      );
    }
    if (out[id]) throw new Error(`seed policy tokenLimits lists ${id} twice`);
    if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`seed policy tokenLimits[${id}] must be an object { maxPerTx?, dailyBudget? }`);
    }
    const unknown = Object.keys(entry).filter((k) => !TOKEN_LIMIT_KEYS.includes(k));
    if (unknown.length) {
      throw new Error(`seed policy tokenLimits[${id}] has unknown key(s): ${unknown.join(", ")} — supported: ${TOKEN_LIMIT_KEYS.join(", ")}`);
    }
    const limit = {};
    if (entry.maxPerTx !== undefined) limit.maxPerTx = positiveTokenAmount(`tokenLimits[${id}].maxPerTx`, entry.maxPerTx);
    if (entry.dailyBudget !== undefined) limit.dailyBudget = positiveTokenAmount(`tokenLimits[${id}].dailyBudget`, entry.dailyBudget);
    if (Object.keys(limit).length === 0) {
      throw new Error(`seed policy tokenLimits[${id}] must set maxPerTx and/or dailyBudget — an entry with no cap would silently mean "uncapped"`);
    }
    out[id] = limit;
  }
  return out;
}

// The sealed per-token daily budgets (human amounts), or null when none is sealed.
export function sealedTokenBudgets(policy) {
  const entries = Object.entries(policy?.tokenLimits ?? {}).filter(([, l]) => l.dailyBudget != null);
  return entries.length ? Object.fromEntries(entries.map(([id, l]) => [id, l.dailyBudget])) : null;
}

// True when a sealed budget — sats or any token — binds the signed ledger.
export function policyHasLedgerBudget(policy) {
  return policy?.dailyBudgetSats != null || sealedTokenBudgets(policy) !== null;
}

// A token's sealed limits in base units, given its decimals: { maxPerTx,
// dailyBudget } as bigints (absent keys stay absent), or { error } when the
// decimals are unknown or a limit has more decimal places than the token.
// Never rounds: a limit the operator didn't write exactly is no limit at all.
export function tokenLimitBaseUnits(limit, decimals, tokenIdentifier) {
  if (!Number.isSafeInteger(decimals) || decimals < 0) {
    return { error: `the decimals of ${tokenIdentifier} are unknown (the wallet has no metadata for it — does it hold this token?), so its sealed limits can't be applied — refusing` };
  }
  const out = {};
  for (const key of TOKEN_LIMIT_KEYS) {
    if (limit[key] == null) continue;
    const base = toBaseUnits(limit[key], decimals);
    if (base === null) {
      return { error: `the sealed ${key} of ${tokenIdentifier} (${limit[key]}) has more decimal places than the token (${decimals}) — refusing rather than rounding; fix it with set-policy` };
    }
    out[key] = base;
  }
  return out;
}

// A host entry is a bare hostname ("api.example.com") or "*." plus a domain
// ("*.example.com": every subdomain, NOT the domain itself — list both to
// allow both). It is normalized the way URL parsing normalizes a request's
// host — lowercase, IDN to punycode, no trailing dot — so matching at spend
// time is plain equality or a dot-bounded suffix, never a substring or glob.
// Anything URL parsing would have to reinterpret (a scheme, path, port,
// userinfo, a second wildcard) is refused at seal time.
function normalizeHostPattern(key, entry) {
  const fail = (why) => {
    throw new Error(`seed policy ${key} entry ${JSON.stringify(entry)} ${why} — use "api.example.com" or "*.example.com"`);
  };
  if (typeof entry !== "string" || !entry.trim()) fail("is not a hostname");
  const raw = entry.trim();
  const wildcard = raw.startsWith("*.");
  const name = wildcard ? raw.slice(2) : raw;
  if (!name || /[\s/?#@:*\\]/.test(name)) fail("must be a hostname only (no scheme, path, port, userinfo, or inner wildcard)");
  let hostname;
  try {
    hostname = new URL(`https://${name}`).hostname;
  } catch {
    fail("is not a valid hostname");
  }
  hostname = hostname.replace(/\.$/, "");
  if (!hostname || hostname.startsWith(".") || hostname.includes("..")) fail("is not a valid hostname");
  if (wildcard && !hostname.includes(".")) fail("is a wildcard over a whole top-level domain");
  return wildcard ? `*.${hostname}` : hostname;
}

function hostPatterns(key, list) {
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`seed policy ${key} must be a non-empty array of hostnames like "api.example.com" or "*.example.com"`);
  }
  return [...new Set(list.map((e) => normalizeHostPattern(key, e)))];
}

// The request's hostname, normalized like a pattern; null when unreadable.
function purchaseHostname(host) {
  if (typeof host !== "string" || !host) return null;
  try {
    return new URL(`https://${host}`).hostname.replace(/\.$/, "") || null;
  } catch {
    return null;
  }
}

function hostMatches(hostname, pattern) {
  return pattern.startsWith("*.") ? hostname.endsWith(pattern.slice(1)) : hostname === pattern;
}

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
  if (policy.allowedHosts !== undefined) out.allowedHosts = hostPatterns("allowedHosts", policy.allowedHosts);
  if (policy.deniedHosts !== undefined) out.deniedHosts = hostPatterns("deniedHosts", policy.deniedHosts);
  if (policy.tokenLimits !== undefined) out.tokenLimits = tokenLimitsObject(policy.tokenLimits);
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
  // Host rules: HTTP 402 purchases only. An explicit deny beats any allow —
  // "*.example.com" allowed with "ads.example.com" denied refuses ads.
  if (outbound && ctx.purchase && (policy.deniedHosts || policy.allowedHosts)) {
    const hostname = purchaseHostname(ctx.purchase.host);
    if (hostname === null) {
      return {
        allow: false,
        rule: policy.deniedHosts ? "deniedHosts" : "allowedHosts",
        reason: `the purchase host ${JSON.stringify(ctx.purchase.host)} cannot be read, so it cannot be checked against the sealed host rules — refusing`,
      };
    }
    const denied = policy.deniedHosts?.find((p) => hostMatches(hostname, p));
    if (denied) {
      return { allow: false, rule: "deniedHosts", reason: `${hostname} is denied by the sealed policy (${denied})` };
    }
    if (policy.allowedHosts && !policy.allowedHosts.some((p) => hostMatches(hostname, p))) {
      const n = policy.allowedHosts.length;
      return {
        allow: false,
        rule: "allowedHosts",
        reason: `${hostname} is not in the sealed host allowlist (${n} entr${n === 1 ? "y" : "ies"}) — add it with set-policy`,
      };
    }
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
  // Token caps. ctx.tokens is what this call moves (base units), summed per
  // identifier, with the token's decimals from the wallet: a batch or a
  // multi-invoice fulfilment is one transaction and is capped as one —
  // splitting a send across entries is what the cap exists to stop. The daily
  // budget is the ledger's (in the caller); its limit is validated here too,
  // so a limit that can't be applied refuses before the ledger is asked.
  if (policy.tokenLimits && outbound && ctx.tokens?.length) {
    for (const t of ctx.tokens) {
      const limit = t.tokenIdentifier ? policy.tokenLimits[t.tokenIdentifier] : undefined;
      if (!limit) {
        const n = Object.keys(policy.tokenLimits).length;
        return {
          allow: false,
          rule: "tokenLimits",
          reason: t.tokenIdentifier
            ? `token ${t.tokenIdentifier} is not in the sealed tokenLimits (${n} token${n === 1 ? "" : "s"}) — add it with set-policy`
            : "a token payment's identifier is unreadable, so it cannot be checked against the sealed tokenLimits — refusing",
        };
      }
      if (typeof t.amount !== "string" || !/^[0-9]+$/.test(t.amount)) {
        return {
          allow: false,
          rule: "tokenLimits",
          reason: `the amount of ${t.tokenIdentifier} is unreadable, so it cannot be checked against its sealed limits — refusing`,
        };
      }
      const base = tokenLimitBaseUnits(limit, t.decimals, t.tokenIdentifier);
      if (base.error) return { allow: false, rule: "tokenLimits", reason: base.error };
      if (base.maxPerTx != null && BigInt(t.amount) > base.maxPerTx) {
        return {
          allow: false,
          rule: "tokenLimits",
          reason: `${formatUnits(t.amount, t.decimals)} of ${t.tokenIdentifier} exceeds its ${limit.maxPerTx} per-transaction cap`,
        };
      }
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
