// Type declarations for sparkbtcbot-skill/agent (spark-agent.js).
//
// Every member says what it can do to money and what it throws:
//   @sideEffect read     moves no value (it may still call Spark or a service)
//   @sideEffect receive  can bring value in or create a way to receive it
//   @sideEffect spend    can send value out
//   @dryRun read         with { dryRun: true } it is a read: a preview, nothing sent
//   @throws {T} CODE     each `err.code` it can throw (AgentError, lib/index.d.ts);
//                        `@throws none` when it throws nothing of its own
// Decide on err.retryable ("yes" | "no" | "check-first") and act on
// err.nextStep; never retry a "check-first" error before looking.
//
// tests/unit/agent-types-parity.test.js holds this file to the code: the
// members, the tags, the option keys and the codes each method raises. Its
// format rules: one `export declare class SparkAgent {` block closed by `}` in
// column 0, members indented two spaces, each member's first signature right
// under its /** */ block, and option bags named <Method>Options.

import type { SparkWallet, FulfillSparkInvoiceResponse, DecodedSparkAddressData } from "@buildonspark/spark-sdk";
import type {
  WalletTransfer,
  LightningSendRequest,
  CoopExitFeeQuote,
  CoopExitRequest,
  ClaimStaticDepositOutput,
} from "@buildonspark/spark-sdk/types";
import type {
  AgentError,
  PaymentCommittedError,
  SparkNetworkName,
  SpendLedgerEntry,
  SeedPolicy,
  SpendingLimits,
  StatusProblemCode,
} from "../../../lib/index.js";

export type {
  AgentError,
  AgentErrorCode,
  Retryable,
  StatusProblemCode,
  PaymentCommittedError,
} from "../../../lib/index.js";

// --- Shared shapes ---

/** A seed-bound policy context (tests and callers that don't open the wallet from the environment). */
export interface SeedContext {
  policy: SeedPolicy;
  ledgerHmacKey: Buffer;
}

/**
 * Sats as decimal strings. `incomingSats` > 0 (or `lockedSats` right after
 * boot) is a payment that has ARRIVED and is being claimed: never report it as
 * "nothing arrived".
 */
export interface SatsFigures {
  /** Spendable now. */
  sats: string;
  /** Sent to this wallet, arrived, not claimed yet. */
  incomingSats: string;
  /** Owned but not spendable right now: a send or swap in flight, or a payment being claimed. */
  lockedSats: string;
}

export interface SparkAgentBalance extends SatsFigures {
  /** Keyed by bech32m token identifier; `balance` is the owned balance in base units. */
  tokens: Record<string, { balance: string; name: string; ticker: string; decimals: number }>;
}

export interface PendingDeposit {
  address: string;
  txid: string;
  vout: number;
  /** claimDeposit claims "static" ones; it refuses "single-use" ones (the operators do). */
  type: "static" | "single-use";
}

export interface ReadableTokenTransaction {
  hash: string;
  /** pending: may still go through, so don't send again; cancelled: nothing moved. */
  status: "pending" | "finalized" | "cancelled" | "unknown";
  statusCode: string;
  type: "transfer" | "mint" | "create" | "unknown";
  /** The sending client's clock (ISO), not an ordering. */
  createdAt: string | null;
  outputs: Array<{
    to: string | null;
    ownerPublicKey: string | null;
    mine: boolean;
    tokenIdentifier: string | null;
    /** Base units, as a decimal string. */
    amount: string;
  }>;
}

export interface TrackedInvoice {
  /** Keep it: getInvoiceStatus(id) says whether the invoice was paid. */
  id: string;
  invoice: string;
  paymentHash: string;
  /** The SSP's timestamp, e.g. "2026-10-28T15:18:13.410592+00:00". */
  expiresAt: string;
}

export type InvoiceState = "unpaid" | "in_progress" | "received" | "paid" | "failed" | "failed_after_payment" | "unknown";

export interface InvoiceStatus {
  id: string;
  state: InvoiceState;
  paid: boolean;
  customerCharged: boolean | null;
  expired: boolean | null;
  /** True only once a new invoice can't charge the customer twice. */
  canReinvoice: boolean;
  /** The SSP's own status word. */
  status: string;
  paymentHash: string | null;
  amountSats: number | null;
  expiresAt: string | null;
}

export type SpendStatus =
  | { disabled: true }
  | { spentSats: number; budgetSats: number | null; remainingSats: number | null; windowMs: number; entries: SpendLedgerEntry[] };

