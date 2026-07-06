// Type declarations for sparkbtcbot.

// --- Encryption library ---

export interface SaveEncryptedMnemonicOptions {
  mnemonic: string;
  passphrase: string;
  /** Defaults to ~/.spark/seed.enc */
  path?: string;
}

export interface LoadMnemonicOptions {
  passphrase: string;
  /** Defaults to ~/.spark/seed.enc */
  path?: string;
}

export interface WriteMnemonicBackupFileOptions {
  /** Defaults to dirname(DEFAULT_SEED_PATH), typically ~/.spark/ */
  dir?: string;
}

/**
 * Encrypt a BIP39 mnemonic at rest with a user-supplied passphrase.
 * Uses scrypt (N=2^17, r=8, p=1) for key derivation and AES-256-GCM for
 * authenticated encryption. Refuses to overwrite an existing file.
 * @returns The path the encrypted seed was written to.
 */
export function saveEncryptedMnemonic(
  options: SaveEncryptedMnemonicOptions,
): Promise<string>;

/**
 * Decrypt and return the BIP39 mnemonic from a seed file.
 * Throws { code: "NO_SEED" } if the file is missing,
 *        { code: "BAD_PASSPHRASE" } if the passphrase is wrong or the file is tampered.
 */
export function loadMnemonic(options: LoadMnemonicOptions): Promise<string>;

/** Alias for loadMnemonic, symmetric with saveEncryptedMnemonic. */
export const loadEncryptedMnemonic: typeof loadMnemonic;

export interface LoadMnemonicFromEnvOptions {
  /**
   * If true (default), `process.env.SPARK_PASSPHRASE` is deleted immediately
   * after being read, BEFORE decrypt runs. Shrinks exposure to child
   * processes, debug dumps, and accidental `printenv`. Set false only if a
   * later code path genuinely needs to re-read the env var.
   */
  clearEnv?: boolean;
}

/**
 * Convenience wrapper: reads SPARK_PASSPHRASE from env (and optional
 * SPARK_SEED_PATH override) and decrypts the seed. Throws if SPARK_PASSPHRASE
 * is unset.
 */
export function loadMnemonicFromEnv(
  options?: LoadMnemonicFromEnvOptions,
): Promise<string>;

/**
 * Write a freshly-generated mnemonic to a persistent file (mode 0600) for
 * the human operator to back up offline. Returns the file path. The caller
 * is expected to instruct the user to read, copy offline, and `rm` the file.
 */
export function writeMnemonicBackupFile(
  mnemonic: string,
  options?: WriteMnemonicBackupFileOptions,
): Promise<string>;

/** ~/.spark/seed.enc (resolved from os.homedir() at module load time) */
export const DEFAULT_SEED_PATH: string;

// --- Recipient allowlist (opt-in agent guardrail) ---

export interface LoadRecipientsAllowlistOptions {
  /** Defaults to ~/.spark/recipients.allow */
  path?: string;
}

/**
 * Read the recipient allowlist file. Returns the list of allowed addresses,
 * or `null` if the file is missing / empty / all comments (meaning "not
 * enforced"). One address per line; `#` starts a comment; blank lines
 * ignored. Bypass = edit the file.
 */
export function loadRecipientsAllowlist(
  options?: LoadRecipientsAllowlistOptions,
): Promise<string[] | null>;

/**
 * Throw `{ code: "RECIPIENT_NOT_ALLOWED" }` if `address` is not in
 * `allowlist`. No-op when `allowlist` is null/undefined.
 */
export function assertRecipientAllowed(
  address: string,
  allowlist: string[] | null | undefined,
): void;

/** ~/.spark/recipients.allow (resolved from os.homedir() at module load time) */
export const DEFAULT_ALLOWLIST_PATH: string;

// --- Skill-content helpers (for non-Claude LLM frameworks) ---

/** Absolute path to the bundled SKILL.md inside this npm package. */
export const skillPath: string;

/** Absolute path to the bundled references/ directory inside this npm package. */
export const referencesDir: string;

/**
 * Returns the SKILL.md body as a string. Pass to your LLM framework's
 * system-prompt / context-injection mechanism.
 */
export function getSkillContent(): Promise<string>;

/**
 * Returns a specific reference doc by name (without .md extension).
 * Example: getReference("encrypted-seed") → references/encrypted-seed.md contents.
 */
export function getReference(name: string): Promise<string>;

/**
 * Returns the names of all reference docs available in this package
 * (without .md extension). Useful for dynamic-loading patterns where the
 * agent picks a reference based on the user's task.
 */
export function listReferences(): Promise<string[]>;
