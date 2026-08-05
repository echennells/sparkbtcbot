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

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { atomicWriteFile } from "./atomic-file.js";

const VERSION = 0x01;
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

export async function saveEncryptedMnemonic({
  mnemonic,
  passphrase,
  path = DEFAULT_SEED_PATH,
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

  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = deriveKey(passphrase, salt);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(mnemonic.trim(), "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  const header = Buffer.from([VERSION, KDF_SCRYPT, CIPHER_AES_256_GCM, 0x00]);
  const blob = Buffer.concat([header, salt, iv, tag, ciphertext]);

  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Re-encryption with a different passphrase is intentionally not supported
  // here — callers must explicitly delete the existing file first. This
  // prevents accidental overwrite of a wallet's only encrypted backup.
  await atomicCreateExclusive(path, blob);
  return path;
}

export async function loadMnemonic({ passphrase, path = DEFAULT_SEED_PATH }) {
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

  if (version !== VERSION) {
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
  decipher.setAuthTag(tag);

  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    const e = new Error("incorrect passphrase or corrupted seed file");
    e.code = "BAD_PASSPHRASE";
    throw e;
  }

  return plaintext.toString("utf8");
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

export async function loadMnemonicFromEnv({ clearEnv = true } = {}) {
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
  return await loadMnemonic({ passphrase, path });
}

// NOTE: writeMnemonicBackupFile (a persistent MNEMONIC_BACKUP_*.txt plaintext
// backup file) used to live here and was DELIBERATELY REMOVED. It undercut
// encryption-at-rest — the plaintext words sat on disk until a human remembered
// to rm them — and as a discoverable export it invited agents scaffolding a
// "backup step" to write the seed to disk. The supported backup path is the
// user-run, non-interactive-refusing `reveal-mnemonic` CLI. Do not reintroduce
// a plaintext-writing helper here.
