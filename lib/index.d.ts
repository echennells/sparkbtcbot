// Type declarations for sparkbtcbot-skill.

// --- Encryption library ---

/** Canonical operation names a policy can name (the ledger / dry-run vocabulary). */
export type PolicyOp =
  | "spark_transfer"
  | "lightning_pay"
  | "fulfill_spark_invoice"
  | "token_transfer"
  | "claim_deposit"
  | "l1_withdraw";

/**
 * Guard policy bound INSIDE the encrypted seed payload (v2 seed files). Every
 * key is optional; unknown keys are refused at boot. Managed only by the
 * TTY-gated `sparkbtcbot set-policy` ceremony. See references/security.md →
 * Policy engine for what each rule bounds and the fail-closed table.
 */
export interface SeedPolicy {
  /** Rolling 24h spend budget, sats. Wins absolutely over SPARK_DAILY_BUDGET_SATS. */
  dailyBudgetSats?: number;
  /** Per-transaction cap on outbound sats ops; an unreadable amount fails closed. */
  maxPerTxSats?: number;
  /** Operations permitted at all (claims included). Absent = every op. */
  allowedOps?: PolicyOp[];
  /** Tamper-proof recipient allowlist (AND-ed with ~/.spark/recipients.allow). Not Lightning. */
  allowedRecipients?: string[];
  /** ISO-8601; after it, outbound spends are denied (reads and claims continue). */
  expiresAt?: string;
  /** Operator executable, pinned by sha256: stdin PolicyContext JSON → stdout {allow, reason?}. */
  exec?: { path: string; sha256: string };
}

/** What a policy rule or the exec hook sees for one request. Never holds a secret. */
export interface PolicyContext {
  v: 1;
  op: PolicyOp;
  outbound: boolean;
  amountSats: number | null;
  unit: "sats" | "tokens";
  tokenIdentifier?: string;
  tokenAmount?: string;
  recipients: string[];
  invoiceHash?: string;
  dailyTotalSats: number | null;
  dailyBudgetSats: number | null;
  remainingSats: number | null;
  walletAddress: string | null;
  network: string;
  dryRun: boolean;
  timestamp: string;
}

export type PolicyVerdict = { allow: true } | { allow: false; rule: string; reason: string };

/** Thrown by SparkAgent when the policy denies a money-moving call. */
export class PolicyDeniedError extends Error {
  code: "POLICY_DENIED";
  op: PolicyOp;
  rule: string;
  reason: string;
  context: PolicyContext | null;
}

export const POLICY_OPS: readonly PolicyOp[];
export const OUTBOUND_OPS: ReadonlySet<PolicyOp>;
export const POLICY_EXEC_TIMEOUT_MS: number;
/** Validates/normalizes a policy object; throws on unknown keys or unreadable values. */
export function validatePolicyObject(policy: unknown): SeedPolicy | null;
/** Declarative rules only (expiresAt → allowedOps → allowedRecipients → maxPerTxSats). */
export function evaluateDeclarativeRules(
  ctx: PolicyContext,
  policy: SeedPolicy | null,
  deps?: { matchRecipient?: (recipient: string, list: string[]) => boolean; now?: number },
): PolicyVerdict;
/** Declarative rules, then (live calls only) the exec hook. Never throws. */
export function evaluatePolicy(
  ctx: PolicyContext,
  policy: SeedPolicy | null,
  deps?: { matchRecipient?: (recipient: string, list: string[]) => boolean; now?: number; timeoutMs?: number },
): Promise<PolicyVerdict>;
/** Run the pinned executable with the context on stdin; every failure class is a deny. */
export function runPolicyExec(
  exec: { path: string; sha256: string },
  ctx: PolicyContext,
  opts?: { timeoutMs?: number },
): Promise<PolicyVerdict>;
export function sha256File(path: string): Promise<string>;