export type VaultHealth =
  | { disabled: true }
  | {
      healthy: boolean;
      lastSuccessAt: number | null;
      consecutiveFailures: number;
      consecutiveTransientSkips: number;
      lastError: string | null;
      /** Leaves the exit tool can't fee-bump; non-empty makes the backup unhealthy. */
      anchorless: string[];
      /** The snapshot timer's period. */
      intervalMs: number;
      /** Failures in a row before the backup counts as broken. */
      maxConsecutiveFailures: number;
    };

/** What status() returns. `problems` are most severe first; `nextStep` is the first one's, or null. */
export interface SparkAgentStatus {
  schema: "sparkbtcbot.status.v1";
  /** False only for a blocking problem: AGENT_CLOSED, SPARK_UNREACHABLE or NETWORK_MISMATCH. */
  usable: boolean;
  problems: StatusProblemCode[];
  nextStep: string | null;
  /** ISO time of this check. */
  checkedAt: string;
  network: SparkNetworkName | null;
  address: string | null;
  /** null when Spark didn't answer the balance read (SPARK_UNREACHABLE). */
  balance: SatsFigures | null;
  privacy: { state: "on" | "off" | "off-by-choice" | "unknown"; checkedAt: string | null };
  backup: { state: "ok" | "starting" | "stale" | "broken" | "off"; ageMinutes: number | null; lastError: string | null };
  budget: {
    state: "none" | "ok" | "exhausted" | "broken";
    /** The budget is sealed in the encrypted seed. */
    sealed: boolean;
    budgetSats: number | null;
    spentSats: number | null;
    remainingSats: number | null;
    windowHours: number | null;
    /** ISO time the oldest spend in the window leaves it. */
    nextReleaseAt: string | null;
  };
  /** The user's spending limits (`sparkbtcbot limits`); "unreadable" refuses every send (LIMITS_UNREADABLE). */
  limits: ({ state: "set" } & SpendingLimits) | { state: "none" | "unreadable" };
  connections: {
    spark: "connected" | "connecting" | "disconnected" | "closed" | "unknown";
    lightning: "reachable" | "unreachable" | "unchecked";
  };
}

// --- Option bags (keys: exactly what the code accepts) ---

export interface SparkAgentOptions {
  seedContext?: SeedContext | null;
}
export interface CreateOptions {
  /** Background leaf optimization; false for a one-shot script that calls cleanup() right after moving value. */
  optimizeLeaves?: boolean;
}
export interface ListPendingDepositsOptions {
  limit?: number;
}
export interface TransferOptions {
  to: string;
  amount: number | bigint;
  dryRun?: boolean;
}
export interface GetTokenTransactionsOptions {
  tokenIdentifier?: string;
  /** 1 to 100; default 20. */
  limit?: number;
}
export interface CreateLightningInvoiceOptions {
  expirySeconds?: number;
  includeSparkAddress?: boolean;
}
export interface CreateTrackedInvoiceOptions {
  expirySeconds?: number;
}
export interface PayLightningInvoiceOptions {
  maxFeeSats?: number;
  /** Only for an amountless invoice: the amount agreed with the payee. */
  amountSats?: number | bigint;
  /** The most the user agreed to pay (default 10,000): never raise it to fit an invoice. */
  maxAmountSats?: number;
  transferId?: string;
  preferSpark?: boolean;
  /** The checkout's payment hash: pays over Lightning, and only this invoice. */
  expectedPaymentHash?: string | null;
  dryRun?: boolean;
}
export interface PayAndSettleOptions extends PayLightningInvoiceOptions {
  pollMs?: number;
  maxPolls?: number;
}
export interface FulfillInvoiceOptions {
  dryRun?: boolean;
}
export interface FulfillInvoiceEntry {
  invoice: string;
  /** Only for an amountless invoice: sats, or token base units. */
  amount?: number | bigint;
}
export interface TransferTokensOptions {
  tokenIdentifier: string;
  /** Base units. */
  amount: number | bigint;
  to: string;
  dryRun?: boolean;
}
export interface BatchTransferTokensOptions {
  dryRun?: boolean;
}
/** One output of batchTransferTokens: tokenAmount or amount, receiverSparkAddress or to. */
export interface BatchTokenEntry {
  tokenIdentifier: string;
  tokenAmount?: number | bigint;
  amount?: number | bigint;
  receiverSparkAddress?: string;
  to?: string;
}
export interface ClaimDepositOptions {
  txid: string;
  vout?: number;
  maxFeeSats?: number;
  /** Default 10 (% of the quoted credit, at most 25,000 sats). */
  maxFeePct?: number;
  dryRun?: boolean;
}
export interface WithdrawOptions {
  /** An L1 Bitcoin address. */
  to: string;
  amount: number | bigint;
  speed?: "FAST" | "MEDIUM" | "SLOW";
  maxFeeSats?: number;
  /** Default 10 (% of the amount). */
  maxFeePct?: number;
  dryRun?: boolean;
}
export interface FetchL402Options {
  method?: string;
  headers?: Record<string, string>;
  /** Sent as JSON. */
  body?: unknown;
  maxFeeSats?: number;
  /** The price the user approved (default 10,000): never raise it to fit a challenge. */
  maxAmountSats?: number;
  /** POST/PATCH only: send the request again with the pass already paid for (no new payment). */
  resend?: boolean;
}
export interface ForgetL402Options {
  method?: string;
}
export interface StatusOptions {
  /** Also ask the SSP (5 s deadline): connections.lightning, LIGHTNING_UNREACHABLE. */
  checkLightning?: boolean;
}

