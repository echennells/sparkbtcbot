// Encrypted-at-rest BIP39 mnemonic storage for Spark wallets.
//
// EXPORTS (quick reference):
//   saveEncryptedMnemonic({ mnemonic, passphrase, path? })
//     → encrypts mnemonic, writes seed.enc (mode 0600), returns the path
//   loadMnemonic({ passphrase, path? })
//     → reads seed.enc, decrypts, returns the plaintext mnemonic string
//   loadMnemonicFromEnv()
//     → wraps loadMnemonic, reads SPARK_PASSPHRASE / SPARK_SEED_PATH from env
//   DEFAULT_SEED_PATH
//     → `${homedir()}/.spark/seed.enc`
//
// File format (single binary file, all big-endian):
//   1   byte   version (0x01)
//   1   byte   kdf id (0x01 = scrypt)
//   1   byte   cipher id (0x01 = aes-256-gcm)
//   1   byte   reserved (0x00)
//   16  bytes  salt
//   12  bytes  iv (aes-gcm nonce)
//   16  bytes  auth tag
//   N   bytes  ciphertext (mnemonic UTF-8 bytes)
//
// Total overhead: 48 bytes before ciphertext.
//
// Why these primitives:
// - scrypt: memory-hard, OWASP-blessed for password hashing, Node built-in
// - AES-256-GCM: authenticated encryption, 256-bit key, Node built-in
// - All in node:crypto — zero extra deps
//
// scryptSync params: N=2^17, r=8, p=1 (~250ms on a modern CPU). OWASP
// recommends N>=2^17 for password-based KDF use cases; this is the
// "high security" preset.

