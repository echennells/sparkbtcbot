// Cumulative outbound-spend ledger — the enforcement behind "a stated budget".
//
// Every other guard in this library is PER-CALL: a fee cap, an amount ceiling,
// a quote match. None of them can stop a LOOP — an agent that pays 100
// invoices, each individually under its cap, drains a wallet while every
// single check passes. This ledger closes that class: sat spends are recorded
// to disk and a rolling-window budget (default 24h) is checked against the
// running total BEFORE each new spend.
//
// Threat model, stated honestly (same as the recipients allowlist): this is a
// guardrail against the agent surprising the operator — a runaway loop, a
// prompt-injected shopping spree — NOT a defense against a compromised
// process, which can call the SDK directly or delete the ledger file. No
// control shipped here survives process compromise; the funded balance is
// the only cap that does — size it as a loss you can absorb.
//
// Failure posture:
//   - An UNREADABLE ledger file fails CLOSED (throws) — a corrupt file must
//     not silently mean "fresh ledger, spend away". Reset by deleting it.
//   - An unreadable spend amount fails CLOSED when a budget is set.
//   - Recording uses the shared atomic writer, so a crash never publishes a
//     truncated ledger. Entries are pruned once they age out of the window.
//   - Single-agent-per-ledger assumption: two PROCESSES writing the same path
//     can lose each other's appends (last-writer-wins). Give concurrent
//     agents separate ledger files and budgets. NOTE: in-PROCESS concurrency
//     (e.g. Promise.all of many sends on one SparkAgent) is a real race too —
//     assertCanSpend + record must run as one critical section or parallel
//     sends all pass the same pre-burst check and clobber each other's
//     append. The SparkAgent wrapper serializes this (see #recordSpend); a
//     direct user of createSpendLedger must serialize check-then-record too.
import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { atomicWriteFile } from "./atomic-file.js";

export const DEFAULT_SPEND_LEDGER_PATH = join(homedir(), ".spark", "spend-ledger.json");
export const DAY_MS = 24 * 60 * 60 * 1000;

// Sats actually spent inside the window ending at `now`.
export function spentInWindow(entries, { windowMs = DAY_MS, now = Date.now() } = {}) {
  let spent = 0;
  for (const e of entries) {
    if (e.ts > now - windowMs) spent += e.sats;
  }
  return spent;
}

// Pure budget decision — { ok, sats, spentSats, budgetSats, remainingSats,
// reason }. ok:false means the caller must NOT proceed. No budget => ok (this
// guard is opt-in), but an unreadable amount WITH a budget fails closed: a
// spend the ledger can't count is a spend the budget can't bound.
export function checkSpendBudget({ entries = [], sats, budgetSats, windowMs = DAY_MS, now = Date.now() } = {}) {
  const budget = budgetSats == null ? NaN : Number(budgetSats);
  const amount = sats == null ? NaN : Number(sats);
  const spent = spentInWindow(entries, { windowMs, now });
  if (!Number.isFinite(budget)) {
    return { ok: true, sats: Number.isFinite(amount) ? amount : null, spentSats: spent, budgetSats: null, remainingSats: null, reason: "no budget set" };
  }
  if (!Number.isFinite(amount) || amount < 0) {
    return { ok: false, sats: null, spentSats: spent, budgetSats: budget, remainingSats: Math.max(0, budget - spent), reason: "spend amount is unreadable — refusing an uncountable spend against a budget" };
  }
  if (spent + amount > budget) {
    return {
      ok: false,
      sats: amount,
      spentSats: spent,
      budgetSats: budget,
      remainingSats: Math.max(0, budget - spent),
      reason: `spending ${amount} sats would exceed the ${budget}-sat budget (${spent} already spent in the current window)`,
    };
  }
  return { ok: true, sats: amount, spentSats: spent, budgetSats: budget, remainingSats: budget - spent - amount, reason: "within budget" };
}

// HMAC over the exact serialized entries array (v2 signed ledgers). The mac
// input includes the version so a downgrade of the envelope can't reuse a
// signature.
function signEntries(hmacKey, entries) {
  return createHmac("sha256", hmacKey).update(`v2:${JSON.stringify(entries)}`).digest("hex");
}
function hmacValid(hmacKey, entries, hex) {
  if (typeof hex !== "string" || !/^[0-9a-f]{64}$/.test(hex)) return false;
  const expect = Buffer.from(signEntries(hmacKey, entries), "hex");
  return timingSafeEqual(expect, Buffer.from(hex, "hex"));
}

const entriesValid = (entries) =>
  Array.isArray(entries) && entries.every((e) => Number.isFinite(e?.ts) && Number.isFinite(e?.sats) && typeof e?.id === "string");