// --- Results ---

export interface TransferPreview {
  dryRun: true;
  operation: "spark_transfer";
  from: string;
  to: string;
  amount: string;
  unit: "sats";
  estimatedFee: "0";
  network: SparkNetworkName;
}
export interface LightningPayPreview {
  dryRun: true;
  operation: "lightning_pay";
  from: string;
  invoice: string;
  amount: string;
  unit: "sats";
  estimatedFee: string;
  maxFeeSats: string;
  maxAmountSats: string;
  /** false: the live call would refuse (capReason says why). */
  withinCap: boolean;
  capReason: string;
  network: "lightning";
  preferSpark: boolean;
}
export type LightningPayResult = (LightningSendRequest | WalletTransfer) & {
  /** With the dedup store on: true means the original payment's result, replayed; nothing new left. */
  dedupReused?: boolean;
  feeSats: number;
  /** Set when feeSats is the fee cap standing in for a fee nobody has reported. */
  feeNote?: string;
};
export type SettleResult =
  | (WalletTransfer & {
      dedupReused?: boolean;
      paymentPreimage: null;
      settled: true;
      sparkDirect: true;
      lastStatus: string | null;
      feeSats: 0;
    })
  | (LightningSendRequest & {
      dedupReused?: boolean;
      paymentPreimage: string | null;
      /** false after the polls ran out: NOT a failure; check getLightningSendRequest(result.id) before anything else. */
      settled: boolean;
      lastStatus: string | null;
      feeSats?: number;
      feeNote?: string;
    });
export interface FulfillPreview {
  dryRun: true;
  operation: "fulfill_spark_invoice";
  from: string;
  entries: Array<{ invoice: string; to: string; amount: string; type: "sats" | "tokens" }>;
  network: SparkNetworkName;
}
export interface TokenTransferPreview {
  dryRun: true;
  operation: "token_transfer";
  from: string;
  to: string;
  tokenIdentifier: string;
  amount: string;
  unit: "tokens";
  estimatedFee: "0";
  network: SparkNetworkName;
}
export interface BatchTokenTransferPreview {
  dryRun: true;
  operation: "token_transfer";
  from: string;
  entries: Array<{ to: string; tokenIdentifier: string; amount: string }>;
  totals: Array<{ tokenIdentifier: string; amount: string }>;
  unit: "tokens";
  estimatedFee: "0";
  network: SparkNetworkName;
}
export interface ClaimPreview {
  dryRun: true;
  operation: "claim_deposit";
  txid: string;
  vout: number;
  creditSats: string;
  maxFeeSats: string;
  network: SparkNetworkName;
}
export interface WithdrawPreview {
  dryRun: true;
  operation: "l1_withdraw";
  from: string;
  to: string;
  amount: string;
  unit: "sats";
  estimatedFee: string;
  maxFeeSats: string | null;
  withinCap: boolean;
  capReason: string;
  speed: "FAST" | "MEDIUM" | "SLOW";
  network: "bitcoin";
  quote: CoopExitFeeQuote | null;
}
/**
 * `macaroon` + `preimage` are a bearer credential for the resource: don't log
 * them or put them in a reply.
 */
export type L402Result =
  | { paid: false; data: unknown }
  | {
      /** Whether THIS call made the payment: false when it presented a pass an earlier call paid for (`recovered`) or joined a call still running for the same URL (`joined`). True with `recovered` when the earlier call was refused before sending anything and this call made the purchase's only payment. */
      paid: boolean;
      recovered?: true;
      /** This call overlapped a fetchL402 for the same method + URL and shares its outcome; it paid nothing itself. */
      joined?: true;
      status: number;
      amountSats: number | null;
      macaroon: string;
      preimage: string;
      data: unknown;
    };
export type L402Preview =
  | { requiresPayment: false }
  | { requiresPayment: true; amountSats: number; invoice: string; macaroon: string | undefined; tokenExpiresAt: string | null };

