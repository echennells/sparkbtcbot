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
//   - One writer at a time, across processes too: every read-modify-write
//     (reserve, record, unrecord, initSignedLedger) holds an exclusive
//     `<ledger>.lock` file. Check-then-record must be ONE critical section,
//     or parallel sends all pass the same pre-burst check and each append
//     clobbers the others: reserve() is that section, and the SparkAgent
//     wrapper spends through it. Before the lock, six processes each paying
//     1,000 sats under a 3,000-sat limit sent 4,000-6,000 in 10 trials of 10,
//     and the ledger kept as little as 2,000 (review 2026-11-09, GATE-2); the
//     user's limits made one ledger the shared state of a whole sandbox, so
//     "give each agent its own ledger" no longer fit. assertCanSpend() then
//     record() as two calls is still a race; call reserve().
import { readFile } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { randomBytes, createHmac, timingSafeEqual } from "node:crypto";
import { atomicWriteFile } from "./atomic-file.js";
import { withFileLock } from "./file-lock.js";
import { annotateError, storageError } from "./agent-errors.js";

export const DEFAULT_SPEND_LEDGER_PATH = join(homedir(), ".spark", "spend-ledger.json");
const LEDGER_LOCK = { what: "Spend ledger", nothingDone: "nothing was sent" };
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

// An entry's sats must be a non-negative whole number. A negative entry would
// SUBTRACT from the window, and set-policy signs an unsigned ledger as it
// stands, so one planted { sats: -1e9 } used to become a trusted, signed hole
// in a sealed budget (ToB review 2026-10-26). A future-dated positive entry
// only over-counts, the safe direction, so the timestamp only has to be finite.
const entriesValid = (entries) =>
  Array.isArray(entries) &&
  entries.every((e) => Number.isFinite(e?.ts) && Number.isSafeInteger(e?.sats) && e.sats >= 0 && typeof e?.id === "string");

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
      throw annotateError(
        new Error(
          `Spend ledger at ${path} is MISSING but the seed carries a bound spending policy — ` +
            `refusing to treat this as a fresh window (deleting the ledger must not restore the budget). ` +
            `Only \`sparkbtcbot reset-ledger\`, run by the user in a terminal (it asks for the passphrase), resets it; an agent can't and must not recreate it.`,
        ),
        "SPEND_LEDGER_MISSING",
      );
    }
    throw storageError(err, `Spend ledger at ${path} can't be read: ${err.message}`);
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
      throw annotateError(
        new Error(
          `Spend ledger at ${path} fails signature verification against the seed-bound policy — ` +
            `refusing to trust it (an edited or replaced ledger must not reset the budget). ` +
            `Only \`sparkbtcbot reset-ledger\`, run by the user in a terminal (it asks for the passphrase), resets it; an agent can't and must not replace it.`,
        ),
        "SPEND_LEDGER_BAD_SIGNATURE",
      );
    }
    return parsed.entries;
  }
  const entries = parsed?.entries;
  // Unbound: accept the legacy v1 shape, or a v2 signed ledger left over from a
  // previously-bound policy (shape-checked; there is no key to verify with).
  if ((parsed?.version !== 1 && parsed?.version !== 2) || !entriesValid(entries)) {
    throw annotateError(
      new Error(
        `Spend ledger at ${path} is unreadable — refusing to treat a corrupt ledger as a fresh one ` +
          `(that would forget everything already spent); nothing was sent. Delete it only when the user asks in their own message ` +
          `(that resets the budget window), and don't edit it.`,
      ),
      "SPEND_LEDGER_UNREADABLE",
    );
  }
  return entries;
}

async function persistEntries(path, entries, { hmacKey = null } = {}) {
  const doc = hmacKey
    ? { version: 2, entries, hmac: signEntries(hmacKey, entries) }
    : { version: 1, entries };
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicWriteFile(path, JSON.stringify(doc, null, 2) + "\n", { mode: 0o600 });
  } catch (err) {
    throw storageError(err, `Spend ledger at ${path} can't be written: ${err.message}`);
  }
}

// Write a signed ledger — EMPTY by default, which is the legitimate reset that
// replaces `rm`. Requiring the HMAC key (derived from the decrypted mnemonic)
// is what lets the code tell reset from attack: resetting needs the passphrase.
// `entries` signs an existing unsigned ledger as it stands (set-policy binding
// a budget over an env-budget ledger) without forgetting what was spent.
export async function initSignedLedger({ path = DEFAULT_SPEND_LEDGER_PATH, hmacKey, entries = [] }) {
  if (!Buffer.isBuffer(hmacKey) || hmacKey.length < 32) {
    throw annotateError(new Error("initSignedLedger: hmacKey must be a >=32-byte Buffer (deriveLedgerHmacKey)"), "BAD_INPUT", { field: "hmacKey" });
  }
  if (!entriesValid(entries)) {
    throw annotateError(new Error("initSignedLedger: entries must be well-formed ledger entries"), "BAD_INPUT", { field: "entries" });
  }
  await withFileLock(path, LEDGER_LOCK, () => persistEntries(path, entries, { hmacKey }));
  return path;
}

