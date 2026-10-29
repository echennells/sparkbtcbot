// L402 purchases that aren't finished, on disk: one file per request (method +
// URL), so a fetchL402 in a NEW process finishes the purchase instead of
// buying it again.
//
// Why on disk. In the common setup (a chat agent running `node …` once per
// tool call) every call is a new process. Held in memory only, a purchase
// whose payment was in doubt, or paid but not delivered, was forgotten when
// the process exited, and the retry fetched a new challenge with a NEW
// invoice and paid it: a second purchase the per-invoice dedup store can't
// see. The file is both:
//   - a semaphore while a purchase runs: `claim` creates it exclusively, with
//     the invoice in it, BEFORE paying, so a second process doesn't buy too,
//     and a process that dies mid-purchase leaves the exact invoice behind
//     (settled again through the dedup store, which can't pay twice);
//   - the hold after a purchase that didn't finish cleanly: in doubt, paid
//     but undelivered, failed with its sats possibly locked, or blocked.
// It goes when the purchase is delivered, proven unpaid, or forgotten on the
// user's say-so (forgetL402). Never because it is old: a crashed purchase may
// still have paid.
//
// What a file holds: the state, method, host and path (never the query
// string, which can carry keys; the file is named by a hash of method + URL),
// the invoice, the macaroon, the amount, the caps it was bought under and the
// send's id. Never the preimage: it is read back from Spark by the send's id,
// and with it the macaroon becomes a paid pass. Mode 0600 in a 0700 directory,
// next to the seed, which is worth far more.
//
// EXPORTS:
//   DEFAULT_L402_HOLDS_DIR      ~/.spark/l402-holds; l402HoldsDir() honours
//                               SPARK_L402_HOLDS_PATH
//   l402HoldFileName(key)       the file a request key maps to
//   createL402HoldStore({ dir }) → { dir, read, claim, put, remove, removeSync, count, list }
import { readFile, readdir, unlink, mkdir } from "node:fs/promises";
import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteFile } from "./atomic-file.js";
import { annotateError, storageError } from "./agent-errors.js";

export const DEFAULT_L402_HOLDS_DIR = join(homedir(), ".spark", "l402-holds");
export const l402HoldsDir = () => process.env.SPARK_L402_HOLDS_PATH || DEFAULT_L402_HOLDS_DIR;

const VERSION = 1;
const STATES = new Set(["buying", "held", "blocked"]);
export const l402HoldFileName = (key) => `${createHash("sha256").update(String(key)).digest("hex")}.json`;

const UNREADABLE_STEP =
  "An earlier purchase of this resource may have been paid: check getTransfers() before anything else, and don't buy it another way. Call forgetL402(url) only when the user asks in their own message, once getTransfers() shows no payment for it.";

function parseRecord(raw, file) {
  let rec;
  try {
    rec = JSON.parse(raw);
  } catch (err) {
    throw annotateError(new Error(`The L402 hold ${file} is not valid JSON; refusing to buy that resource while it may record a payment.`, { cause: err }), "L402_HOLD_UNREADABLE", { nextStep: UNREADABLE_STEP });
  }
  if (rec?.version !== VERSION || !STATES.has(rec.state) || typeof rec.method !== "string" || typeof rec.host !== "string" || typeof rec.path !== "string") {
    throw annotateError(new Error(`The L402 hold ${file} is not one this version reads; refusing to buy that resource while it may record a payment.`), "L402_HOLD_UNREADABLE", { nextStep: UNREADABLE_STEP });
  }
  return rec;
}

/**
 * @param {{ dir?: string }} [options]
 */
export function createL402HoldStore({ dir = l402HoldsDir() } = {}) {
  const pathFor = (key) => join(dir, l402HoldFileName(key));
  const ensureDir = () => mkdir(dir, { recursive: true, mode: 0o700 });
  const write = async (key, record, exclusive) => {
    const body = JSON.stringify({ ...record, version: VERSION, updatedAt: Date.now(), pid: process.pid }, null, 2) + "\n";
    try {
      await ensureDir();
      await atomicWriteFile(pathFor(key), body, { mode: 0o600, exclusive });
      return true;
    } catch (err) {
      if (exclusive && err?.code === "EEXIST") return false;
      throw storageError(err, `Couldn't write the L402 hold ${pathFor(key)}.`);
    }
  };
  return {
    dir,
    /** The record for `key`, or null. Throws L402_HOLD_UNREADABLE for one that can't be read. */
    async read(key) {
      let raw;
      try {
        raw = await readFile(pathFor(key), "utf8");
      } catch (err) {
        if (err?.code === "ENOENT") return null;
        throw storageError(err, `The L402 hold ${pathFor(key)} can't be read; refusing to buy that resource while it may record a payment.`, {
          code: "L402_HOLD_UNREADABLE",
          nextStep: UNREADABLE_STEP,
        });
      }
      return parseRecord(raw, pathFor(key));
    },
    /** Create the record only if none exists (the semaphore). false when one does. */
    claim: (key, record) => write(key, record, true),
    /** Create or replace. */
    put: (key, record) => write(key, record, false),
    async remove(key) {
      await unlink(pathFor(key)).catch((err) => {
        if (err?.code !== "ENOENT") throw storageError(err, `Couldn't remove the L402 hold ${pathFor(key)}.`);
      });
    },
    /** Synchronous, for forgetL402. true when a file was there. */
    removeSync(key) {
      try {
        rmSync(pathFor(key));
        return true;
      } catch (err) {
        if (err?.code === "ENOENT") return false;
        throw storageError(err, `Couldn't remove the L402 hold ${pathFor(key)}.`);
      }
    },
    /** How many holds there are: a directory listing, no file read (the limit check runs on every purchase). */
    async count() {
      try {
        return (await readdir(dir)).filter((n) => /^[0-9a-f]{64}\.json$/.test(n)).length;
      } catch (err) {
        if (err?.code === "ENOENT") return 0;
        throw storageError(err, `Couldn't list the L402 holds in ${dir}.`);
      }
    },
    /** Every record with its file name, or { unreadable: true, file } for one that can't be read. Skips the writer's temp files. */
    async list() {
      let names;
      try {
        names = await readdir(dir);
      } catch (err) {
        if (err?.code === "ENOENT") return [];
        throw storageError(err, `Couldn't list the L402 holds in ${dir}.`);
      }
      const out = [];
      for (const name of names.filter((n) => /^[0-9a-f]{64}\.json$/.test(n))) {
        try {
          out.push({ ...parseRecord(await readFile(join(dir, name), "utf8"), join(dir, name)), file: name });
        } catch {
          out.push({ unreadable: true, file: name });
        }
      }
      return out;
    },
  };
}