export declare class SparkAgent {
  /**
   * Wrap a wallet that is already open; SparkAgent.create() is the usual way
   * in. Starts the recovery backup (a snapshot on disk, wallet listeners, a
   * timer) unless SPARK_LEAF_VAULT=off. Without create(), status() reports
   * the event stream as "unknown".
   * @sideEffect read
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} BAD_CONFIG
   * @throws {AgentError} POLICY_NOT_LOADED
   */
  constructor(wallet: SparkWallet, network: SparkNetworkName, options?: SparkAgentOptions);

  /**
   * Open the wallet and wrap it. Opening claims payments that arrived while
   * it was closed, and turns the wallet's privacy setting on unless
   * SPARK_PRIVACY=off. The returned `mnemonic` is the input echoed back: a
   * secret, never to be printed, logged or stored.
   * @sideEffect receive
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} BAD_CONFIG
   * @throws {AgentError} POLICY_NOT_LOADED
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  static create(
    mnemonic: string | Uint8Array,
    network?: SparkNetworkName,
    options?: CreateOptions,
  ): Promise<{ agent: SparkAgent; mnemonic: string | undefined }>;

  /**
   * The rolling-window spend against the tightest budget in force (seed-bound,
   * SPARK_DAILY_BUDGET_SATS, or the user's daily limit), or { disabled: true }
   * when none is set.
   * @sideEffect read
   * @throws {AgentError} LIMITS_UNREADABLE
   * @throws {AgentError} SPEND_LEDGER_MISSING
   * @throws {AgentError} SPEND_LEDGER_BAD_SIGNATURE
   * @throws {AgentError} SPEND_LEDGER_UNREADABLE
   * @throws {AgentError} STORAGE_ERROR
   */
  spendStatus(): Promise<SpendStatus>;

  /**
   * The user's spending limits as every money call reads them (fresh each
   * time, so a change applies without a restart); limits is null when none
   * are set. They change only with `sparkbtcbot limits set`, on the user's
   * own message.
   * @sideEffect read
   * @throws {AgentError} LIMITS_UNREADABLE
   */
  limits(): Promise<{ path: string; limits: SpendingLimits | null }>;

  /**
   * @sideEffect read
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  getIdentity(): Promise<{ address: string; publicKey: string }>;

  /**
   * The claimed balance, plus what has arrived and is being claimed
   * (incomingSats). An L1 deposit that isn't claimed yet shows in
   * listPendingDeposits(), not here.
   * @sideEffect read
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  getBalance(): Promise<SparkAgentBalance>;

  /**
   * The static, reusable L1 deposit address (the operators create it on the first call).
   * @sideEffect receive
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  getDepositAddress(): Promise<string>;

  /**
   * Confirmed L1 deposits not claimed yet; an empty array means nothing to claim.
   * @sideEffect read
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  listPendingDeposits(options?: ListPendingDepositsOptions): Promise<PendingDeposit[]>;

  /**
   * Always refuses: the operators currently refuse to claim single-use
   * deposits. Use getDepositAddress().
   * @sideEffect receive
   * @throws {AgentError} SINGLE_USE_DEPOSITS_UNAVAILABLE
   */
  getSingleUseDepositAddress(): Promise<never>;

  /**
   * A Spark-to-Spark transfer (free). The allowlist and the budget apply;
   * the allowlist applies to a dry run too.
   * @sideEffect spend
   * @dryRun read
   * @throws {AgentError} LIMIT_DENIED
   * @throws {AgentError} LIMITS_UNREADABLE
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} RECIPIENT_INVALID
   * @throws {AgentError} RECIPIENT_NOT_ALLOWED
   * @throws {AgentError} STORAGE_ERROR
   * @throws {AgentError} INSUFFICIENT_FUNDS
   * @throws {AgentError} SPEND_BUDGET_EXCEEDED
   * @throws {AgentError} SPEND_LEDGER_MISSING
   * @throws {AgentError} SPEND_LEDGER_BAD_SIGNATURE
   * @throws {AgentError} SPEND_LEDGER_UNREADABLE
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   * @throws {PaymentCommittedError} PAYMENT_COMMITTED
   */
  transfer(options: TransferOptions & { dryRun: true }): Promise<TransferPreview>;
  transfer(options: TransferOptions & { dryRun?: false }): Promise<WalletTransfer>;
  transfer(options: TransferOptions): Promise<TransferPreview | WalletTransfer>;