/** Append-only JSONL audit log (~/.spark/audit.jsonl). append() refuses secret-shaped keys. */
export interface AuditLog {
  path: string;
  append(entry: Record<string, unknown>): Promise<void>;
}
export function createAuditLog(options?: { path?: string; clock?: () => number }): AuditLog;
/** null when SPARK_AUDIT_LOG=off. */
export function auditLogFromEnv(): AuditLog | null;
export const DEFAULT_AUDIT_LOG_PATH: string;

/** Re-encrypt seed.enc (mnemonic + sealed policy, unchanged) under a new passphrase, atomically. */
export function rekeyEncryptedSeed(options: {
  path?: string;
  passphrase: string;
  newPassphrase: string;
}): Promise<{ version: 1 | 2; policy: SeedPolicy | null }>;

export interface SaveEncryptedMnemonicOptions {
  mnemonic: string;
  passphrase: string;
  /** Defaults to ~/.spark/seed.enc */
  path?: string;
  /** Bind a guard policy into the payload (writes a v2 file). null = v1, no policy. */
  policy?: SeedPolicy | null;
  /** ONLY for the TTY-gated set-policy ceremony: replace an existing seed atomically. */
  allowOverwrite?: boolean;
}

/** Decrypted seed payload: v1 files carry policy: null. */
export interface SeedPayload {
  mnemonic: string;
  policy: SeedPolicy | null;
  version: 1 | 2;
}

export function loadSeedPayload(options: LoadMnemonicOptions): Promise<SeedPayload>;
export function loadSeedPayloadFromEnv(options?: { clearEnv?: boolean }): Promise<SeedPayload>;
/** Seed context from the last *FromEnv load: null before any load / for v1 seeds. */
export function getLoadedSeedContext(): { policy: SeedPolicy; ledgerHmacKey: Buffer } | null;
/** Alias of validatePolicyObject — the validator the seal uses. */
export function validateSeedPolicy(policy: unknown): SeedPolicy | null;
/** HKDF-derived (never the AES key) HMAC key for the signed spend ledger. */
export function deriveLedgerHmacKey(mnemonic: string): Buffer;

export interface LoadMnemonicOptions {
  passphrase: string;
  /** Defaults to ~/.spark/seed.enc */
  path?: string;
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

// --- Lightning payment-dedup store (persisted per-invoice transferId) ---

/** Default store location: ~/.spark/ln-dedup/ (one JSON file per invoice). */
export const DEFAULT_TRANSFER_IDS_DIR: string;

/** The invoice's payment hash (hex), or a hash of the string when undecodable. */
export function invoiceDedupKey(bolt11: string): string;

/**
 * Persistent per-invoice `transferId` store (spark-sdk >=0.10 payment dedup).
 * `idForInvoice` returns the stored id for the invoice when a prior attempt
 * recorded one, else persists `mint()`'s result write-ahead and returns it.
 * An `explicitId` that disagrees with a stored id throws; an unreadable
 * stored entry throws (fail closed) rather than minting a fresh id.
 */
export function createTransferIdStore(options?: {
  dir?: string;
  clock?: () => number;
}): {
  dir: string;
  idForInvoice(
    bolt11: string,
    mint: () => string,
    options?: { explicitId?: string },
  ): Promise<{ transferId: string; reused: boolean }>;
  /** Remove entries whose recorded expiry has passed. Best-effort; returns the count removed. */
  prune(): Promise<number>;
};

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
  /** Seed-derived key (deriveLedgerHmacKey). Required when bound. */
  hmacKey?: Buffer | null;
  /** true = seed-bound policy: absent/unsigned/tampered ledger THROWS instead of resetting. */
  bound?: boolean;
}): SpendLedger;

/** Write a fresh EMPTY signed ledger — the legitimate reset that replaces `rm`. */
export function initSignedLedger(options: { path?: string; hmacKey: Buffer }): Promise<string>;

// --- Spend-side sizing: the largest gift-card face a balance can pay for ---

