// Type declarations for sparkbtcbot-skill.

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
 * SPARK_SEED_PATH override) and decrypts the seed.
 * Throws { code: "NO_PASSPHRASE" } if SPARK_PASSPHRASE is unset — including
 * when a previous call in this process already read and (by default) cleared
 * it; the message distinguishes the two.
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

// --- Fee guardrails (bound the fee on sends, claims, and withdrawals) ---

/** An SDK CurrencyAmount, or a bare number of sats. */
export interface CurrencyAmountLike {
  originalValue: number;
  originalUnit?: string;
}

/** Read a sats scalar out of a CurrencyAmount or bare number; null if unreadable. */
export function satsFromCurrencyAmount(
  amount: CurrencyAmountLike | number | null | undefined,
): number | null;

/**
 * Read sats from a Lightning send fee estimate. The SDK returns a bare number
 * at runtime despite typing it as { feeEstimate: CurrencyAmount } — this accepts
 * both shapes. Returns null if unreadable.
 */
export function lightningEstimateSats(
  estimate: number | { feeEstimate?: CurrencyAmountLike | number } | null | undefined,
): number | null;

export interface LightningFeeCapOptions {
  amountSats?: number;
  estimatedFeeSats?: number;
  /** Minimum cap in sats (default 25 — Spark's flat fee component alone can hit 25 on small sends). */
  floorSats?: number;
  /** Cap as basis points of the amount (default 50 = 0.50%). */
  rateBps?: number;
}

/** Amount-aware default Lightning/L402 fee cap in sats. */
export function lightningFeeCap(options?: LightningFeeCapOptions): number;

export interface FeeCheck {
  ok: boolean;
  fee: number | null;
  cap: number | null;
  reason: string;
}

/** Decide whether an estimated fee is within a cap. `ok:false` => do not proceed. */
export function checkFeeAgainstCap(
  estimatedFeeSats: number | null | undefined,
  capSats: number | null | undefined,
): FeeCheck;

export interface L402AmountCheckOptions {
  amountSats?: number | null;
  /** Max invoice amount in sats. */
  maxAmountSats?: number;
}

export interface L402AmountCheck {
  ok: boolean;
  amountSats: number | null;
  cap: number | null;
  reason: string;
}

/** Bound an inbound-invoice payment amount (distinct from the routing-fee cap). */
export function checkL402Amount(options: L402AmountCheckOptions): L402AmountCheck;

export interface InvoiceQuoteCheckOptions {
  /** Decoded invoice amount in sats. */
  amountSats?: number | null;
  /** The price the merchant quoted, in sats. */
  quotedSats?: number | null;
  /** Absolute ceiling on the invoice amount, enforced on top of the quote. */
  maxAmountSats?: number;
  /** Allowed |invoice - quote| drift in basis points (default 200 = 2%). */
  toleranceBps?: number;
}

export interface InvoiceQuoteCheck {
  ok: boolean;
  amountSats: number | null;
  quotedSats: number | null;
  cap: number | null;
  reason: string;
}

/**
 * Pin a checkout invoice to the merchant's quoted price before paying (the
 * commerce counterpart of checkL402Amount). `ok:false` => do not pay.
 */
export function checkInvoiceAgainstQuote(
  options: InvoiceQuoteCheckOptions,
): InvoiceQuoteCheck;

/**
 * How many sats to DEPOSIT on L1 to fund a downstream Lightning payment via the
 * on-ramp. Accounts for BOTH fee legs — the Lightning fee AND the SSP claim
 * spread (which "invoice + lightning fee" alone omits, under-funding every
 * time). The result is a floor-with-margin, not exact: the claim spread isn't
 * knowable until 3 confirmations, so pay from the real credited balance after.
 */
export function estimateOnrampDeposit(options: {
  invoiceSats: number;
  lightningFeeSats?: number;
  /** Conservative buffer for the SSP claim spread; default 500 (measured ~297). */
  claimSpreadBufferSats?: number;
  slackSats?: number;
}): { depositSats: number; breakdown: { invoiceSats: number; lightningFeeSats: number; claimSpreadBufferSats: number; slackSats: number } };

