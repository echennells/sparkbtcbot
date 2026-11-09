// One writer at a time for a small JSON file that several processes share
// (the spend ledger, the user's limits): an exclusive `<path>.lock` held
// around each read-modify-write.
//
// The file itself is replaced atomically (atomic-file.js), so readers never
// see half a write; what the lock adds is that two writers can't both read
// the old contents and each write back their own change, losing the other's
// (review 2026-11-09: GATE-2 for the ledger, GATE-6 for `limits set`).
//
// `<path>.lock` is created O_EXCL and holds who took it. A lock is broken
// when its holder on this host is no longer running, or when it is older than
// LOCK_STALE_MS (the sections it guards are a read and an atomic write,
// milliseconds). The pid check is skipped for a lock from another host name,
// since a container sharing the directory has its own pids. Release removes
// only our own lock. Two waiters breaking the same stale lock at once can both
// get in: that needs a holder that died inside the section, and the result is
// what happened without the lock, a lost write, not a crash.
import { readFile, open, stat, unlink, mkdir } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { storageError } from "./agent-errors.js";

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 15_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The lock's contents if it may be broken, "gone" if it vanished, else false.
async function lockStale(lockPath) {
  let raw, info;
  try {
    [raw, info] = await Promise.all([readFile(lockPath, "utf8"), stat(lockPath)]);
  } catch (err) {
    return err.code === "ENOENT" ? "gone" : false;
  }
  if (Date.now() - info.mtimeMs > LOCK_STALE_MS) return raw;
  let holder = null;
  try {
    holder = JSON.parse(raw);
  } catch {
    return false; // being written right now, or junk: only age breaks it
  }
  if (holder?.host !== hostname() || !Number.isSafeInteger(holder?.pid) || holder.pid === process.pid) return false;
  try {
    process.kill(holder.pid, 0);
    return false;
  } catch (err) {
    return err.code === "ESRCH" ? raw : false;
  }
}

/**
 * Run `fn` holding `<path>.lock`. `what` names the file in errors ("Spend
 * ledger"), `nothingDone` says what didn't happen on a timeout ("nothing was
 * sent"). Throws STORAGE_ERROR when the lock can't be created, or stays held
 * by a live process for LOCK_WAIT_MS.
 */
export async function withFileLock(path, { what, nothingDone }, fn) {
  const lockPath = `${path}.lock`;
  const token = randomBytes(8).toString("hex");
  const deadline = Date.now() + LOCK_WAIT_MS;
  try {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  } catch (err) {
    throw storageError(err, `${what} directory for ${path} can't be created: ${err.message}`);
  }
  for (;;) {
    let fh = null;
    try {
      fh = await open(lockPath, "wx", 0o600);
    } catch (err) {
      if (err.code !== "EEXIST") throw storageError(err, `${what} lock ${lockPath} can't be created: ${err.message}`);
    }
    if (fh) {
      try {
        await fh.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), ts: Date.now(), token }));
      } finally {
        await fh.close();
      }
      break;
    }
    const stale = await lockStale(lockPath);
    if (stale === "gone") continue;
    // Break it only if it is still the lock we judged stale.
    if (stale !== false && (await readFile(lockPath, "utf8").catch(() => null)) === stale) {
      await unlink(lockPath).catch(() => {});
      continue;
    }
    if (Date.now() >= deadline) {
      throw storageError(new Error(`${lockPath} is held`), `${what} at ${path} stayed locked by another process for ${LOCK_WAIT_MS / 1000}s (${lockPath}); ${nothingDone}.`);
    }
    await sleep(5 + Math.floor(Math.random() * 20));
  }
  try {
    return await fn();
  } finally {
    try {
      if (JSON.parse(await readFile(lockPath, "utf8"))?.token === token) await unlink(lockPath);
    } catch {
      // gone already, or taken over as stale: it isn't ours to remove
    }
  }
}
