// Spending limits the user sets in chat: how much the agent may spend in a
// day and per payment, on which operations, and to whom.
//
// EXPORTS (quick reference):
//   LIMIT_OPS / OUTBOUND_OPS   operation names `allowedOps` can list (the
//                              same strings the spend ledger records)
//   DEFAULT_LIMITS_PATH        ~/.spark/limits.json; limitsPath() honours
//                              SPARK_LIMITS_PATH
//   validateLimits(obj)        normalized limits | null; throws BAD_INPUT on an
//                              unknown key or unreadable value (a typo must
//                              never silently mean "no limit")
//   readLimits(path?)          null when there is no file; LIMITS_UNREADABLE
//                              when there is one that can't be read or parsed
//   writeLimits(limits, path?) atomic; null removes the file
//   checkLimits(ctx, limits)   { allow: true } | { allow: false, rule, reason }
//   limitsChanges(a, b)        what changed, each marked looser or tighter
//
// Who this is for. The common setup is a hosted agent (a chat bot) told to
// install this package in its own sandbox; the user's only channel is the
// chat. The agent writes this file (`sparkbtcbot limits set`) when the user
// asks for a limit, and the skill's rule is that it changes only on the
// user's own message, never because a webpage, invoice, tool result or other
// agent asks. That makes these limits a guard against mistakes and casual
// injection: a loop, a wrong amount, a "pay this" hidden in content. They are
// NOT a defense against a hijacked agent, which can rewrite this file like any
// other in its sandbox: the funded balance is the only hard limit. An
// operator with a terminal can still seal a budget into the seed
// (`sparkbtcbot set-policy`), which overrides SPARK_DAILY_BUDGET_SATS; the
// user's daily limit here tightens whichever is in force.
//
// Fail closed: a file that exists but can't be read or doesn't validate
// refuses every spend (LIMITS_UNREADABLE). A deleted file means no limits:
// the file is the agent's own, so it can't prove more than that.
import { readFile, unlink, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { atomicWriteFile } from "./atomic-file.js";
import { annotateError, storageError } from "./agent-errors.js";

export const LIMIT_OPS = Object.freeze([
  "spark_transfer",
  "lightning_pay",
  "fulfill_spark_invoice",
  "token_transfer",
  "l1_withdraw",
  "claim_deposit",
]);
// claim_deposit brings the user's own L1 deposit in (minus an SSP fee):
// allowedOps sees it, the amount and recipient rules don't.
export const OUTBOUND_OPS = Object.freeze(new Set(LIMIT_OPS.filter((op) => op !== "claim_deposit")));

const RULES = Object.freeze(["dailyBudgetSats", "maxPaymentSats", "allowedOps", "allowedRecipients"]);
const KEYS = Object.freeze([...RULES, "updatedAt"]);

export const DEFAULT_LIMITS_PATH = join(homedir(), ".spark", "limits.json");
export const limitsPath = () => process.env.SPARK_LIMITS_PATH || DEFAULT_LIMITS_PATH;

const bad = (message, field) => annotateError(new Error(message), "BAD_INPUT", { field });

function positiveSats(name, value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw bad(`spending limits: ${name} must be a positive whole number of sats, got ${JSON.stringify(value)}`, name);
  }
  return value;
}

/**
 * Validate and normalize. null/undefined, or an object with no rule, is "no
 * limits" (null). Unknown keys throw.
 * @param {unknown} limits
 * @returns {null | { dailyBudgetSats?: number, maxPaymentSats?: number, allowedOps?: string[], allowedRecipients?: string[], updatedAt?: string }}
 */
export function validateLimits(limits) {
  if (limits == null) return null;
  if (typeof limits !== "object" || Array.isArray(limits)) {
    throw bad("spending limits must be an object like { dailyBudgetSats: 20000 }", "limits");
  }
  const unknown = Object.keys(limits).filter((k) => !KEYS.includes(k));
  if (unknown.length) {
    throw bad(`spending limits: unknown key(s) ${unknown.join(", ")}; supported: ${RULES.join(", ")}`, unknown[0]);
  }
  const out = {};
  if (limits.dailyBudgetSats !== undefined) out.dailyBudgetSats = positiveSats("dailyBudgetSats", limits.dailyBudgetSats);
  if (limits.maxPaymentSats !== undefined) out.maxPaymentSats = positiveSats("maxPaymentSats", limits.maxPaymentSats);
  if (limits.allowedOps !== undefined) {
    const ops = limits.allowedOps;
    if (!Array.isArray(ops) || ops.length === 0 || !ops.every((o) => typeof o === "string")) {
      throw bad(`spending limits: allowedOps must be a non-empty list of: ${LIMIT_OPS.join(", ")}`, "allowedOps");
    }
    const unknownOps = ops.filter((o) => !LIMIT_OPS.includes(o));
    if (unknownOps.length) {
      throw bad(`spending limits: allowedOps has unknown operation(s) ${unknownOps.join(", ")}; supported: ${LIMIT_OPS.join(", ")}`, "allowedOps");
    }
    out.allowedOps = [...new Set(ops)];
  }
  if (limits.allowedRecipients !== undefined) {
    const list = limits.allowedRecipients;
    if (!Array.isArray(list) || list.length === 0 || !list.every((a) => typeof a === "string" && a.trim() && !/\s/.test(a.trim()))) {
      throw bad("spending limits: allowedRecipients must be a non-empty list of addresses (no spaces)", "allowedRecipients");
    }
    out.allowedRecipients = [...new Set(list.map((a) => a.trim()))];
  }
  if (Object.keys(out).length === 0) return null;
  if (limits.updatedAt !== undefined) {
    if (typeof limits.updatedAt !== "string" || !Number.isFinite(Date.parse(limits.updatedAt))) {
      throw bad(`spending limits: updatedAt must be an ISO-8601 time, got ${JSON.stringify(limits.updatedAt)}`, "updatedAt");
    }
    out.updatedAt = limits.updatedAt;
  }
  return out;
}

