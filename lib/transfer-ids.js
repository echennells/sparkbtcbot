// Persistent Lightning payment-dedup identities (spark-sdk ≥0.10 `transferId`).
//
// The SDK dedupes a Lightning payment on `transferId` across every rail it can
// settle on — Spark fallback transfer, preimage swap, SSP admission — so a
// retry that REUSES the first attempt's ID cannot produce a second payment.
// That guarantee is only as durable as the ID: minted fresh per call (the
// SDK's default when the caller omits it), a crash between "request sent" and
// "outcome known" leaves no safe retry. This store makes the ID survive the
// crash: one file per invoice, WRITTEN BEFORE the first pay attempt, keyed by
// the invoice's payment hash, so any later attempt at the same invoice — same
// process, next process, or a concurrent one — resolves to the same ID.
//
// Concurrency is settled by the kernel, not by locks: entries publish through
// atomic-file's exclusive link(2) mode (create-or-EEXIST, never replace), so
// two racers cannot both mint — the loser reads the winner's file. This holds
// across processes, not just within one.
//
// Fail-closed doctrine: an UNREADABLE entry throws instead of minting a fresh
// ID, because a fresh ID for an invoice that may already have a payment in
// flight is exactly the double-pay this store exists to prevent. The
// deliberate reset is deleting the entry file, and the error says what that
// forfeits. Pruning honors the same rule: only entries whose recorded expiry
// has passed are removed; unreadable ones are left for a human.
//
// This module stays SDK-free (the mint function is injected) so the library
// keeps working — and testing — without @buildonspark/spark-sdk installed.
import { readFile, readdir, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { atomicWriteFile } from "./atomic-file.js";
import { invoicePaymentHash, invoiceSecondsRemaining } from "./bolt11.js";
import { annotateError, storageError } from "./agent-errors.js";

/** Default store location: ~/.spark/ln-dedup/ (one JSON file per invoice). */
export const DEFAULT_TRANSFER_IDS_DIR = join(homedir(), ".spark", "ln-dedup");

const WEEK_MS = 7 * 24 * 60 * 60 * 1000; // TTL when the invoice's expiry is unreadable
// 24h, not the obvious hour: the SDK does not refuse an expired BOLT11
// client-side, and a hold-invoice HTLC accepted before expiry can pend past
// it — pruning while either is possible retires the one entry that makes a
// retry safe (2026-08-31 ToB differential review, LOW-1). Entries are tiny;
// generous is cheap.
export const SETTLE_GRACE_MS = 24 * 60 * 60 * 1000;
// The SDK requires a UUID transferId; persisting anything else wedges the
// invoice — every later attempt dies at the SDK's "Transfer ID must be a
// UUID" with no hint of which entry file to delete. Validate at persist AND
// read so the failure names this module and the file instead.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The invoice's payment hash when decodable — its semantic identity, stable
// across case differences — else a hash of the lowercased string, so even an
// undecodable invoice dedupes on exact bytes rather than not at all.
export function invoiceDedupKey(bolt11) {
  return (
    invoicePaymentHash(bolt11) ??
    createHash("sha256").update(String(bolt11).toLowerCase()).digest("hex")
  );
}

export function createTransferIdStore({ dir = DEFAULT_TRANSFER_IDS_DIR, clock = Date.now } = {}) {
  // A broken clock breaks entry TTLs SILENTLY (a Date-returning clock string-
  // concatenates expiresAt, so entries never prune; a non-function makes
  // prune() reject, breaking its never-throws contract). Fail at construction.
  if (typeof clock !== "function" || !Number.isFinite(clock())) {
    throw annotateError(new Error("transfer-ids: clock must be a function returning a finite ms timestamp (like Date.now)"), "BAD_INPUT", { field: "clock" });
  }
  const entryPath = (key) => join(dir, `${key}.json`);

  async function readEntry(path) {
    let raw;
    try {
      raw = await readFile(path, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      // EACCES/ENOTDIR = store location broken. An entry this can't read may
      // record an attempt that paid, so it is money in doubt, not just storage.
      throw frame(err, "read the dedup entry", "DEDUP_ENTRY_UNREADABLE");
    }
    let entry = null;
    try { entry = JSON.parse(raw); } catch { /* refused below, with the path */ }
    if (typeof entry?.transferId !== "string" || !UUID_RE.test(entry.transferId)) {
      throw annotateError(
        new Error(
          `transfer-ids: unreadable or invalid dedup entry at ${path} — refusing to mint a fresh transferId ` +
          `for an invoice that may already have a payment in flight (a fresh ID is exactly the double-pay ` +
          `this store prevents). Delete that file only when the user asks in their own message, and only once getTransfers() shows no attempt ` +
          `pending.`,
        ),
        "DEDUP_ENTRY_UNREADABLE",
      );
    }
    return entry;
  }

  // Hygiene, not safety: callers fire-and-forget this, and a prune failure
  // must never fail a payment. Removes only entries whose recorded expiry has
  // passed; unreadable entries stay (deleting one is the user's deliberate act).
  async function prune() {
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return 0;
    }
    const now = clock();
    let removed = 0;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const path = join(dir, name);
      try {
        const entry = JSON.parse(await readFile(path, "utf8"));
        if (typeof entry?.expiresAt === "number" && entry.expiresAt < now) {
          await unlink(path);
          removed++;
        }
      } catch { /* unreadable or already gone — leave it */ }
    }
    return removed;
  }

  // Frame a filesystem failure so the discoverable fix is the store location,
  // not SPARK_LN_DEDUP=off (which drops the protection): a bare EACCES points
  // at nothing. A new error (STORAGE_ERROR unless `code` says otherwise) with
  // the OS error as `cause` and its code as `osCode`.
  function frame(err, doing, code = "STORAGE_ERROR") {
    if (String(err?.message).startsWith("transfer-ids:")) return err;
    return storageError(
      err,
      `transfer-ids: cannot ${doing} (${err?.message ?? err}). Refusing to pay without dedup protection — ` +
        `fix the store location (dir: ${dir}; SPARK_LN_DEDUP_PATH relocates it) rather than disabling dedup.`,
      { code },
    );
  }

  return {
    dir,
    prune,
    // The transferId recorded for this invoice, or null when no attempt was
    // ever recorded. Read-only: it never mints. payLightningInvoice asks it
    // when it refuses an expired invoice, to say whether an earlier attempt
    // may already have paid. An unreadable entry throws, as in idForInvoice.
    async peek(bolt11) {
      if (typeof bolt11 !== "string" || bolt11.length === 0) return null;
      const entry = await readEntry(entryPath(invoiceDedupKey(bolt11)));
      return entry ? { transferId: entry.transferId, createdAt: entry.createdAt ?? null } : null;
    },
    // Best-effort entry removal for an invoice whose payment TERMINALLY
    // failed: the dead transferId must not outlive the failure, or a
    // legitimate re-pay of the still-valid invoice replays the failure /
    // hits AlreadyExists forever. Returns true when an entry was removed.
    // NOT for timeouts or pending states — only for statuses the SDK marks
    // terminal (the caller classifies; see isTerminalLightningFailure).
    // With `expectedId`, it removes the entry only while it still records
    // that id: a stale caller (a poll of an older send) must not delete the
    // id a newer attempt of the same invoice is paying under.
    async forget(bolt11, expectedId) {
      if (expectedId !== undefined) {
        const entry = await readEntry(entryPath(invoiceDedupKey(bolt11))).catch(() => null);
        if (!entry || entry.transferId !== expectedId) return false;
      }
      try {
        await unlink(entryPath(invoiceDedupKey(bolt11)));
        return true;
      } catch {
        return false;
      }
    },
    // Resolve THE transferId for this invoice: the stored one when any prior
    // attempt recorded it, else mint() persisted write-ahead of the caller's
    // pay attempt. `explicitId` (caller-managed dedup) must AGREE with a
    // stored id — a disagreement is a bug or an injected parameter, so refuse
    // rather than silently pick one (the amountSats-disagreement doctrine) —
    // and must not already belong to a DIFFERENT invoice, or the SDK would
    // replay that payment's result as this invoice's "success".
    async idForInvoice(bolt11, mint, options = {}) {
      // Misuse must fail loud, not degrade: a positional id in mint's seat is
      // silently ignored whenever an entry exists (the exact retry moment),
      // and a string in the options seat silently drops explicitId.
      if (typeof bolt11 !== "string" || bolt11.length === 0) {
        throw annotateError(
          new Error("transfer-ids: idForInvoice needs the BOLT11 string first — got " + (bolt11 === null ? "null" : typeof bolt11)),
          "BAD_INPUT",
          { field: "bolt11" },
        );
      }
      if (typeof mint !== "function") {
        throw annotateError(
          new Error("transfer-ids: idForInvoice's second argument is a mint FUNCTION (e.g. () => generateTransferId().toString()) — to supply your own id, pass { explicitId } as the third argument"),
          "BAD_INPUT",
          { field: "mint" },
        );
      }
      if (options === null || typeof options !== "object") {
        throw annotateError(
          new Error("transfer-ids: idForInvoice's third argument is an options object ({ explicitId }) — got " + typeof options),
          "BAD_INPUT",
          { field: "options" },
        );
      }
      const { explicitId } = options;
      if (explicitId !== undefined && (typeof explicitId !== "string" || !UUID_RE.test(explicitId))) {
        throw annotateError(new Error(`transfer-ids: explicitId must be a UUID string, got ${JSON.stringify(explicitId)}`), "BAD_INPUT", { field: "explicitId" });
      }
      const key = invoiceDedupKey(bolt11);
      const path = entryPath(key);
      const resolve = (entry, reused) => {
        if (explicitId !== undefined && entry.transferId !== explicitId.toLowerCase()) {
          // Same invoice, another id: omitting transferId reuses the recorded
          // one, which stays deduplicated, so this case is "no".
          throw annotateError(
            new Error(
              `transfer-ids: transferId ${explicitId} disagrees with the id already recorded for this ` +
              `invoice (${entry.transferId}, recorded ${entry.createdAt}). One invoice gets ONE dedup ` +
              `identity — omit transferId to reuse the recorded one.`,
            ),
            "TRANSFER_ID_CONFLICT",
            {
              retryable: "no",
              field: "transferId",
              nextStep: "Call again without transferId: the id on record for this invoice is reused, so the retry stays deduplicated.",
            },
          );
        }
        return { transferId: entry.transferId, reused };
      };
      const existing = await readEntry(path);
      if (existing) return resolve(existing, true);
      const transferId = (explicitId ?? mint())?.toString?.().toLowerCase?.();
      if (typeof transferId !== "string" || !UUID_RE.test(transferId)) {
        throw annotateError(
          new Error(
            `transfer-ids: mint() must return a UUID string (got ${JSON.stringify(transferId)}) — the SDK ` +
            `rejects any other transferId, and persisting one would wedge this invoice unpayably.`,
          ),
          "BAD_INPUT",
          { field: "mint" },
        );
      }
      // One id maps to ONE invoice. An explicitId already recorded under a
      // different invoice is a mistake or an injected parameter (the
      // Stripe-idempotency-key mental model, or a prompt-injected stale id):
      // the SDK would dedupe against THAT payment and replay its result as
      // this invoice's success, which was never paid. Scan is bounded by
      // prune's hygiene and only runs on the rare explicit path.
      if (explicitId !== undefined) {
        let names = [];
        try { names = await readdir(dir); } catch { /* no dir yet — nothing recorded */ }
        for (const name of names) {
          if (!name.endsWith(".json") || name === `${key}.json`) continue;
          try {
            const other = JSON.parse(await readFile(join(dir, name), "utf8"));
            if (other?.transferId === transferId) {
              // The entry outlives an attempt only after a success or an
              // unclear outcome, so the other invoice may well be paid. The
              // likeliest reason to reuse an id is one id per purchase, and
              // a fresh id for a re-issued invoice of that purchase is a real
              // second payment: "omit transferId to mint a fresh one" said
              // to do exactly that (verified 2026-10-28).
              throw annotateError(
                new Error(
                  `transfer-ids: transferId ${transferId} is already recorded for a DIFFERENT invoice ` +
                  `(${other.invoice}…, entry ${name}${other.createdAt ? `, recorded ${other.createdAt}` : ""}). ` +
                  `One id maps to one invoice — reusing it would make the SDK replay that payment's result as ` +
                  `this invoice's "success" without paying it. That invoice's payment is on record and was not ` +
                  `shown to have failed. If this invoice is for the same purchase, do NOT pay it: check ` +
                  `agent.getTransfers() first; a new invoice under a fresh id is a real second payment. Only if ` +
                  `this is a different payment, omit transferId.`,
                ),
                "TRANSFER_ID_CONFLICT",
                { field: "transferId" },
              );
            }
          } catch (err) {
            if (String(err?.message).startsWith("transfer-ids:")) throw err;
            /* unreadable neighbor — not this check's problem (read path guards it) */
          }
        }
      }
      const now = clock();
      const remainingMs = (invoiceSecondsRemaining(bolt11, now) ?? WEEK_MS / 1000) * 1000;
      const entry = {
        v: 1,
        transferId,
        invoice: String(bolt11).slice(0, 24),
        createdAt: new Date(now).toISOString(),
        expiresAt: now + Math.max(remainingMs, 0) + SETTLE_GRACE_MS,
      };
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
      } catch (err) {
        throw frame(err, "create the dedup store directory");
      }
      try {
        await atomicWriteFile(path, JSON.stringify(entry) + "\n", { exclusive: true });
      } catch (err) {
        if (err?.code !== "EEXIST") throw frame(err, "persist the dedup entry");
        const winner = await readEntry(path); // a concurrent racer published first
        if (!winner) {
          // Published, then deleted mid-race: another attempt at this invoice
          // got as far as its dedup entry, so it may be paying. Never a raw
          // EEXIST out of a payment path (it reads as "the seed file exists").
          throw annotateError(
            new Error(
              `transfer-ids: another attempt at this invoice recorded its dedup entry at ${path} and removed it ` +
                `while this one started — refusing to mint a fresh transferId while that attempt may be paying.`,
              { cause: err },
            ),
            "CONCURRENT_PAYMENT_ATTEMPT",
            { osCode: "EEXIST" },
          );
        }
        return resolve(winner, true);
      }
      prune().catch(() => {});
      return { transferId, reused: false };
    },
  };
}