  /**
   * Sats transfers, newest first (tokens: getTokenTransactions). One time
   * bound or the other, not both.
   * @sideEffect read
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  getTransfers(
    limit?: number,
    offset?: number,
    createdAfter?: Date,
    createdBefore?: Date,
  ): Promise<{ transfers: WalletTransfer[]; offset: number }>;

  /**
   * This wallet's token transactions, newest first.
   * @sideEffect read
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  getTokenTransactions(options?: GetTokenTransactionsOptions): Promise<ReadableTokenTransaction[]>;

  /**
   * One token transaction by the hash a token send returned; null when the operators have none.
   * @sideEffect read
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  getTokenTransaction(hash: string): Promise<ReadableTokenTransaction | null>;

  /**
   * A BOLT11 invoice to this wallet; 0 sats makes it amountless.
   * @sideEffect receive
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  createLightningInvoice(amountSats: number | bigint, memo?: string, options?: CreateLightningInvoiceOptions): Promise<string>;

  /**
   * An invoice to check later with getInvoiceStatus(id), one per order;
   * every payer pays it over Lightning.
   * @sideEffect receive
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  createTrackedInvoice(amountSats: number | bigint, memo?: string, options?: CreateTrackedInvoiceOptions): Promise<TrackedInvoice>;

  /**
   * Where a tracked invoice stands; null when there is no such invoice.
   * @sideEffect read
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  getInvoiceStatus(id: string): Promise<InvoiceStatus | null>;

  /**
   * Pay a BOLT11 invoice under the amount and fee ceilings and the budget,
   * with one persisted dedup id per invoice. Most callers want payAndSettle.
   * @sideEffect spend
   * @dryRun read
   * @throws {AgentError} LIMIT_DENIED
   * @throws {AgentError} LIMITS_UNREADABLE
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} INVOICE_INVALID
   * @throws {AgentError} PAYMENT_HASH_MISMATCH
   * @throws {AgentError} AMOUNT_MISMATCH
   * @throws {AgentError} INVOICE_EXPIRED
   * @throws {AgentError} AMOUNT_OVER_LIMIT
   * @throws {AgentError} FEE_OVER_LIMIT
   * @throws {AgentError} INSUFFICIENT_FUNDS
   * @throws {AgentError} SPEND_BUDGET_EXCEEDED
   * @throws {AgentError} SPEND_LEDGER_MISSING
   * @throws {AgentError} SPEND_LEDGER_BAD_SIGNATURE
   * @throws {AgentError} SPEND_LEDGER_UNREADABLE
   * @throws {AgentError} STORAGE_ERROR
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   * @throws {AgentError} TRANSFER_ID_CONFLICT
   * @throws {AgentError} CONCURRENT_PAYMENT_ATTEMPT
   * @throws {AgentError} DEDUP_ENTRY_UNREADABLE
   * @throws {AgentError} PAYMENT_ALREADY_SETTLED
   * @throws {PaymentCommittedError} PAYMENT_COMMITTED
   */
  payLightningInvoice(bolt11: string, options: PayLightningInvoiceOptions & { dryRun: true }): Promise<LightningPayPreview>;
  payLightningInvoice(bolt11: string, options?: PayLightningInvoiceOptions & { dryRun?: false }): Promise<LightningPayResult>;
  payLightningInvoice(bolt11: string, options?: PayLightningInvoiceOptions): Promise<LightningPayPreview | LightningPayResult>;

  /**
   * The SSP's fee estimate for paying an invoice, in sats.
   * @sideEffect read
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  estimateLightningFee(bolt11: string, amountSats?: number | bigint): Promise<number>;

  /**
   * @sideEffect read
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  getLightningSendRequest(id: string): Promise<LightningSendRequest | null>;

  /**
   * payLightningInvoice, then wait for the preimage (the proof of payment).
   * `settled: false` after the polls run out is NOT a failure: check
   * getLightningSendRequest(result.id) before anything else.
   * @sideEffect spend
   * @dryRun read
   * @throws {AgentError} LIMIT_DENIED
   * @throws {AgentError} LIMITS_UNREADABLE
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} INVOICE_INVALID
   * @throws {AgentError} PAYMENT_HASH_MISMATCH
   * @throws {AgentError} AMOUNT_MISMATCH
   * @throws {AgentError} INVOICE_EXPIRED
   * @throws {AgentError} AMOUNT_OVER_LIMIT
   * @throws {AgentError} FEE_OVER_LIMIT
   * @throws {AgentError} INSUFFICIENT_FUNDS
   * @throws {AgentError} SPEND_BUDGET_EXCEEDED
   * @throws {AgentError} SPEND_LEDGER_MISSING
   * @throws {AgentError} SPEND_LEDGER_BAD_SIGNATURE
   * @throws {AgentError} SPEND_LEDGER_UNREADABLE
   * @throws {AgentError} STORAGE_ERROR
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   * @throws {AgentError} TRANSFER_ID_CONFLICT
   * @throws {AgentError} CONCURRENT_PAYMENT_ATTEMPT
   * @throws {AgentError} DEDUP_ENTRY_UNREADABLE
   * @throws {AgentError} PAYMENT_ALREADY_SETTLED
   * @throws {AgentError} LIGHTNING_PAYMENT_FAILED
   * @throws {AgentError} PREIMAGE_MISMATCH
   * @throws {PaymentCommittedError} PAYMENT_COMMITTED
   */
  payAndSettle(bolt11: string, options: PayAndSettleOptions & { dryRun: true }): Promise<LightningPayPreview>;
  payAndSettle(bolt11: string, options?: PayAndSettleOptions & { dryRun?: false }): Promise<SettleResult>;
  payAndSettle(bolt11: string, options?: PayAndSettleOptions): Promise<LightningPayPreview | SettleResult>;