/**
 * Operator-present fee cap: the amount-scaled cap, but never below the live
 * estimate plus headroom. Unattended agents should prefer the wrapper's
 * refuse-legibly behavior instead.
 */
export function estimateFirstFeeCap(options: {
  amountSats?: number | null;
  estimatedFeeSats?: number | null;
  headroomSats?: number;
  /** Absolute ceiling on estimate-driven growth (default 3× the amount-scaled cap). */
  maxCapSats?: number;
}): number;

/** Invoice's embedded amount in whole sats; null for amountless/undecodable. */
export function decodeInvoiceSats(bolt11: string): number | null;

/** Invoice's payment hash (lowercase hex); null when undecodable. */
export function invoicePaymentHash(bolt11: string): string | null;

/** True when the invoice's payment hash equals the checkout's echoed one. */
export function paymentHashMatches(
  bolt11: string,
  expectedPaymentHash: string | null | undefined,
): boolean;

/** Seconds until the invoice expires (negative = already expired); null if undecodable. */
export function invoiceSecondsRemaining(bolt11: string, nowMs?: number): number | null;

/** True when the invoice is already expired (or undecodable — fails closed). */
export function invoiceIsExpired(bolt11: string, nowMs?: number): boolean;

/** Total cooperative-exit fee (userFee + l1BroadcastFee) for a speed; null if unreadable. */
export function withdrawalTotalFee(
  quote: unknown,
  speed?: "FAST" | "MEDIUM" | "SLOW" | string,
): number | null;

// --- Spend ledger (cumulative rolling-window budget) ---

/** Default ledger location: ~/.spark/spend-ledger.json */
export const DEFAULT_SPEND_LEDGER_PATH: string;

/** One day in milliseconds — the default budget window. */
export const DAY_MS: number;

export interface SpendLedgerEntry {
  id: string;
  ts: number;
  sats: number;
  operation: string;
}

export interface SpendBudgetCheck {
  ok: boolean;
  sats: number | null;
  spentSats: number;
  budgetSats: number | null;
  remainingSats: number | null;
  reason: string;
}

/** Sats spent inside the window ending at `now`. */
export function spentInWindow(
  entries: SpendLedgerEntry[],
  options?: { windowMs?: number; now?: number },
): number;

/**
 * Pure budget decision. No budget => ok (opt-in guard); an unreadable amount
 * WITH a budget fails closed. `ok:false` => do not proceed.
 */
export function checkSpendBudget(options?: {
  entries?: SpendLedgerEntry[];
  sats?: number | bigint | null;
  budgetSats?: number | null;
  windowMs?: number;
  now?: number;
}): SpendBudgetCheck;

export interface SpendLedger {
  path: string;
  budgetSats: number | null;
  windowMs: number;
  status(): Promise<{
    spentSats: number;
    budgetSats: number | null;
    remainingSats: number | null;
    windowMs: number;
    entries: SpendLedgerEntry[];
  }>;
  /** Throws (code SPEND_BUDGET_EXCEEDED) when the spend would bust the budget. */
  assertCanSpend(sats: number | bigint, operation?: string): Promise<SpendBudgetCheck>;
  /** Append a spend and persist atomically; prunes aged-out entries. */
  record(sats: number | bigint, operation?: string): Promise<SpendLedgerEntry>;
  /** Best-effort refund for a send that provably never happened. */
  unrecord(id: string): Promise<void>;
}

/**
 * Persistent cumulative-spend ledger on the shared atomic writer. A corrupt
 * ledger file fails CLOSED (code SPEND_LEDGER_UNREADABLE) — delete the file
 * to reset. Single-agent-per-ledger; give concurrent agents separate paths.
 */
export function createSpendLedger(options?: {
  path?: string;
  budgetSats?: number | null;
  windowMs?: number;
  clock?: () => number;
}): SpendLedger;

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