// Re-sign a sealed ledger under a new seed's key: rotate's commit. Under the
// lock, it reads the ledger as it is NOW, verified by whichever of `fromKeys`
// signed it (an interrupted rotation may have re-signed it already), adds any
// entry of `keep` it lacks (the window read before anything moved), and writes
// it signed by `toKey`. Re-signing the window read at the start lost a spend
// an old-key process recorded meanwhile, and a commit cut off after the
// re-sign left every --resume failing verification (review 2026-11-09, ROT-6
// and ROT-4). Throws like a bound ledger when no key verifies it.
export async function rekeyLedger({ path = DEFAULT_SPEND_LEDGER_PATH, fromKeys, toKey, keep = [] }) {
  const isKey = (k) => Buffer.isBuffer(k) && k.length >= 32;
  if (!isKey(toKey) || !Array.isArray(fromKeys) || !fromKeys.length || !fromKeys.every(isKey) || !entriesValid(keep)) {
    throw annotateError(new Error("rekeyLedger: fromKeys and toKey must be >=32-byte Buffers (deriveLedgerHmacKey), keep well-formed entries"), "BAD_INPUT", { field: "fromKeys" });
  }
  return withFileLock(path, LEDGER_LOCK, async () => {
    let entries = null;
    let refusal;
    for (const hmacKey of fromKeys) {
      try {
        entries = await loadEntries(path, { hmacKey, bound: true });
        break;
      } catch (err) {
        if (err?.code !== "SPEND_LEDGER_BAD_SIGNATURE") throw err;
        refusal = err;
      }
    }
    if (!entries) throw refusal;
    const ids = new Set(entries.map((e) => e.id));
    const merged = [...entries, ...keep.filter((e) => !ids.has(e.id))];
    await persistEntries(path, merged, { hmacKey: toKey });
    return merged;
  });
}

// What binding a sealed budget finds at `path`, changing nothing:
//   { state: "signed", entries }    verifies under hmacKey: keep it as it is
//   { state: "missing", entries: [] }
//   { state: "unsigned", entries }  a v1 (env-budget) ledger: sign it as it stands
// A signed ledger that fails verification, or a file that can't be read,
// THROWS (SPEND_LEDGER_BAD_SIGNATURE / SPEND_LEDGER_UNREADABLE): replacing
// either would empty the window, and emptying the window is reset-ledger's job.
export async function inspectLedgerForBinding({ path = DEFAULT_SPEND_LEDGER_PATH, hmacKey }) {
  if (!Buffer.isBuffer(hmacKey) || hmacKey.length < 32) {
    throw annotateError(new Error("inspectLedgerForBinding: hmacKey must be a >=32-byte Buffer (deriveLedgerHmacKey)"), "BAD_INPUT", { field: "hmacKey" });
  }
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return { state: "missing", entries: [] };
    throw storageError(err, `Spend ledger at ${path} can't be read: ${err.message}`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // unreadable: handled below
  }
  const shaped = entriesValid(parsed?.entries);
  if (parsed?.version === 2 && shaped && hmacValid(hmacKey, parsed.entries, parsed.hmac)) {
    return { state: "signed", entries: parsed.entries };
  }
  if (parsed?.version === 1 && shaped) return { state: "unsigned", entries: parsed.entries };
  const badSignature = parsed?.version === 2 && shaped;
  throw annotateError(
    new Error(
      badSignature
        ? `Spend ledger at ${path} is signed but does not verify under this seed (edited, or from another wallet).`
        : `Spend ledger at ${path} is unreadable.`,
    ),
    badSignature ? "SPEND_LEDGER_BAD_SIGNATURE" : "SPEND_LEDGER_UNREADABLE",
  );
}