  /**
   * A native Spark invoice for sats; omit amountSats for an amountless one.
   * @sideEffect receive
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  createSatsInvoice(amountSats?: number | bigint, memo?: string): Promise<string>;

  /**
   * A native Spark invoice for tokens (amount in base units).
   * @sideEffect receive
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  createTokenInvoice(tokenIdentifier: string, amount?: bigint, memo?: string): Promise<string>;

  /**
   * Pay Spark invoices (sats or tokens). The allowlist applies to each
   * invoice's receiver, in a dry run too; the budget counts the sats ones.
   * @sideEffect spend
   * @dryRun read
   * @throws {AgentError} LIMIT_DENIED
   * @throws {AgentError} LIMITS_UNREADABLE
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} INVOICE_INVALID
   * @throws {AgentError} AMOUNT_MISMATCH
   * @throws {AgentError} RECIPIENT_NOT_ALLOWED
   * @throws {AgentError} STORAGE_ERROR
   * @throws {AgentError} INSUFFICIENT_FUNDS
   * @throws {AgentError} INVOICE_REFUSED
   * @throws {AgentError} SPEND_BUDGET_EXCEEDED
   * @throws {AgentError} SPEND_LEDGER_MISSING
   * @throws {AgentError} SPEND_LEDGER_BAD_SIGNATURE
   * @throws {AgentError} SPEND_LEDGER_UNREADABLE
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   * @throws {PaymentCommittedError} PAYMENT_COMMITTED
   */
  fulfillInvoice(invoices: FulfillInvoiceEntry[], options: FulfillInvoiceOptions & { dryRun: true }): Promise<FulfillPreview>;
  fulfillInvoice(invoices: FulfillInvoiceEntry[], options?: FulfillInvoiceOptions & { dryRun?: false }): Promise<FulfillSparkInvoiceResponse>;
  fulfillInvoice(invoices: FulfillInvoiceEntry[], options?: FulfillInvoiceOptions): Promise<FulfillPreview | FulfillSparkInvoiceResponse>;

  /**
   * Send tokens. The allowlist applies; the sats budget doesn't count tokens.
   * Returns the transaction hash.
   * @sideEffect spend
   * @dryRun read
   * @throws {AgentError} LIMIT_DENIED
   * @throws {AgentError} LIMITS_UNREADABLE
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} RECIPIENT_INVALID
   * @throws {AgentError} RECIPIENT_NOT_ALLOWED
   * @throws {AgentError} STORAGE_ERROR
   * @throws {AgentError} INSUFFICIENT_FUNDS
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   * @throws {PaymentCommittedError} PAYMENT_COMMITTED
   */
  transferTokens(options: TransferTokensOptions & { dryRun: true }): Promise<TokenTransferPreview>;
  transferTokens(options: TransferTokensOptions & { dryRun?: false }): Promise<string>;
  transferTokens(options: TransferTokensOptions): Promise<TokenTransferPreview | string>;

  /**
   * Several token outputs in one transaction; one disallowed recipient blocks
   * the batch. Returns the transaction hash.
   * @sideEffect spend
   * @dryRun read
   * @throws {AgentError} LIMIT_DENIED
   * @throws {AgentError} LIMITS_UNREADABLE
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} RECIPIENT_INVALID
   * @throws {AgentError} RECIPIENT_NOT_ALLOWED
   * @throws {AgentError} STORAGE_ERROR
   * @throws {AgentError} INSUFFICIENT_FUNDS
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   * @throws {PaymentCommittedError} PAYMENT_COMMITTED
   */
  batchTransferTokens(transfers: BatchTokenEntry[], options: BatchTransferTokensOptions & { dryRun: true }): Promise<BatchTokenTransferPreview>;
  batchTransferTokens(transfers: BatchTokenEntry[], options?: BatchTransferTokensOptions & { dryRun?: false }): Promise<string>;
  batchTransferTokens(transfers: BatchTokenEntry[], options?: BatchTransferTokensOptions): Promise<BatchTokenTransferPreview | string>;

