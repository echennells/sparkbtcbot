// Encrypted-at-rest BIP39 mnemonic storage for Spark wallets.
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
// scryptSync params: N=2^17, r=8, p=1 (~100ms on modern CPU). OWASP
// recommends N>=2^17 for password-based KDF use cases; this is the
// "high security" preset.

import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from "node:crypto";
import { readFile, writeFile, chmod, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { homedir } from "node:os";

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

const MIN_PASSPHRASE_CHARS = 12;

export const DEFAULT_SEED_PATH = `${homedir()}/.spark/seed.enc`;

function deriveKey(passphrase, salt) {
  return scryptSync(passphrase, salt, KEY_BYTES, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: SCRYPT_MAXMEM,
  });
}

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
  // flag 'wx' = create exclusively; throws EEXIST if path already exists.
  // Re-encryption with a different passphrase is intentionally not supported
  // here — callers must explicitly delete the existing file first. This
  // prevents accidental overwrite of a wallet's only encrypted backup.
  await writeFile(path, blob, { mode: 0o600, flag: "wx" });
  await chmod(path, 0o600); // belt and suspenders
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
        `No encrypted seed at ${path}. Run \`npm run setup\` first.`,
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
export async function loadMnemonicFromEnv() {
  const passphrase = process.env.SPARK_PASSPHRASE;
  if (!passphrase) {
    throw new Error("SPARK_PASSPHRASE not set");
  }
  const path = process.env.SPARK_SEED_PATH || DEFAULT_SEED_PATH;
  return await loadMnemonic({ passphrase, path });
}