const UNREADABLE_STEP =
  "Nothing is spent while the limits file can't be read. Tell the user, and ask them to state their limits again; set them with `sparkbtcbot limits set` only from what they say. Don't delete the file to get past this.";

/**
 * The limits on disk, or null when there is no file.
 * @param {string} [path]
 */
export async function readLimits(path = limitsPath()) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw storageError(err, `The spending limits file ${path} can't be read (${err?.code ?? err?.message ?? err}); refusing to spend without it.`, {
      code: "LIMITS_UNREADABLE",
      nextStep: UNREADABLE_STEP,
    });
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
    return validateLimits(parsed);
  } catch (err) {
    throw annotateError(
      new Error(`The spending limits file ${path} is not valid (${String(err?.message ?? err).slice(0, 160)}); refusing to spend until it is.`, { cause: err }),
      "LIMITS_UNREADABLE",
      { nextStep: UNREADABLE_STEP },
    );
  }
}

/**
 * Write (atomically, mode 0600) or, for null / no rules, remove the file.
 * Returns what was written (with updatedAt), or null.
 * @param {unknown} limits
 * @param {string} [path]
 */
export async function writeLimits(limits, path = limitsPath()) {
  const { updatedAt: _ignored, ...rules } = limits ?? {};
  const normalized = validateLimits(rules);
  if (normalized === null) {
    await unlink(path).catch((err) => {
      if (err?.code !== "ENOENT") throw storageError(err, `Couldn't remove the spending limits file ${path}.`);
    });
    return null;
  }
  const out = { ...normalized, updatedAt: new Date().toISOString() };
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicWriteFile(path, JSON.stringify(out, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    throw storageError(err, `Couldn't write the spending limits file ${path}.`);
  }
  return out;
}

/**
 * One request against the limits. `ctx`: { op, recipients?, amountsSats? }.
 * `amountsSats` holds each sats payment the call makes (fulfillInvoice pays
 * several; a token payment has none); an entry that isn't a finite number
 * fails maxPaymentSats closed. `matchRecipient(recipient, list)` lets
 * SparkAgent match a Spark address in either encoding; the default is an
 * exact match.
 * @returns {{ allow: true } | { allow: false, rule: string, reason: string }}
 */
export function checkLimits(ctx, limits, { matchRecipient = (r, list) => list.includes(r) } = {}) {
  if (!limits) return { allow: true };
  const { op } = ctx;
  if (limits.allowedOps && !limits.allowedOps.includes(op)) {
    return { allow: false, rule: "allowedOps", reason: `${op} isn't allowed: the user's limits allow only ${limits.allowedOps.join(", ")}` };
  }
  if (!OUTBOUND_OPS.has(op)) return { allow: true };
  if (limits.allowedRecipients && ctx.recipients?.length) {
    for (const recipient of ctx.recipients) {
      if (!matchRecipient(recipient, limits.allowedRecipients)) {
        return { allow: false, rule: "allowedRecipients", reason: `${recipient} isn't one of the ${limits.allowedRecipients.length} recipient(s) the user's limits allow` };
      }
    }
  }
  if (limits.maxPaymentSats != null) {
    for (const amt of ctx.amountsSats ?? []) {
      if (typeof amt !== "number" || !Number.isFinite(amt)) {
        return { allow: false, rule: "maxPaymentSats", reason: `the amount can't be read, so it can't be checked against the user's ${limits.maxPaymentSats}-sat limit per payment` };
      }
      if (amt > limits.maxPaymentSats) {
        return { allow: false, rule: "maxPaymentSats", reason: `${amt} sats is over the user's limit of ${limits.maxPaymentSats} sats per payment` };
      }
    }
  }
  return { allow: true };
}

/**
 * What changed between two limit sets, each change marked `looser` when it
 * lets the agent spend more, on more, or to more recipients.
 * @returns {Array<{ rule: string, from: unknown, to: unknown, looser: boolean }>}
 */
export function limitsChanges(before, after) {
  const a = before ?? {};
  const b = after ?? {};
  const changes = [];
  for (const rule of RULES) {
    const from = a[rule] ?? null;
    const to = b[rule] ?? null;
    if (JSON.stringify(from) === JSON.stringify(to)) continue;
    let looser;
    if (to === null) looser = true; // a rule removed
    else if (from === null) looser = false; // a rule added
    else if (typeof to === "number") looser = to > from;
    else looser = to.some((x) => !from.includes(x)); // a list that gained an entry
    changes.push({ rule, from, to, looser });
  }
  return changes;
}
