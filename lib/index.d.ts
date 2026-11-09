// Type declarations for sparkbtcbot-skill.

// --- Encryption library ---

/** Guard policy bound INSIDE the encrypted seed payload (v2 seed files). */
export interface SeedPolicy {
  /** Rolling 24h spend budget, sats. Wins absolutely over SPARK_DAILY_BUDGET_SATS. */
  dailyBudgetSats: number;
}

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
/** Validates/normalizes a policy object; throws on unknown keys or garbage budgets. */
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
 * ignored. Bypass = the user edits the file (an agent must not).
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

// --- Spending limits the user sets in chat (`sparkbtcbot limits`) ---

/** The operations `allowedOps` can list: the names the spend ledger records. */
export type LimitOp = "spark_transfer" | "lightning_pay" | "fulfill_spark_invoice" | "token_transfer" | "l1_withdraw" | "claim_deposit";
export const LIMIT_OPS: readonly LimitOp[];

/**
 * The user's spending limits (~/.spark/limits.json). Every rule is optional.
 * The agent sets them when the user asks in chat, and only then. They guard
 * against mistakes and casual injection, not a hijacked agent: the balance is
 * the only hard limit.
 */
export interface SpendingLimits {
  /** Rolling-24h budget, on top of the budget in force (a seed-bound one, which overrides SPARK_DAILY_BUDGET_SATS, else the env one): the tighter wins. */
  dailyBudgetSats?: number;
  /** Cap on each sats payment (not token transfers or fees). */
  maxPaymentSats?: number;
  /** Only these operations may run; claim_deposit (inbound) included. */
  allowedOps?: LimitOp[];
  /** Only these recipients (Spark or L1 addresses). Lightning payments have no address: leave lightning_pay out of allowedOps to stop them. */
  allowedRecipients?: string[];
  /** ISO time of the last write. */
  updatedAt?: string;
}

/** SPARK_LIMITS_PATH, else ~/.spark/limits.json. */
export function limitsPath(): string;
export const DEFAULT_LIMITS_PATH: string;
/** Normalized limits, or null for none; throws BAD_INPUT on an unknown key or unreadable value. */
export function validateLimits(limits: unknown): SpendingLimits | null;
/** null when there is no file; throws LIMITS_UNREADABLE for one that can't be read or doesn't validate. */
export function readLimits(path?: string): Promise<SpendingLimits | null>;
/** Atomic write (mode 0600), or removal for null / no rules. Returns what was written. */
export function writeLimits(limits: SpendingLimits | null, path?: string): Promise<SpendingLimits | null>;
export function checkLimits(
  ctx: { op: LimitOp; recipients?: string[]; amountsSats?: Array<number | null> },
  limits: SpendingLimits | null,
  options?: { matchRecipient?: (recipient: string, list: string[]) => boolean },
): { allow: true } | { allow: false; rule: "allowedOps" | "allowedRecipients" | "maxPaymentSats"; reason: string };
/** What changed; `looser` when it lets the agent spend more, on more, or to more recipients. */
export function limitsChanges(
  before: SpendingLimits | null,
  after: SpendingLimits | null,
): Array<{ rule: string; from: unknown; to: unknown; looser: boolean }>;

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
  /** The transferId recorded for this invoice, or null when no attempt was recorded. Never mints. */
  peek(bolt11: string): Promise<{ transferId: string; createdAt: string | null } | null>;
  /**
   * Remove the entry for an invoice whose payment terminally failed. With
   * `expectedId`, only while the entry still records that id. Returns whether
   * one was removed.
   */
  forget(bolt11: string, expectedId?: string): Promise<boolean>;
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
  /** limitSats: the user's daily limit; the tighter of it and budgetSats applies. */
  status(options?: { limitSats?: number | null }): Promise<{
    spentSats: number;
    budgetSats: number | null;
    remainingSats: number | null;
    windowMs: number;
    entries: SpendLedgerEntry[];
  }>;
  /** Throws (code SPEND_BUDGET_EXCEEDED) when the spend would bust the budget. */
  assertCanSpend(sats: number | bigint, operation?: string, options?: { limitSats?: number | null }): Promise<SpendBudgetCheck>;
  /** Append a spend and persist atomically; prunes aged-out entries. */
  record(sats: number | bigint, operation?: string): Promise<SpendLedgerEntry>;
  /** Best-effort refund for a send that provably never happened. */
  unrecord(id: string): Promise<void>;
}

