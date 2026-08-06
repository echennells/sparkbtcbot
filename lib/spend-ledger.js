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
import { randomBytes } from "node:crypto";
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

async function loadEntries(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const entries = parsed?.entries;
  const valid = Array.isArray(entries) && entries.every((e) => Number.isFinite(e?.ts) && Number.isFinite(e?.sats) && typeof e?.id === "string");
  if (parsed?.version !== 1 || !valid) {
    const e = new Error(
      `Spend ledger at ${path} is unreadable — refusing to treat a corrupt ledger as a fresh one ` +
        `(that would forget everything already spent). Inspect it, then delete the file to reset the window.`,
    );
    e.code = "SPEND_LEDGER_UNREADABLE";
    throw e;
  }
  return entries;
}

async function persistEntries(path, entries) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await atomicWriteFile(path, JSON.stringify({ version: 1, entries }, null, 2) + "\n", { mode: 0o600 });
}

// Stateful convenience over the pure pieces. `budgetSats` may be null (record
// without enforcement — an audit trail). `clock` is injectable for tests.
export function createSpendLedger({ path = DEFAULT_SPEND_LEDGER_PATH, budgetSats = null, windowMs = DAY_MS, clock = Date.now } = {}) {
  const budget = budgetSats == null ? null : Number(budgetSats);
  if (budgetSats != null && (!Number.isFinite(budget) || budget <= 0)) {
    throw new Error(`createSpendLedger: budgetSats must be a positive number of sats, got ${JSON.stringify(budgetSats)}`);
  }
  return {
    path,
    budgetSats: budget,
    windowMs,

    async status() {
      const entries = await loadEntries(path);
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
      const entries = await loadEntries(path);
      const check = checkSpendBudget({ entries, sats, budgetSats: budget, windowMs, now: clock() });
      if (!check.ok) {
        const e = new Error(
          `${operation} blocked by the spend ledger: ${check.reason}. ` +
            `The window rolls (${Math.round(windowMs / 3_600_000)}h); raise SPARK_DAILY_BUDGET_SATS deliberately to override.`,
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
      const entries = (await loadEntries(path)).filter((e) => e.ts > now - windowMs);
      entries.push(entry);
      await persistEntries(path, entries);
      return entry;
    },

    // Best-effort refund for a spend recorded ahead of an SDK call that then
    // failed WITHOUT moving money. If this itself fails the ledger overcounts
    // — the safe direction.
    async unrecord(id) {
      const entries = await loadEntries(path);
      const kept = entries.filter((e) => e.id !== id);
      if (kept.length !== entries.length) await persistEntries(path, kept);
    },
  };
}