  /**
   * Claim a confirmed deposit at this wallet's static address. The SSP's fee
   * comes out of the deposit, under a size-aware ceiling.
   * @sideEffect receive
   * @dryRun read
   * @throws {AgentError} LIMIT_DENIED
   * @throws {AgentError} LIMITS_UNREADABLE
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} DEPOSIT_NOT_FOUND
   * @throws {AgentError} DEPOSIT_LOOKUP_INCOMPLETE
   * @throws {AgentError} SINGLE_USE_DEPOSITS_UNAVAILABLE
   * @throws {AgentError} QUOTE_UNREADABLE
   * @throws {AgentError} FEE_OVER_LIMIT
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   * @throws {AgentError} CLAIM_OUTCOME_UNKNOWN
   */
  claimDeposit(options: ClaimDepositOptions & { dryRun: true }): Promise<ClaimPreview>;
  claimDeposit(options: ClaimDepositOptions & { dryRun?: false }): Promise<ClaimStaticDepositOutput | null>;
  claimDeposit(options: ClaimDepositOptions): Promise<ClaimPreview | ClaimStaticDepositOutput | null>;

  /**
   * The SSP's quote for a cooperative exit. Moves no value out, though the
   * SDK may restructure leaves to price it: a connection lost mid-call
   * (SPARK_UNAVAILABLE) and a refusal or failed swap (SPARK_REFUSED) are
   * retryable "check-first" (a leaf swap with the SSP may be in flight), not
   * "yes" or "no". Only the SDK's pre-send refusals (INSUFFICIENT_FUNDS,
   * BAD_INPUT) keep theirs. withdraw's quote fetch, dry run included, is the
   * same.
   * @sideEffect read
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} INSUFFICIENT_FUNDS
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  getWithdrawalFeeQuote(amountSats: number | bigint, onchainAddress: string): Promise<CoopExitFeeQuote | null>;

  /**
   * A cooperative exit to an L1 address, bound to the quote it vetted. The
   * allowlist and the budget (amount + fee) apply.
   * @sideEffect spend
   * @dryRun read
   * @throws {AgentError} LIMIT_DENIED
   * @throws {AgentError} LIMITS_UNREADABLE
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} RECIPIENT_INVALID
   * @throws {AgentError} RECIPIENT_NOT_ALLOWED
   * @throws {AgentError} STORAGE_ERROR
   * @throws {AgentError} INSUFFICIENT_FUNDS
   * @throws {AgentError} FEE_OVER_LIMIT
   * @throws {AgentError} QUOTE_UNREADABLE
   * @throws {AgentError} SPEND_BUDGET_EXCEEDED
   * @throws {AgentError} SPEND_LEDGER_MISSING
   * @throws {AgentError} SPEND_LEDGER_BAD_SIGNATURE
   * @throws {AgentError} SPEND_LEDGER_UNREADABLE
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   * @throws {PaymentCommittedError} PAYMENT_COMMITTED
   */
  withdraw(options: WithdrawOptions & { dryRun: true }): Promise<WithdrawPreview>;
  withdraw(options: WithdrawOptions & { dryRun?: false }): Promise<CoopExitRequest>;
  withdraw(options: WithdrawOptions): Promise<WithdrawPreview | CoopExitRequest>;