/**
 * Persistent cumulative-spend ledger on the shared atomic writer. A corrupt
 * ledger file fails CLOSED (code SPEND_LEDGER_UNREADABLE); deleting it resets
 * the window, so an agent does that only when the user asks in their own
 * message. A seed-bound ledger is reset only with `sparkbtcbot reset-ledger`.
 * Single-agent-per-ledger; give concurrent agents separate paths.
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

// --- Wallet options ---

/**
 * SDK 0.13's two fee-ladder options, both false. Every wallet this package
 * opens passes them: a refund signed with the refund ladder on has no anchor,
 * and the exit tool the leaf-vault backup is for can't exit such a leaf.
 */
export const FEE_LADDERS_OFF: Readonly<{
  enableCpfpRefundLadder: false;
  enableDirectNodeFeeLadder: false;
}>;

/**
 * Options for SparkWallet.initialize: `extra`, the network, and FEE_LADDERS_OFF
 * (applied last, so `extra` can't turn a ladder back on). The settings belong
 * to the wallet object, so every program opening the seed must pass them.
 * Throws a TypeError on any other network value: the SDK would quietly open
 * REGTEST (undefined) or LOCAL (lowercase, an object) endpoints instead.
 */
export type SparkNetworkName = "MAINNET" | "TESTNET" | "SIGNET" | "REGTEST" | "LOCAL";
export function sparkWalletOptions<T extends Record<string, unknown> = {}>(
  network: SparkNetworkName,
  extra?: T,
): Omit<T, "network" | "enableCpfpRefundLadder" | "enableDirectNodeFeeLadder"> & {
  network: SparkNetworkName;
  enableCpfpRefundLadder: false;
  enableDirectNodeFeeLadder: false;
};

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

// --- The error contract (lib/agent-errors.js) ---

/**
 * What an agent may do after an error, read from `err.retryable`:
 * - "yes": proven that nothing happened and nothing is pending; the same call again is safe.
 * - "no": the same call fails the same way; the input, a setting or the state has to change first.
 * - "check-first": money (or value) may have moved; look (`err.nextStep` says where) before doing anything else.
 */
export type Retryable = "yes" | "no" | "check-first";

/**
 * Every code this package raises: the keys of AGENT_ERRORS. The names are
 * stable API; the ones that predate the contract (PAYMENT_COMMITTED, the
 * SPEND_LEDGER_* family, EEXIST, …) keep their exact spelling.
 */
export type AgentErrorCode =
  // Input and caller mistakes
  | "BAD_INPUT"
  | "INVOICE_INVALID"
  | "RECIPIENT_INVALID"
  | "PAYMENT_HASH_MISMATCH"
  | "AMOUNT_MISMATCH"
  // Guard refusals
  | "AMOUNT_OVER_LIMIT"
  | "FEE_OVER_LIMIT"
  | "QUOTE_UNREADABLE"
  | "INSUFFICIENT_FUNDS"
  | "RECIPIENT_NOT_ALLOWED"
  | "LIMIT_DENIED"
  | "LIMITS_UNREADABLE"
  | "SPEND_BUDGET_EXCEEDED"
  | "SPEND_LEDGER_MISSING"
  | "SPEND_LEDGER_BAD_SIGNATURE"
  | "SPEND_LEDGER_UNREADABLE"
  | "INVOICE_EXPIRED"
  | "INVOICE_REFUSED"
  | "SINGLE_USE_DEPOSITS_UNAVAILABLE"
  | "DEPOSIT_NOT_FOUND"
  | "DEPOSIT_LOOKUP_INCOMPLETE"
  | "L402_CHALLENGE_INVALID"
  | "L402_TOO_MANY_HELD"
  | "L402_TOKEN_EXPIRED"
  // Money (or value) may have moved: retryable "check-first" by default
  | "PAYMENT_COMMITTED"
  | "PAYMENT_ALREADY_SETTLED"
  | "CLAIM_OUTCOME_UNKNOWN"
  | "DEDUP_ENTRY_UNREADABLE"
  | "L402_HOLD_UNREADABLE"
  | "CONCURRENT_PAYMENT_ATTEMPT"
  | "TRANSFER_ID_CONFLICT"
  | "LIGHTNING_PAYMENT_FAILED"
  | "PREIMAGE_MISMATCH"
  // Environment and services
  | "AGENT_CLOSED"
  | "SPARK_UNAVAILABLE"
  | "SPARK_REFUSED"
  | "SERVICE_UNAVAILABLE"
  | "SERVICE_RESPONSE_INVALID"
  | "SERVICE_REDIRECTED"
  | "PRICE_UNAVAILABLE"
  | "PRIVACY_NOT_APPLIED"
  | "STORAGE_ERROR"
  | "BAD_CONFIG"
  | "POLICY_NOT_LOADED"
  | "NO_SEED"
  | "NO_PASSPHRASE"
  | "BAD_PASSPHRASE"
  | "SEED_FILE_INVALID"
  | "SDK_UNSUPPORTED"
  | "EEXIST"
  // The recovery backup (mostly reported through vaultHealth(), not thrown)
  | "LEAF_VAULT_FATAL"
  | "LEAF_VAULT_ANCHORLESS"
  | "LEAF_VAULT_PATH_CONFLICT"
  | "LEAF_VAULT_CORRUPT"
  | "LEAF_VAULT_INCOMPLETE"
  | "LEAF_VAULT_STALE";