import { randomBytes, scryptSync, createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { openSync, readSync, closeSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { atomicWriteFile } from "./atomic-file.js";

const VERSION = 0x01;    // payload = bare mnemonic (no bound policy)
const VERSION_V2 = 0x02; // payload = JSON { mnemonic, policy } — seed-bound guard policy
const KDF_SCRYPT = 0x01;
const CIPHER_AES_256_GCM = 0x01;

const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

// scrypt cost parameters
const SCRYPT_N = 2 ** 17;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024; // 256 MB upper bound; N=2^17 needs ~128 MB

export const MIN_PASSPHRASE_CHARS = 12;

export const DEFAULT_SEED_PATH = `${homedir()}/.spark/seed.enc`;

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

// Atomically create `path` with `data` at mode 0600, refusing to overwrite an
// existing file. Both properties are kernel-atomic in the shared writer
// (lib/atomic-file.js): the payload is fully written and fsync'd to a unique
// temp, then published with link(2), which fails EEXIST rather than replace —
// no check-then-act window, so two concurrent setups cannot silently swap a
// wallet's only encrypted backup. A crash mid-write leaves at worst nothing at
// `path` — never a partial seed.enc or partial mnemonic backup.
const atomicCreateExclusive = (path, data) =>
  atomicWriteFile(path, data, { mode: 0o600, exclusive: true });

// Guard policy that can be BOUND into the encrypted seed payload (v2 files).
// Bound policy inherits the seed's protections: reading it needs the
// passphrase, tampering fails the GCM auth tag, and deleting it deletes the
// wallet — the agent can't remove the budget without removing the money.
// Unknown keys throw (misspelled-option doctrine: a typo'd policy key must
// not silently mean "no policy").
export function validateSeedPolicy(policy) {
  if (policy == null) return null;
  if (typeof policy !== "object" || Array.isArray(policy)) {
    throw new Error("seed policy must be an object like { dailyBudgetSats: <sats> }");
  }
  const unknown = Object.keys(policy).filter((k) => k !== "dailyBudgetSats");
  if (unknown.length) {
    throw new Error(`seed policy has unknown key(s): ${unknown.join(", ")} — supported: dailyBudgetSats`);
  }
  const b = policy.dailyBudgetSats;
  if (typeof b !== "number" || !Number.isSafeInteger(b) || b <= 0) {
    throw new Error(`seed policy dailyBudgetSats must be a positive integer number of sats, got ${JSON.stringify(b)}`);
  }
  return { dailyBudgetSats: b };
}

// HMAC key for the signed spend ledger, derived from the mnemonic via HKDF
// with its own context — NEVER the AES key, and cheap (no second scrypt).
// Deterministic across hosts by design (same mnemonic -> same key), which is
// what makes a migrated ledger verifiable — and is also why replay (restoring
// an old validly-signed ledger) is documented as out of scope.
export function deriveLedgerHmacKey(mnemonic) {
  if (typeof mnemonic !== "string" || !mnemonic.trim()) {
    throw new Error("deriveLedgerHmacKey: mnemonic must be a non-empty string");
  }
  return Buffer.from(hkdfSync(
    "sha256",
    Buffer.from(mnemonic.trim(), "utf8"),
    Buffer.from("sparkbtcbot/seed-policy/v1"),
    Buffer.from("spend-ledger-hmac"),
    32,
  ));
}

function encryptBlob({ mnemonic, passphrase, policy }) {
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);

  // v1 (bare mnemonic) when no policy — byte-compatible with older readers.
  // v2 (JSON envelope) only when a policy is actually bound.
  const version = policy ? VERSION_V2 : VERSION;
  const plaintext = policy
    ? JSON.stringify({ mnemonic: mnemonic.trim(), policy })
    : mnemonic.trim();

  const header = Buffer.from([version, KDF_SCRYPT, CIPHER_AES_256_GCM, 0x00]);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  // v2 binds the 4 header bytes as AAD so the version byte is AUTHENTICATED:
  // without it, flipping 0x02 -> 0x01 passes GCM and the payload is reinterpreted
  // as a bare mnemonic — silently dropping the sealed policy. v1 files predate
  // this and must stay AAD-free to remain readable (and are inert anyway: with
  // one version there was nothing to downgrade to).
  if (version === VERSION_V2) cipher.setAAD(header);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([header, salt, iv, tag, ciphertext]);
}

export async function saveEncryptedMnemonic({
  mnemonic,
  passphrase,
  path = DEFAULT_SEED_PATH,
  policy = null,
  allowOverwrite = false,
}) {
  if (typeof mnemonic !== "string" || !mnemonic.trim()) {
    throw new Error("mnemonic must be a non-empty string");
  }
  if (typeof passphrase !== "string") {
    throw new Error("passphrase must be a string");
  }
  if (passphrase.length < MIN_PASSPHRASE_CHARS) {
    throw new Error(
      `passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters`,
    );
  }
  const boundPolicy = validateSeedPolicy(policy);
  const blob = encryptBlob({ mnemonic, passphrase, policy: boundPolicy });

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Re-encryption is intentionally exclusive by default — callers must delete
  // the existing file first, preventing accidental overwrite of a wallet's
  // only encrypted backup. allowOverwrite exists for the deliberate,
  // TTY-gated set-policy ceremony ONLY (decrypt -> modify -> atomic swap).
  if (allowOverwrite) {
    await atomicWriteFile(path, blob, { mode: 0o600 });
  } else {
    await atomicCreateExclusive(path, blob);
  }
  return path;
}

// Is the seed file at `path` a SEALED (v2) seed? Reads only the PLAINTEXT
// version byte — no passphrase needed. This lets callers fail CLOSED when a
// sealed seed's policy did not reach them (duplicate module copies, a raw
// loadMnemonic call, a wallet opened before the policy was read): "sealed but
// unbound" must be a loud error, never a silent fallback to the pre-seal
// behavior where deleting the ledger restored the budget. Absent/unreadable
// file => false (nothing to enforce yet).
export function seedFileIsSealed(path = DEFAULT_SEED_PATH) {
  try {
    const fd = openSync(path, "r");
    try {
      const b = Buffer.alloc(1);
      return readSync(fd, b, 0, 1, 0) === 1 && b[0] === VERSION_V2;
    } finally { closeSync(fd); }
  } catch { return false; }
}

// Full decrypted payload: { mnemonic, policy, version }. v1 files carry no
// policy (null); v2 files carry the seed-bound guard policy.
export async function loadSeedPayload({ passphrase, path = DEFAULT_SEED_PATH }) {
  if (typeof passphrase !== "string" || !passphrase) {
    throw new Error("passphrase is required");
  }

  let blob;
  try {
    blob = await readFile(path);
  } catch (err) {
    if (err.code === "ENOENT") {
      const e = new Error(
        `No encrypted seed at ${path} — create one with the setup script ` +
        `(\`npm run setup\` in the skill repo, or setup-encrypted-seed.js wherever this lib was copied from).`,
      );
      e.code = "NO_SEED";
      throw e;
    }
    throw err;
  }

  if (blob.length < 4 + SALT_BYTES + IV_BYTES + TAG_BYTES) {
    throw new Error("encrypted seed file is corrupted (too short)");
  }

  const version = blob[0];
  const kdfId = blob[1];
  const cipherId = blob[2];

  if (version !== VERSION && version !== VERSION_V2) {
    throw new Error(`unsupported seed file version: ${version}`);
  }
  if (kdfId !== KDF_SCRYPT) {
    throw new Error(`unsupported kdf id: ${kdfId}`);
  }
  if (cipherId !== CIPHER_AES_256_GCM) {
    throw new Error(`unsupported cipher id: ${cipherId}`);
  }

  let offset = 4;
  const salt = blob.subarray(offset, offset + SALT_BYTES);
  offset += SALT_BYTES;
  const iv = blob.subarray(offset, offset + IV_BYTES);
  offset += IV_BYTES;
  const tag = blob.subarray(offset, offset + TAG_BYTES);
  offset += TAG_BYTES;
  const ciphertext = blob.subarray(offset);

  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  // Mirror of the write path: v2 authenticates the header, so a flipped version
  // byte now fails the auth tag instead of downgrading the payload.
  if (version === VERSION_V2) decipher.setAAD(blob.subarray(0, 4));
  decipher.setAuthTag(tag);

  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    const e = new Error("incorrect passphrase or corrupted seed file");
    e.code = "BAD_PASSPHRASE";
    throw e;
  }

  if (version === VERSION) {
    return { mnemonic: plaintext.toString("utf8"), policy: null, version: 1 };
  }
  // v2: GCM already authenticated the bytes; a JSON parse failure here means a
  // writer bug, not tampering — but still fail closed rather than guess.
  let payload;
  try {
    payload = JSON.parse(plaintext.toString("utf8"));
  } catch {
    throw new Error("seed file v2 payload is not valid JSON — refusing to guess at the mnemonic");
  }
  if (typeof payload?.mnemonic !== "string" || !payload.mnemonic.trim()) {
    throw new Error("seed file v2 payload has no mnemonic — refusing");
  }
  return { mnemonic: payload.mnemonic, policy: validateSeedPolicy(payload.policy ?? null), version: 2 };
}