// Stateful convenience over the pure pieces. `budgetSats` may be null (record
// without enforcement — an audit trail). `clock` is injectable for tests.
// status() and assertCanSpend() take an optional `limitSats`, the user's own
// daily limit (lib/spending-limits.js), read fresh per call: the tighter of
// it and `budgetSats` applies.
export function createSpendLedger({ path = DEFAULT_SPEND_LEDGER_PATH, budgetSats = null, windowMs = DAY_MS, clock = Date.now, hmacKey = null, bound = false } = {}) {
  const budget = budgetSats == null ? null : Number(budgetSats);
  if (budgetSats != null && (!Number.isFinite(budget) || budget <= 0)) {
    throw annotateError(
      new Error(`createSpendLedger: budgetSats must be a positive number of sats, got ${JSON.stringify(budgetSats)}`),
      "BAD_INPUT",
      { field: "budgetSats" },
    );
  }
  if (bound && (!Buffer.isBuffer(hmacKey) || hmacKey.length < 32)) {
    throw annotateError(new Error("createSpendLedger: a bound policy requires the seed-derived hmacKey"), "BAD_INPUT", { field: "hmacKey" });
  }
  const io = { hmacKey, bound };
  const effective = (limitSats) =>
    limitSats != null && (budget == null || limitSats < budget) ? { budget: limitSats, fromLimits: true } : { budget, fromLimits: false };
  return {
    path,
    budgetSats: budget,
    windowMs,
    bound,

    async status({ limitSats = null } = {}) {
      const entries = await loadEntries(path, io);
      const now = clock();
      const spent = spentInWindow(entries, { windowMs, now });
      const { budget: b } = effective(limitSats);
      return {
        spentSats: spent,
        budgetSats: b,
        remainingSats: b == null ? null : Math.max(0, b - spent),
        windowMs,
        entries: entries.filter((e) => e.ts > now - windowMs),
      };
    },

    // Throws (code SPEND_BUDGET_EXCEEDED) when `sats` would bust the budget.
    // A check only: a spend goes through reserve(), which checks and records
    // under the lock.
    async assertCanSpend(sats, operation = "spend", { limitSats = null } = {}) {
      return refuseOver(await loadEntries(path, io), sats, operation, limitSats);
    },

    // The spend gate: check the budget and record the spend as one section
    // under the ledger lock, so no other process or ledger object on this
    // path checks between the two. Throws SPEND_BUDGET_EXCEEDED like
    // assertCanSpend; returns the entry for unrecord().
    async reserve(sats, operation = "spend", { limitSats = null } = {}) {
      return withFileLock(path, LEDGER_LOCK, async () => {
        const entries = await loadEntries(path, io);
        refuseOver(entries, sats, operation, limitSats);
        return append(entries, sats, operation);
      });
    },

    // Append a spend (pruning aged-out entries) and persist atomically.
    // Returns the entry; hand its id to unrecord() if the send provably
    // never happened.
    async record(sats, operation = "spend") {
      wholeSats(sats);
      return withFileLock(path, LEDGER_LOCK, async () => append(await loadEntries(path, io), sats, operation));
    },

    // Best-effort refund for a spend recorded ahead of an SDK call that then
    // failed WITHOUT moving money. If this itself fails the ledger overcounts
    // — the safe direction.
    async unrecord(id) {
      await withFileLock(path, LEDGER_LOCK, async () => {
        const entries = await loadEntries(path, io);
        const kept = entries.filter((e) => e.id !== id);
        if (kept.length !== entries.length) await persistEntries(path, kept, io);
      });
    },
  };

  function refuseOver(entries, sats, operation, limitSats) {
    const { budget: b, fromLimits } = effective(limitSats);
    const check = checkSpendBudget({ entries, sats, budgetSats: b, windowMs, now: clock() });
    if (!check.ok) {
      // Remediation must match the mode: telling a SEALED-policy caller to
      // raise SPARK_DAILY_BUDGET_SATS is both false (the env var is ignored)
      // and the exact file-edit the seal exists to neutralize — bad advice to
      // hand an LLM inside the throw it just hit. Unsealed, the variable does
      // work, which is why the message says whose it is: "raise it
      // deliberately to override" read as an instruction to the agent that
      // hit the budget (verified 2026-10-28).
      throw annotateError(
        new Error(
          `${operation} blocked by the spend ledger: ${check.reason}; nothing was sent. ` +
            `The window rolls (${Math.round(windowMs / 3_600_000)}h); ` +
            (fromLimits
              ? `this is the user's own daily limit (sparkbtcbot limits): tell them; raise it only when the user, told that, asks in their own message (a standing "if it's blocked, raise it" doesn't count). Do not edit the limits or ledger file to get past it.`
              : bound
              ? `this budget is SEALED in the encrypted seed — the operator can change it with \`npm exec --no -- sparkbtcbot set-policy\` (passphrase required). Do not edit .env or the ledger file; neither has any effect.`
              : `the budget is the user's limit (SPARK_DAILY_BUDGET_SATS): tell them; raise it only when the user, told that, asks in their own message (a standing "if it's blocked, raise it" doesn't count). Do not edit .env or the ledger file to get past it.`),
        ),
        "SPEND_BUDGET_EXCEEDED",
        { check },
      );
    }
    return check;
  }

  function wholeSats(sats) {
    const amount = Number(sats);
    if (!Number.isFinite(amount) || amount < 0) {
      throw annotateError(new Error(`SpendLedger.record: sats must be a non-negative number, got ${String(sats)}`), "BAD_INPUT", { field: "sats" });
    }
    // Whole sats, rounded up: the reader accepts nothing else (a fractional
    // entry made the whole ledger unreadable), and up is the safe direction.
    const whole = Math.ceil(amount);
    if (!Number.isSafeInteger(whole)) {
      throw annotateError(new Error(`SpendLedger.record: sats too large, got ${String(sats)}`), "BAD_INPUT", { field: "sats" });
    }
    return whole;
  }

  // Under the lock: append to the entries just read, pruned, and write.
  async function append(loaded, sats, operation) {
    const whole = wholeSats(sats);
    const now = clock();
    const entry = { id: randomBytes(8).toString("hex"), ts: now, sats: whole, operation: String(operation) };
    const entries = loaded.filter((e) => e.ts > now - windowMs);
    entries.push(entry);
    await persistEntries(path, entries, io);
    return entry;
  }
}