/**
 * An error this package raised: its own class (Error, TypeError, an SDK error
 * annotated in place, PaymentCommittedError, …) plus the contract fields.
 * Decide on `retryable`, act on `nextStep`; the message is for people.
 */
export interface AgentError<C extends AgentErrorCode = AgentErrorCode> extends Error {
  code: C;
  retryable: Retryable;
  /** One sentence saying what to do next, with method names. */
  nextStep: string;
  /** BAD_INPUT and other input refusals: the argument or option at fault. */
  field?: string;
  /** STORAGE_ERROR, DEDUP_ENTRY_UNREADABLE, CONCURRENT_PAYMENT_ATTEMPT: the OS error code (EACCES, EEXIST, …); the OS error itself is `cause`. */
  osCode?: string;
  /** The Lightning send this is about: check it with agent.getLightningSendRequest(sendId). */
  sendId?: string;
  /** The invoice's payment hash (hex). */
  invoiceHash?: string;
  /** PAYMENT_ALREADY_SETTLED: the payment's transfer id (the recorded dedup id); find it in agent.getTransfers() by `id`. */
  transferId?: string;
  /** PAYMENT_COMMITTED: why (PaymentCommittedError lists the values). */
  reason?: string;
  /** LIGHTNING_PAYMENT_FAILED: the send's final status. SERVICE_RESPONSE_INVALID, and PAYMENT_COMMITTED with reason L402_PASS_REFUSED: the HTTP status. */
  status?: string | number;
  /** LIGHTNING_PAYMENT_FAILED: true only when the sats are back (USER_SWAP_RETURNED, the one retryable "yes" case). */
  fundsReturned?: boolean;
  /** L402_TOO_MANY_HELD: the unresolved purchases, by method, host and path only. */
  held?: Array<{ method: string; host: string; path: string }>;
  /** INVOICE_REFUSED: each refused invoice and why. */
  invalidInvoices?: Array<{ invoice: string; reason: string }>;
  /** SPEND_BUDGET_EXCEEDED: the budget decision that refused the spend. */
  check?: SpendBudgetCheck;
  /** LEAF_VAULT_ANCHORLESS: the leaves the exit tool can't fee-bump. */
  anchorless?: string[];
  /** PRICE_UNAVAILABLE: the sources that failed. PAYMENT_COMMITTED from fulfillInvoice: the invoices whose outcome is unknown. */
  failed?: Array<{ name: string; error: string }> | Array<{ invoice: string | undefined; reason: string }>;
}

/** A registry entry: the code's default `retryable` and `nextStep`. */
export interface AgentErrorDefaults {
  readonly retryable: Retryable;
  readonly nextStep: string;
  /** The less safe values a call site may set for this code (an exception the registry names). */
  readonly lowerAllowed?: readonly Retryable[];
}

/** The registry: every code, with its default retryable and nextStep. Agents read err.retryable, not this table. */
export const AGENT_ERRORS: Readonly<Record<AgentErrorCode, AgentErrorDefaults>>;

/** The three values of `retryable`, least safe first. */
export const RETRYABLE_VALUES: readonly Retryable[];

/** What SparkAgent.status() can report in `problems`, most severe first. These are not errors: nothing throws them. */
export type StatusProblemCode =
  // Blocking: status().usable is false
  | "AGENT_CLOSED"
  | "SPARK_UNREACHABLE"
  | "NETWORK_MISMATCH"
  // Degraded: the agent works, with this caveat
  | "LIMITS_UNREADABLE"
  | "SPEND_LEDGER_MISSING"
  | "SPEND_LEDGER_BAD_SIGNATURE"
  | "SPEND_LEDGER_UNREADABLE"
  | "L402_HELD"
  | "SPARK_STREAM_DOWN"
  | "BALANCE_LOCKED"
  | "INCOMING_UNCLAIMED"
  | "LIGHTNING_UNREACHABLE"
  | "BACKUP_BROKEN"
  | "BACKUP_STALE"
  | "PRIVACY_OFF"
  | "PRIVACY_UNKNOWN"
  | "BUDGET_EXHAUSTED";