// Back-compat: the historical API returning just the mnemonic string. Works
// for both v1 and v2 files.
export async function loadMnemonic({ passphrase, path = DEFAULT_SEED_PATH }) {
  const { mnemonic } = await loadSeedPayload({ passphrase, path });
  return mnemonic;
}

// Convenience: load mnemonic from env. Returns the decrypted mnemonic string.
// Reads SPARK_PASSPHRASE; optional SPARK_SEED_PATH overrides the default location.
//
// By default the passphrase is deleted from process.env immediately after
// being read, BEFORE the decrypt runs. This shrinks the exposure window for
// child processes (which inherit env), accidental `printenv` / debug
// dumps, and crash reporters that snapshot env. Even on a failed decrypt
// (BAD_PASSPHRASE, NO_SEED) the env var is gone. Pass { clearEnv: false }
// to keep the variable in place — only do this if a later code path
// genuinely needs to re-read it, which is unusual.
//
// Note: this does not remove the V8-internal string for the passphrase
// (strings are immutable). It only narrows the OS-level / debugging
// surface. A full zero-after-use story would require Node to expose
// scryptSync over Uint8Array end-to-end, which it doesn't.
let passphraseCleared = false; // no secret stored — only "we deleted the env var"

// Seed context observed by the LAST successful *FromEnv load in this process:
// { policy, ledgerHmacKey } — or null before any load / for v1 (no-policy)
// files. SparkAgent reads this so a seed-bound budget reaches the spend ledger
// without a second scrypt and without changing every caller's plumbing. It is
// process-internal state, deliberately NOT persisted anywhere the agent could
// edit — that's the point.
// Stored on globalThis, not in module scope: a project can end up with TWO
// copies of this module (npm package + a copied lib/), and a module-scoped
// registry would leave the SparkAgent instance reading a different copy's
// (empty) context — silently unbound, i.e. exactly the pre-fix behavior.
const CTX_KEY = Symbol.for("sparkbtcbot.loadedSeedContext");
export function getLoadedSeedContext() {
  return globalThis[CTX_KEY] ?? null;
}
// A policy-less load must never CLEAR a context a sealed seed already
// established (two wallets in one process): downgrading to "no policy" is the
// one direction that silently removes protection.
function setLoadedSeedContext(ctx) {
  if (ctx == null && globalThis[CTX_KEY] != null) return;
  globalThis[CTX_KEY] = ctx;
}

export async function loadSeedPayloadFromEnv({ clearEnv = true } = {}) {
  const passphrase = process.env.SPARK_PASSPHRASE;
  if (!passphrase) {
    // Distinguish "never set" from "this process already read and cleared it" —
    // the latter otherwise produces a baffling lie on a second wallet open.
    const e = new Error(passphraseCleared
      ? "SPARK_PASSPHRASE was already read and cleared from process.env by a previous " +
        "loadMnemonicFromEnv() call in this process — reuse the mnemonic that call returned, " +
        "or pass { clearEnv: false } to the first call if you must read the env var again"
      : "SPARK_PASSPHRASE not set");
    e.code = "NO_PASSPHRASE";
    throw e;
  }
  const path = process.env.SPARK_SEED_PATH || DEFAULT_SEED_PATH;
  if (clearEnv) {
    delete process.env.SPARK_PASSPHRASE;
    passphraseCleared = true;
  }
  const payload = await loadSeedPayload({ passphrase, path });
  setLoadedSeedContext(payload.policy
    ? { policy: payload.policy, ledgerHmacKey: deriveLedgerHmacKey(payload.mnemonic), seedPath: path }
    : null);
  return payload;
}

export async function loadMnemonicFromEnv({ clearEnv = true } = {}) {
  const { mnemonic } = await loadSeedPayloadFromEnv({ clearEnv });
  return mnemonic;
}

// NOTE: writeMnemonicBackupFile (a persistent MNEMONIC_BACKUP_*.txt plaintext
// backup file) used to live here and was DELIBERATELY REMOVED. It undercut
// encryption-at-rest — the plaintext words sat on disk until a human remembered
// to rm them — and as a discoverable export it invited agents scaffolding a
// "backup step" to write the seed to disk. The supported backup path is the
// user-run, non-interactive-refusing `reveal-mnemonic` CLI. Do not reintroduce
// a plaintext-writing helper here.