async function loadEntries(path, { hmacKey = null, bound = false } = {}) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") {
      // Unbound (env-configured or no budget): an absent ledger is legitimately
      // fresh. BOUND (seed-carried policy): the ledger was initialized when the
      // policy was bound, so absence means deletion or an unmigrated host —
      // both must fail CLOSED, loudly. `rm` used to silently restore the full
      // budget; that was indistinguishable from the attack.
      if (!bound) return [];
      const e = new Error(
        `Spend ledger at ${path} is MISSING but the seed carries a bound spending policy — ` +
          `refusing to treat this as a fresh window (deleting the ledger must not restore the budget). ` +
          `If this is a legitimate reset or a new machine, run \`npx sparkbtcbot-reset-ledger\` (requires the passphrase).`,
      );
      e.code = "SPEND_LEDGER_MISSING";
      throw e;
    }
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (bound) {
    // Bound policy accepts ONLY a validly signed v2 ledger. A v1/unsigned file
    // here means the signed ledger was replaced; a bad mac means it was edited.
    // Truncation-to-empty is just the smarter version of deletion — same answer.
    if (parsed?.version !== 2 || !entriesValid(parsed.entries) || !hmacValid(hmacKey, parsed.entries, parsed.hmac)) {
      const e = new Error(
        `Spend ledger at ${path} fails signature verification against the seed-bound policy — ` +
          `refusing to trust it (an edited or replaced ledger must not reset the budget). ` +
          `If this is a legitimate reset, run \`npx sparkbtcbot-reset-ledger\` (requires the passphrase).`,
      );
      e.code = "SPEND_LEDGER_BAD_SIGNATURE";
      throw e;
    }
    return parsed.entries;
  }
  const entries = parsed?.entries;
  // Unbound: accept the legacy v1 shape, or a v2 signed ledger left over from a
  // previously-bound policy (shape-checked; there is no key to verify with).
  if ((parsed?.version !== 1 && parsed?.version !== 2) || !entriesValid(entries)) {
    const e = new Error(
      `Spend ledger at ${path} is unreadable — refusing to treat a corrupt ledger as a fresh one ` +
        `(that would forget everything already spent). Inspect it, then delete the file to reset the window.`,
    );
    e.code = "SPEND_LEDGER_UNREADABLE";
    throw e;
  }
  return entries;
}

async function persistEntries(path, entries, { hmacKey = null } = {}) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const doc = hmacKey
    ? { version: 2, entries, hmac: signEntries(hmacKey, entries) }
    : { version: 1, entries };
  await atomicWriteFile(path, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
}

// Write a fresh, EMPTY, signed ledger — the legitimate reset that replaces
// `rm`. Requiring the HMAC key (derived from the decrypted mnemonic) is what
// lets the code tell reset from attack: resetting needs the passphrase.
export async function initSignedLedger({ path = DEFAULT_SPEND_LEDGER_PATH, hmacKey }) {
  if (!Buffer.isBuffer(hmacKey) || hmacKey.length < 32) {
    throw new Error("initSignedLedger: hmacKey must be a >=32-byte Buffer (deriveLedgerHmacKey)");
  }
  await persistEntries(path, [], { hmacKey });
  return path;
}

// Stateful convenience over the pure pieces. `budgetSats` may be null (record
// without enforcement — an audit trail). `clock` is injectable for tests.
export function createSpendLedger({ path = DEFAULT_SPEND_LEDGER_PATH, budgetSats = null, windowMs = DAY_MS, clock = Date.now, hmacKey = null, bound = false } = {}) {
  const budget = budgetSats == null ? null : Number(budgetSats);
  if (budgetSats != null && (!Number.isFinite(budget) || budget <= 0)) {
    throw new Error(`createSpendLedger: budgetSats must be a positive number of sats, got ${JSON.stringify(budgetSats)}`);
  }
  if (bound && (!Buffer.isBuffer(hmacKey) || hmacKey.length < 32)) {
    throw new Error("createSpendLedger: a bound policy requires the seed-derived hmacKey");
  }
  const io = { hmacKey, bound };
  return {
    path,
    budgetSats: budget,
    windowMs,
    bound,

    async status() {
      const entries = await loadEntries(path, io);
      const now = clock();
      const spent = spentInWindow(entries, { windowMs, now });
      return {
        spentSats: spent,
        budgetSats: budget,
        remainingSats: budget == null ? null : Math.max(0, budget - spent),
        windowMs,
        entries: entries.filter((e) => e.ts > now - windowMs),
      };
    },

    // Throws (code SPEND_BUDGET_EXCEEDED) when `sats` would bust the budget.
    async assertCanSpend(sats, operation = "spend") {
      const entries = await loadEntries(path, io);
      const check = checkSpendBudget({ entries, sats, budgetSats: budget, windowMs, now: clock() });
      if (!check.ok) {
        // Remediation must match the mode: telling a SEALED-policy caller to
        // raise SPARK_DAILY_BUDGET_SATS is both false (the env var is ignored)
        // and the exact file-edit the seal exists to neutralize — bad advice to
        // hand an LLM inside the throw it just hit.
        const e = new Error(
          `${operation} blocked by the spend ledger: ${check.reason}. ` +
            `The window rolls (${Math.round(windowMs / 3_600_000)}h); ` +
            (bound
              ? `this budget is SEALED in the encrypted seed — the operator can change it with \`npx sparkbtcbot-set-policy\` (passphrase required). Do not edit .env or the ledger file; neither has any effect.`
              : `raise SPARK_DAILY_BUDGET_SATS deliberately to override.`),
        );
        e.code = "SPEND_BUDGET_EXCEEDED";
        e.check = check;
        throw e;
      }
      return check;
    },

    // Append a spend (pruning aged-out entries) and persist atomically.
    // Returns the entry; hand its id to unrecord() if the send provably
    // never happened.
    async record(sats, operation = "spend") {
      const amount = Number(sats);
      if (!Number.isFinite(amount) || amount < 0) {
        throw new Error(`SpendLedger.record: sats must be a non-negative number, got ${String(sats)}`);
      }
      const now = clock();
      const entry = { id: randomBytes(8).toString("hex"), ts: now, sats: amount, operation: String(operation) };
      const entries = (await loadEntries(path, io)).filter((e) => e.ts > now - windowMs);
      entries.push(entry);
      await persistEntries(path, entries, io);
      return entry;
    },

    // Best-effort refund for a spend recorded ahead of an SDK call that then
    // failed WITHOUT moving money. If this itself fails the ledger overcounts
    // — the safe direction.
    async unrecord(id) {
      const entries = await loadEntries(path, io);
      const kept = entries.filter((e) => e.id !== id);
      if (kept.length !== entries.length) await persistEntries(path, kept, io);
    },
  };
}