/** Each status() problem: whether it makes the agent unusable, and the nextStep status() gives for it. Key order is severity. */
export const STATUS_PROBLEMS: Readonly<Record<StatusProblemCode, Readonly<{ blocking: boolean; nextStep: string }>>>;

export interface AnnotateErrorOptions {
  /** A SAFER value than the registry's default and the error's own retryable (yes → no → check-first), or a lower one the entry allows. An unrecognised value is check-first. */
  retryable?: Retryable;
  /** A more specific sentence than the registry's. */
  nextStep?: string;
  /** Any other key except `code` is a fact set on the error (field, osCode, sendId, invoiceHash, …). */
  [fact: string]: unknown;
}

/**
 * Add the contract fields to an error, of any class, in place, and return it:
 * `throw annotateError(new Error("…"), "BAD_INPUT", { field: "amount" })`.
 * Class, message, stack and cause stay as they are. Something that isn't an
 * extensible object (a thrown string, a frozen error) comes back wrapped in a
 * new Error with it as `cause`. A relabelled error never becomes less safe
 * than the retryable it already carries. Under test an unregistered code, or
 * a less safe retryable, throws.
 */
export function annotateError<E extends Error>(err: E, code: AgentErrorCode, options?: AnnotateErrorOptions): E & AgentError;
export function annotateError(err: unknown, code: AgentErrorCode, options?: AnnotateErrorOptions): Error & AgentError;

/**
 * Money has left, or may have. SparkAgent's money-moving methods throw it when
 * an SDK error doesn't prove nothing was sent (transfer, payLightningInvoice,
 * fulfillInvoice, withdraw, the token sends), and fetchL402 throws it when it
 * paid but the resource did not arrive (`settled: true`, the pass held in
 * memory for the next call to the same URL) or the payment is still open
 * (`settled: null`). Never pay again with a new invoice, address or method;
 * check agent.getTransfers() first (token sends: agent.getTokenTransactions()).
 * Always retryable "check-first"; `nextStep` says what to check for this case.
 * A fetchL402 error may carry `reason`: L402_PASS_REFUSED, L402_PASS_EXPIRED,
 * L402_INVOICE_EXPIRED or L402_NO_PROOF, after which that agent won't buy the
 * URL again on its own. Never a preimage on it; `cause` is the SDK's own
 * error, whose message can quote the invoice.
 */
export class PaymentCommittedError extends Error implements AgentError<"PAYMENT_COMMITTED"> {
  constructor(
    message: string,
    options?: { settled?: true | null; op?: string; invoiceHash?: string; sendId?: string; cause?: unknown; nextStep?: string },
  );
  code: "PAYMENT_COMMITTED";
  retryable: "check-first";
  nextStep: string;
  settled: true | null;
  op?: string;
  invoiceHash?: string;
  sendId?: string;
  /**
   * fetchL402 and withdraw: true, for callers of the earlier shape.
   * fulfillInvoice: the invoices of the batch that did go through.
   */
  paid?: true | Array<{ invoice: string; id: string | undefined }>;
  /** fulfillInvoice: the invoices whose outcome is unknown, and why. */
  failed?: Array<{ invoice: string | undefined; reason: string }>;
  /**
   * fetchL402: why this agent stopped buying the URL (forgetL402 lifts it).
   * payLightningInvoice: INVOICE_EXPIRED_AFTER_ATTEMPT when it refused an expired invoice
   * that an earlier attempt, on record in the dedup store, may already have paid;
   * EARLIER_ATTEMPT_OPEN when the operators refused this attempt because an earlier
   * payment of the same invoice is still open (nothing new was sent).
   */
  reason?:
    | "L402_PASS_REFUSED"
    | "L402_PASS_EXPIRED"
    | "L402_INVOICE_EXPIRED"
    | "L402_NO_PROOF"
    | "INVOICE_EXPIRED_AFTER_ATTEMPT"
    | "EARLIER_ATTEMPT_OPEN";
  /** fetchL402 with reason L402_PASS_REFUSED: the HTTP status that refused the pass. */
  status?: number;
  /** fetchL402, a stopped purchase: the price it paid, in sats. */
  amountSats?: number;
  /** fetchL402, paid but no preimage yet: the service's token (not a working pass without the preimage). */
  macaroon?: string;
}
/** True only when a failed SDK call proves no funds left (an allowlisted pre-send SparkValidationError). */
export function provesNothingSent(err: unknown): boolean;
export const PRE_SEND_VALIDATION_MESSAGES: readonly string[];