  /**
   * Sign with this wallet's identity key (hex DER). No money moves, but a
   * signature can authorize something elsewhere.
   * @sideEffect read
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  signMessage(text: string): Promise<string>;

  /**
   * Whether `signature` over `text` is this wallet's own.
   * @sideEffect read
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  verifyOwnSignature(text: string, signature: string | Uint8Array): Promise<boolean>;

  /**
   * Fetch a resource behind an L402 paywall, paying its challenge under the
   * price and fee ceilings and the budget. A purchase that paid but didn't
   * deliver is held in this process, and the next call for the same URL and
   * method finishes it instead of buying again. So is one whose payment failed
   * while its sats may still be locked (LIGHTNING_PAYMENT_FAILED, check-first):
   * the next call buys again only once that send reads USER_SWAP_RETURNED. A
   * call that overlaps one still running for the same method + URL joins it
   * (`joined: true`, `paid: false`); with a different body it is refused with
   * CONCURRENT_PAYMENT_ATTEMPT before anything is fetched or paid. No
   * dry run: previewL402(url) shows the price.
   * @sideEffect spend
   * @throws {AgentError} LIMIT_DENIED
   * @throws {AgentError} LIMITS_UNREADABLE
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} SERVICE_UNAVAILABLE
   * @throws {AgentError} SERVICE_RESPONSE_INVALID
   * @throws {AgentError} L402_CHALLENGE_INVALID
   * @throws {AgentError} L402_TOKEN_EXPIRED
   * @throws {AgentError} L402_TOO_MANY_HELD
   * @throws {AgentError} INVOICE_INVALID
   * @throws {AgentError} INVOICE_EXPIRED
   * @throws {AgentError} AMOUNT_OVER_LIMIT
   * @throws {AgentError} FEE_OVER_LIMIT
   * @throws {AgentError} INSUFFICIENT_FUNDS
   * @throws {AgentError} SPEND_BUDGET_EXCEEDED
   * @throws {AgentError} SPEND_LEDGER_MISSING
   * @throws {AgentError} SPEND_LEDGER_BAD_SIGNATURE
   * @throws {AgentError} SPEND_LEDGER_UNREADABLE
   * @throws {AgentError} STORAGE_ERROR
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   * @throws {AgentError} CONCURRENT_PAYMENT_ATTEMPT
   * @throws {AgentError} DEDUP_ENTRY_UNREADABLE
   * @throws {AgentError} LIGHTNING_PAYMENT_FAILED
   * @throws {PaymentCommittedError} PAYMENT_COMMITTED
   */
  fetchL402(url: string, options?: FetchL402Options): Promise<L402Result>;

  /**
   * Lift this agent's hold on a URL (a paid pass not yet delivered, a payment
   * in doubt, a refused pass, a failed payment whose send never read
   * USER_SWAP_RETURNED), so the next fetchL402 for it may buy again: a
   * second purchase if the earlier payment went through. Call it only on the
   * user's say-so. Returns whether anything was held.
   * @sideEffect read
   * @throws none
   */
  forgetL402(url: string, options?: ForgetL402Options): boolean;

  /**
   * The price of an L402 resource, without paying.
   * @sideEffect read
   * @throws {AgentError} BAD_INPUT
   * @throws {AgentError} SERVICE_UNAVAILABLE
   * @throws {AgentError} L402_CHALLENGE_INVALID
   */
  previewL402(url: string): Promise<L402Preview>;

  /**
   * Called for each payment the wallet claims from its live event stream.
   * Payments claimed as the wallet opens, or as its stream reconnects, don't
   * call it: after boot, check getBalance() or getTransfers().
   * @sideEffect read
   * @throws none
   */
  onTransferReceived(callback: (transferId: string, updatedBalance: bigint) => void): void;

  /**
   * @sideEffect read
   * @throws none
   */
  onDepositConfirmed(callback: (depositId: string, updatedBalance: bigint) => void): void;

  /**
   * The recovery backup's health, or { disabled: true } with SPARK_LEAF_VAULT=off.
   * @sideEffect read
   * @throws none
   */
  vaultHealth(): VaultHealth;

  /**
   * One look at whether this agent can work: call it before a task, or when
   * something seems off. It reports what it finds and never throws for it.
   * About 100 ms; no network call after cleanup().
   * @sideEffect read
   * @throws {AgentError} BAD_INPUT
   */
  status(options?: StatusOptions): Promise<SparkAgentStatus>;

  /**
   * Flush the backup if a change is unsaved, then close the wallet. Don't use
   * this agent afterwards.
   * @sideEffect read
   * @throws {AgentError} SPARK_UNAVAILABLE
   * @throws {AgentError} SPARK_REFUSED
   */
  cleanup(): Promise<void>;
}

/**
 * Whether a Lightning send status means the payee was not paid (the payment
 * is over). Whether the sats are back is another question: only
 * USER_SWAP_RETURNED says so.
 * @sideEffect read
 * @throws none
 */
export declare function isTerminalLightningFailure(status: unknown): boolean;

/**
 * Read an L402 challenge: the WWW-Authenticate header first, then the JSON
 * body (which it consumes).
 * @sideEffect read
 * @throws none
 */
export declare function parseL402Challenge(response: {
  headers: { get(name: string): string | null };
  json(): Promise<any>;
}): Promise<{ invoice: string | undefined; macaroon: string | undefined }>;

/**
 * Who a Spark invoice pays, decoded from the invoice itself.
 * @sideEffect read
 * @throws {AgentError} INVOICE_INVALID
 */
export declare function sparkInvoiceReceiver(
  invoice: string,
  network: SparkNetworkName,
): {
  identityPublicKey: string;
  address: string;
  invoiceFields: DecodedSparkAddressData["sparkInvoiceFields"];
};