export interface MaxSpendableFaceOptions {
  availableSats: number;
  /** BTC price in the merchant's fiat (from fetchBtcPrice). */
  pricePerBtc: number;
  /** Merchant markup over face, in basis points. Default 200 (2%). */
  merchantMarkupBps?: number;
  /** Sats to leave untouched. Default 100. */
  slackSats?: number;
  /** Fixed packs the product sells (e.g. [5, 10, 20, 50, 100]). Mutually exclusive with range. */
  denominations?: number[];
  /** Custom-amount product bounds. Mutually exclusive with denominations. */
  range?: { min: number; max: number; step?: number };
}

export interface MaxSpendableFaceResult {
  /** Face value to ask the merchant for, or null when nothing fits (see reason). */
  face: number | null;
  reason?: string;
  rawFace?: number;
  breakdown: Record<string, number>;
}

/** Largest face value whose marked-up invoice + Lightning fee + slack fits the balance, snapped to what the product sells. */
export function maxSpendableFace(options: MaxSpendableFaceOptions): MaxSpendableFaceResult;

// --- Fiat rate: BTC price from two keyless sources, cross-checked ---

export interface PriceSource {
  name: string;
  url(currency: string): string;
  parse(json: unknown, currency: string, ctx: { now: number; maxAgeMs: number }): { price: number; at: number };
}

export interface BtcPrice {
  currency: string;
  /** Mean of the agreeing sources (or the single answering source). */
  price: number;
  /** Epoch ms of the oldest answering source's timestamp. */
  at: number;
  sources: Array<{ name: string; price: number; at: number }>;
  failed: Array<{ name: string; error: string }>;
  singleSource: boolean;
  disagreementBps: number | null;
}

export const DEFAULT_PRICE_SOURCES: PriceSource[];

/**
 * Query mempool.space and Coinbase in parallel. Throws when no source answers
 * or when two answers disagree by more than maxDisagreementBps (default 300).
 */
export function fetchBtcPrice(options?: {
  currency?: string;
  fetch?: typeof fetch;
  sources?: PriceSource[];
  timeoutMs?: number;
  maxAgeMs?: number;
  maxDisagreementBps?: number;
  now?: number;
}): Promise<BtcPrice>;

/** Whole sats for a fiat amount at a BTC price (nearest sat). */
export function fiatToSats(amountFiat: number | string, pricePerBtc: number | string): number;
/** Fiat value of a sats amount at a BTC price. */
export function satsToFiat(sats: number | bigint, pricePerBtc: number | string): number;
/** One-line, honest description of a rate: "76,764 USD/BTC (mempool.space + coinbase, 2026-09-15 12:04 UTC)". */
export function describeRate(rate: BtcPrice, options?: { locale?: string }): string;

// --- Wallet privacy (Spark wallets are publicly readable by default) ---

/** The SDK's WalletSettings, as returned by getWalletSettings()/setPrivacyEnabled(). */
export interface WalletSettingsLike {
  ownerIdentityPublicKey: string;
  privateEnabled: boolean;
  /** Identity key granted read-only access while private (spark-sdk >= 0.12). */
  viewerIdentityPublicKey?: string;
}

/** The two wallet methods ensureWalletPrivacy needs (a SparkWallet satisfies this). */
export interface PrivacyCapableWallet {
  getWalletSettings(): Promise<WalletSettingsLike | undefined>;
  setPrivacyEnabled(enabled: boolean): Promise<WalletSettingsLike | undefined>;
}

/**
 * True unless SPARK_PRIVACY is "off" | "false" | "0" | "no" (case-insensitive).
 * Unset or unrecognised means ON.
 */
export function privacyPreferenceFromEnv(env?: NodeJS.ProcessEnv): boolean;

/**
 * Read the wallet's per-identity privacy setting at the operators and set it to
 * `enabled` (default true) if it differs. Idempotent. Throws on an unknown
 * option, a wallet without the SDK >= 0.11 methods, or a write the operators
 * did not record.
 */
export function ensureWalletPrivacy(
  wallet: PrivacyCapableWallet,
  options?: { enabled?: boolean },
): Promise<{ changed: boolean; settings: WalletSettingsLike | undefined }>;

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
