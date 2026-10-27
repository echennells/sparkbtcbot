// No `import "dotenv/config"` here: this module is the package's
// `sparkbtcbot-skill/agent` export, and importing a library must not load the
// host app's ./.env (a planted one could switch off dedup, the backup or
// privacy, or TLS checks for fetch). The runnable demo below loads it.
import { pathToFileURL } from "node:url";
import {
  SparkWallet,
  UUID,
  decodeBech32mTokenIdentifier,
  decodeSparkAddress,
  encodeBech32mTokenIdentifier,
  encodeSparkAddress,
  generateTransferId,
  getNetworkFromSparkAddress,
} from "@buildonspark/spark-sdk";
import { loadMnemonicFromEnv, getLoadedSeedContext, seedFileIsSealed } from "../../../lib/encrypted-seed.js";
import {
  loadRecipientsAllowlist,
  assertRecipientAllowed,
  DEFAULT_ALLOWLIST_PATH,
} from "../../../lib/recipients-allowlist.js";
import { createHash } from "node:crypto";
import { decodeInvoiceSats, invoicePaymentHash, invoicePaymentHashCount, invoiceSecondsRemaining, paymentHashMatches } from "../../../lib/bolt11.js";
import {
  lightningEstimateSats,
  lightningFeeCap,
  checkFeeAgainstCap,
  checkL402Amount,
  withdrawalTotalFee,
} from "../../../lib/fee-guards.js";
import { createSpendLedger } from "../../../lib/spend-ledger.js";
import { createTransferIdStore } from "../../../lib/transfer-ids.js";
import { ensureWalletPrivacy, privacyPreferenceFromEnv } from "../../../lib/wallet-privacy.js";
import { enableLeafVault } from "./leaf-vault.js";
import { sparkWalletOptions } from "../../../lib/wallet-options.js";
import { l402TokenExpiry } from "../../../lib/l402-token.js";
import { PaymentCommittedError, provesNothingSent } from "../../../lib/payment-outcome.js";

// Best-effort BOLT11 amount in sats (undefined for amountless invoices or on a
// decode error) — used to size the amount-aware Lightning fee cap. Delegates to
// the library decoder so the wrapper and the merchant guards can never disagree
// by a rounding sat (they used to: round here vs ceil there).
function invoiceAmountSats(bolt11) {
  return decodeInvoiceSats(bolt11) ?? undefined;
}

// A mistyped or phantom option on a money-moving call must THROW, not vanish:
// JS silently drops unknown destructured keys, so a flag that reads as a guard
// in review can be a no-op at runtime (a bot double-sent real sats by passing
// `dryRun` to the raw SDK, which has no such option). Strictness here makes
// that whole failure class loud at the wrapper layer.
function rejectUnknownOptions(method, rest) {
  const unknown = Object.keys(rest);
  if (unknown.length) {
    throw new Error(
      `SparkAgent.${method}: unknown option(s) [${unknown.join(", ")}] — refusing a money-moving call ` +
      `with options that would be silently ignored. Check the spelling against references/agent-class.md.`,
    );
  }
}

// Same doctrine one level down: a numeric guard option that is PRESENT but
// unreadable must throw, not degrade to "no cap". `maxFeePct: "10%"` produces
// NaN — and NaN silently disables the ceiling it was meant to set (the SDK's
// `feeCharged > maxFee` is false for NaN; the fee-guards treat a non-finite
// cap as "no cap set" by design, since the lib's posture is lenient/defer).
// Strictness about values lives here in the wrapper, next to strictness about
// keys. undefined/null means "not provided" and is fine — absent is a choice,
// garbage is a bug. Returns the finite number, or undefined when absent.
function requireNumericOption(method, name, value) {
  if (value === undefined || value === null) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) {
    throw new Error(
      `SparkAgent.${method}: ${name} must be a number, got ${JSON.stringify(value)} — ` +
      `an unreadable ceiling silently disables the guard it's meant to set.`,
    );
  }
  return n;
}

// Statuses from the SDK's LightningSendRequestStatus enum that mean the PAYEE
// WAS NOT PAID, so the payment is over and a fresh attempt is safe. The
// order is CREATED → LIGHTNING_PAYMENT_INITIATED → LIGHTNING_PAYMENT_SUCCEEDED
// → PREIMAGE_PROVIDED → TRANSFER_COMPLETED. PREIMAGE_PROVIDING_FAILED and
// TRANSFER_FAILED come AFTER the Lightning payment succeeded: the payee has
// the money, so treating them as failures (as an "_FAILED" suffix match did)
// forgot the dedup id and invited a second payment (ToB review 2026-10-26).
// payAndSettle reports those two as PAYMENT_COMMITTED instead (the order in
// the enum is the evidence; the SDK and Spark's docs don't define them). An
// unknown or future status is not terminal either: waiting is the safe
// direction.
const PAYEE_UNPAID_STATUSES = new Set([
  "USER_TRANSFER_VALIDATION_FAILED", // refused before any payment
  "LIGHTNING_PAYMENT_FAILED",        // the route failed; the funds come back
  "PENDING_USER_SWAP_RETURN",
  "USER_SWAP_RETURNED",              // failed, and the funds were already returned
  "USER_SWAP_RETURN_FAILED",         // failed; returning the funds failed too
]);
const PAYEE_MAYBE_PAID_STATUSES = new Set(["PREIMAGE_PROVIDING_FAILED", "TRANSFER_FAILED"]);
export function isTerminalLightningFailure(status) {
  return typeof status === "string" && PAYEE_UNPAID_STATUSES.has(status);
}

// What a Lightning payment cost comes from status reads, never from
// payLightningInvoice's own answer: on REGTEST that answer came back
// TRANSFER_COMPLETED with the preimage and a fee of 0 msat, before the SSP had
// priced the payment (the next read said 5,000 msat, and 1,005 sats had left
// for a 1,000-sat invoice). Reads made once a payment has settled: the first
// at once, then LIGHTNING_FEE_POLL_MS apart (payAndSettle's pollMs), at most
// this many.
const LIGHTNING_FEE_READS = 5;
const LIGHTNING_FEE_POLL_MS = 2_000;

// The fee one status read shows, in whole sats: the fee the SSP reports, or
// what the send's transfer took beyond the amount when that is more (the
// wallet sends the amount plus its fee estimate). null when the read doesn't
// say yet: it shows neither, or only a fee of 0 with no transfer to check it
// against, which is what a read says before the SSP has priced the payment.
function lightningPaidFeeSats(read, amountSats) {
  const reported = wholeSats(read?.fee);
  const total = wholeSats(read?.transfer?.totalAmount);
  const taken = total !== null && total >= amountSats ? total - amountSats : null;
  if (taken === null) return reported ? reported : null;
  return Math.max(reported ?? 0, taken);
}

// A CurrencyAmount ({ originalValue, originalUnit }) or a bare number of sats
// → whole sats (rounded up), or null when the unit isn't one this can read.
function wholeSats(amount) {
  if (typeof amount === "number") return Number.isSafeInteger(amount) && amount >= 0 ? amount : null;
  const v = Number(amount?.originalValue);
  if (!Number.isFinite(v) || v < 0) return null;
  if (amount.originalUnit === "SATOSHI") return Math.ceil(v);
  if (amount.originalUnit === "MILLISATOSHI") return Math.ceil(v / 1000);
  return null;
}

// payAndSettle's private channel into payLightningInvoice (a Symbol, so no
// caller can pass it): the call fills in the amount and fee cap it paid with,
// and leaves the fee to payAndSettle, which reads it once the payment has settled.
const LN_SETTLING = Symbol("sparkagent.lightningSettling");
// fetchL402's flag to payAndSettle: skip the fee reads. Its paid pass is
// waiting to be presented, and it reports no fee.
const LN_NO_FEE_READS = Symbol("sparkagent.noFeeReads");
// fetchL402's flag when it settles a purchase an earlier call already
// attempted: that attempt counted the spend, so this one doesn't again.
const LN_RESUMING = Symbol("sparkagent.lightningResuming");

// A tracked invoice's receive status, as a state a shop can act on. The order
// of a receive, from the SSP's schema (spark repo, schemas/ssp_rc_schema.graphql)
// and the operators' preimage swap (spark/so/handler/initiate_preimage_swap_flow_handler.go):
// invoice created → HTLC received → transfer to this wallet created → preimage
// released to the SSP, atomically with that transfer → the SSP collects the
// payer's HTLC (LIGHTNING_PAYMENT_RECEIVED: the payer is charged) → this wallet
// claims the transfer (TRANSFER_COMPLETED). A failure before the preimage is
// released can't have charged the payer: without it the SSP can't collect.
// These meanings are inferred from that flow, not documented, and whether an
// early failure is final isn't known. SDK 0.14 names only some of these and
// reports the SSP's others (HTLC_RECEIVED, HTLC_FAILED, …) as FUTURE_VALUE,
// which maps to "unknown".
const RECEIVE_STATES = {
  INVOICE_CREATED: "unpaid",
  HTLC_RECEIVED: "in_progress",
  TRANSFER_CREATED: "in_progress",
  PAYMENT_PREIMAGE_PENDING: "in_progress",
  PAYMENT_PREIMAGE_RECOVERED: "in_progress",
  LIGHTNING_PAYMENT_RECEIVED: "received",
  TRANSFER_COMPLETED: "paid",
  TRANSFER_CREATION_FAILED: "failed",
  REFUND_SIGNING_COMMITMENTS_QUERYING_FAILED: "failed",
  REFUND_SIGNING_FAILED: "failed",
  PAYMENT_PREIMAGE_QUERYING_FAILED: "failed",
  PAYMENT_PREIMAGE_RECOVERING_FAILED: "failed",
  TRANSFER_CANCELED: "failed",
  HTLC_FAILED: "failed",
  TRANSFER_FAILED: "failed_after_payment",
};
// getInvoiceStatus allows a new invoice this long after the old one expired:
// a payment already in flight at expiry can still complete for a moment.
const REINVOICE_GRACE_MS = 2 * 60_000;

// A token transaction from the operators, in readable form: hex hash, a
// status (finalized; pending = started, signed or revealed, may still go
// through, so don't send again; cancelled = nothing moved), the type,
// createdAt (the sending client's clock, so not an ordering: two sends a few
// ms apart came back stamped out of order on REGTEST), and each
// output's recipient address, whether it is this wallet's, token and amount
// (base units, as a string). A send shows the recipient's output and the
// change back to this wallet.
const TOKEN_TX_STATUS = {
  0: ["TOKEN_TRANSACTION_STARTED", "pending"],
  1: ["TOKEN_TRANSACTION_SIGNED", "pending"],
  5: ["TOKEN_TRANSACTION_REVEALED", "pending"],
  2: ["TOKEN_TRANSACTION_FINALIZED", "finalized"],
  3: ["TOKEN_TRANSACTION_STARTED_CANCELLED", "cancelled"],
  4: ["TOKEN_TRANSACTION_SIGNED_CANCELLED", "cancelled"],
};
const TOKEN_TX_MAX_LIMIT = 100;
const TOKEN_TX_TYPES = { transferInput: "transfer", mintInput: "mint", createInput: "create" };

function readableTokenTransaction(t, network, me) {
  const tx = t?.tokenTransaction ?? {};
  const hex = (b) => (b instanceof Uint8Array ? Buffer.from(b).toString("hex") : "");
  const [statusCode, status] = TOKEN_TX_STATUS[t?.status] ?? [String(t?.status), "unknown"];
  return {
    hash: hex(t?.tokenTransactionHash),
    status,
    statusCode,
    type: TOKEN_TX_TYPES[tx.tokenInputs?.$case] ?? "unknown",
    createdAt: tx.clientCreatedTimestamp instanceof Date ? tx.clientCreatedTimestamp.toISOString() : null,
    outputs: (tx.tokenOutputs ?? []).map((o) => {
      const owner = hex(o.ownerPublicKey);
      let to = null;
      try {
        to = owner ? encodeSparkAddress({ identityPublicKey: owner, network }) : null;
      } catch {
        // An owner key that won't encode must not hide the rest of the list.
      }
      return {
        to,
        // Compare recipients by key, not by address string: one key has two
        // address encodings (legacy sp1… and spark1…), and `to` is the newer.
        ownerPublicKey: owner || null,
        mine: owner === me,
        tokenIdentifier: o.tokenIdentifier?.length ? encodeBech32mTokenIdentifier({ tokenIdentifier: o.tokenIdentifier, network }) : null,
        amount: o.tokenAmount?.length ? BigInt("0x" + hex(o.tokenAmount)).toString() : "0",
      };
    }),
  };
}

// payLightningInvoice refuses an invoice with less than this many seconds
// left: the SDK locks the coins before the SSP checks the expiry.
const LIGHTNING_MIN_INVOICE_SECONDS = 30;

// claimDeposit's lookup reads a deposit address's unclaimed UTXOs this many
// at a time, until it finds the deposit or runs out, and gives up after
// DEPOSIT_UTXO_MAX_PAGES pages (a server that ignored the offset kept it
// paging forever).
const DEPOSIT_UTXO_PAGE = 100;
const DEPOSIT_UTXO_MAX_PAGES = 100;

// claimDeposit's default fee ceiling: maxFeePct of the quoted credit, and
// never more than this. The SSP's spread is a few hundred sats; 10% of a
// 0.49 BTC deposit would have allowed 4.9M. High enough for a spread at a
// feerate spike; an explicit maxFeeSats goes past it.
const CLAIM_MAX_FEE_SATS = 25_000;


// Cumulative-budget guardrail (lib/spend-ledger.js): every other guard is
// per-call, so none of them stops a LOOP of individually-valid sends. Active
// only when SPARK_DAILY_BUDGET_SATS is set (rolling 24h window; ledger at
// SPARK_SPEND_LEDGER_PATH, default ~/.spark/spend-ledger.json). A malformed
// budget THROWS instead of being ignored — a budget the operator thinks is
// set but isn't would be the silently-generated-wallet bug all over again.
// The SDK validates every sats amount with Number.isSafeInteger, which returns
// FALSE for ALL BigInts — so passing BigInt(8258) throws a misleading "Sats
// amount must be less than 2^53" even for tiny values, while a plain 8258 works.
// Callers legitimately hold sats as bigint (getBalance() returns bigint), so
// normalize number|bigint to a plain safe-integer Number here and let both work
// identically on the dry-run and live paths. Real sats amounts are always
// < 2^53 (2^53 sats dwarfs the total BTC supply), so the Number cast never loses
// precision. undefined/null pass through unchanged (for optional amounts).
function toSats(value, method, field = "amount") {
  if (value === undefined || value === null) return value;
  if (typeof value === "bigint") {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`SparkAgent.${method}: ${field} ${value} is out of range (0 .. 2^53-1).`);
    }
    return Number(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  throw new Error(
    `SparkAgent.${method}: ${field} must be a non-negative integer below 2^53 (number or bigint), got ${
      typeof value === "number" ? value : typeof value
    }.`,
  );
}

// Resolve the spend ledger from (in priority order) a SEED-BOUND policy —
// carried inside the encrypted seed payload, observed by the loadMnemonicFromEnv
// call that opened the wallet — then the SPARK_DAILY_BUDGET_SATS env var. A
// seed-bound budget wins ABSOLUTELY: the env var (agent-writable via .env) must
// not be able to loosen a policy the operator sealed under the passphrase. When
// bound, the ledger is HMAC-verified against a seed-derived key, so deleting,
// truncating, or editing the ledger file fails closed instead of silently
// restoring the full budget.
function spendLedgerFromEnv(seedCtx = getLoadedSeedContext()) {
  const raw = process.env.SPARK_DAILY_BUDGET_SATS;
  if (seedCtx?.policy?.dailyBudgetSats != null) {
    if (raw != null && String(raw).trim() !== "" && Number(raw) !== seedCtx.policy.dailyBudgetSats) {
      console.warn(
        `spark-agent: SPARK_DAILY_BUDGET_SATS (${raw}) differs from the SEED-BOUND budget ` +
          `(${seedCtx.policy.dailyBudgetSats} sats) — the seed-bound value wins. Change it with ` +
          `\`npx sparkbtcbot set-policy\` (requires the passphrase), not the env var.`,
      );
    }
    return createSpendLedger({
      budgetSats: seedCtx.policy.dailyBudgetSats,
      path: process.env.SPARK_SPEND_LEDGER_PATH || undefined,
      hmacKey: seedCtx.ledgerHmacKey,
      bound: true,
    });
  }
  // FAIL CLOSED on "sealed but unbound": the seed file's version byte is
  // plaintext, so we can tell a sealed wallet without the passphrase. If the
  // seed is v2 but no policy reached us, the sealed budget would be silently
  // ignored — the exact pre-seal behavior the operator paid a ceremony to
  // escape. Causes: the wallet was opened with loadMnemonic (not *FromEnv), or
  // two copies of lib/ are loaded, or SparkAgent was constructed before the
  // seed was read. All are bugs; none may degrade quietly.
  if (seedFileIsSealed(process.env.SPARK_SEED_PATH || undefined)) {
    throw new Error(
      "SparkAgent: the encrypted seed carries a SEALED spending policy, but this process did not " +
        "receive it — refusing to run with the policy silently unenforced. Open the wallet with " +
        "loadMnemonicFromEnv() (which reads the policy) before constructing SparkAgent, and make sure " +
        "only ONE copy of lib/encrypted-seed.js is loaded (import from the npm package, don't mix it " +
        "with a copied lib/). To remove the policy deliberately, run `npx sparkbtcbot set-policy`.",
    );
  }
  if (raw == null || String(raw).trim() === "") return null;
  const budgetSats = Number(raw);
  if (!Number.isFinite(budgetSats) || budgetSats <= 0) {
    throw new Error(
      `SPARK_DAILY_BUDGET_SATS is set but is not a positive number of sats: ${JSON.stringify(raw)}. ` +
        `Fix or unset it — refusing to run with a budget that would be silently ignored.`,
    );
  }
  return createSpendLedger({ budgetSats, path: process.env.SPARK_SPEND_LEDGER_PATH || undefined });
}

// Lightning payment-dedup store (lib/transfer-ids.js): mints and PERSISTS one
// spark-sdk `transferId` per invoice, write-ahead of the first pay attempt, so
// any retry of the same invoice — after a timeout, a crash, or from a second
// process — reuses the same ID, and the SDK's cross-rail dedup (Spark fallback
// transfer, preimage swap, SSP admission; spark-sdk ≥0.10) makes a second
// payment impossible. On by default (state at ~/.spark/ln-dedup/, override
// with SPARK_LN_DEDUP_PATH); SPARK_LN_DEDUP=off restores the SDK's
// fresh-ID-per-call behavior, where a retry after an ambiguous failure is a
// double-pay gamble.
function lnDedupFromEnv() {
  const flag = String(process.env.SPARK_LN_DEDUP ?? "").trim().toLowerCase();
  if (["off", "false", "0", "no"].includes(flag)) return null;
  return createTransferIdStore({ dir: process.env.SPARK_LN_DEDUP_PATH || undefined });
}

// A native Spark invoice IS its own destination: the receiver's identity key
// is embedded in the bech32m payload, so the payee is knowable BEFORE paying.
// Returns the receiver's identity key plus the bare current-format Spark
// address for it on `network`. Throws on another network's invoice — paying
// cross-network is never what the caller meant, so fail closed.
export function sparkInvoiceReceiver(invoice, network) {
  const decoded = decodeSparkAddress(invoice, network);
  return {
    identityPublicKey: decoded.identityPublicKey,
    address: encodeSparkAddress({ identityPublicKey: decoded.identityPublicKey, network }),
    invoiceFields: decoded.sparkInvoiceFields,
  };
}

// Allowlist gate for a Spark-invoice receiver. Exact string match first (the
// bare receiver address, or the whole invoice pasted as a line); failing that,
// compare identity keys so an entry in the other encoding of the same receiver
// (legacy `sp1…` vs current `spark1…`, or an invoice-bearing form) still
// matches. Entries that aren't Spark addresses (L1 lines) simply don't match.
function assertSparkReceiverAllowed(receiver, invoice, allowlist) {
  if (allowlist === null || allowlist === undefined) return; // not enforced
  if (allowlist.includes(receiver.address) || allowlist.includes(invoice)) return;
  for (const entry of allowlist) {
    try {
      const entryNetwork = getNetworkFromSparkAddress(entry);
      if (decodeSparkAddress(entry, entryNetwork).identityPublicKey === receiver.identityPublicKey) return;
    } catch {
      // not a decodable Spark address — an L1 or malformed line can't match
    }
  }
  const e = new Error(
    `Recipient ${receiver.address} (receiver of Spark invoice ${invoice.slice(0, 24)}…) is not in the ` +
      `allowlist. Add it to ${DEFAULT_ALLOWLIST_PATH} (one address per line) to permit this send.`,
  );
  e.code = "RECIPIENT_NOT_ALLOWED";
  throw e;
}

// L402 exchanges a bearer credential (macaroon:preimage) and pays an invoice
// carried in the challenge. Over plaintext http a MITM can swap the invoice or
// capture the credential, so require TLS unless the caller is explicitly
// testing against localhost.
function assertHttpsUrl(method, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`SparkAgent.${method}: invalid URL: ${url}`);
  }
  const local = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "::1";
  if (parsed.protocol !== "https:" && !local) {
    throw new Error(
      `SparkAgent.${method}: refusing a paid request over ${parsed.protocol}// — an L402 exchange ` +
      `sends a bearer credential and pays an invoice from the response; use https (localhost is exempt).`,
    );
  }
}

// Token amounts are base units, which the SDK takes as bigint. Normalize a
// bigint or a safe-integer number to bigint and refuse the rest: a float, a
// negative, a "1.5" string, or 0 (the SDK refuses 0 too, but only after a
// network sync). An amount past 2^53 must arrive as bigint — a number that
// large lost precision before it got here.
function toTokenAmount(value, method, field = "amount") {
  if (typeof value === "bigint" && value > 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return BigInt(value);
  throw new Error(
    `SparkAgent.${method}: ${field} must be a positive integer of the token's base units (bigint, or a number below 2^53), got ${
      typeof value === "bigint" || typeof value === "number" ? String(value) : typeof value
    }.`,
  );
}

// The canonical bech32m token identifier on this wallet's network. Another
// network's identifier (btknrt1… on a mainnet wallet) or a bad checksum is
// refused here, before the SDK sees it.
function canonicalTokenId(value, network, method) {
  try {
    const { tokenIdentifier } = decodeBech32mTokenIdentifier(String(value).trim(), network);
    return encodeBech32mTokenIdentifier({ tokenIdentifier, network });
  } catch {
    throw new Error(
      `SparkAgent.${method}: tokenIdentifier ${JSON.stringify(value)} is not a ${network} token identifier ` +
        "(btkn1… on mainnet, btknrt1… on regtest).",
    );
  }
}

// Per-token totals for one batch, as [{ tokenIdentifier, amount }] with amount
// a decimal string: the batch is one transaction, so a preview shows each
// token's total, not only each entry.
function tokenTotals(items) {
  const totals = new Map();
  for (const { tokenIdentifier, amount } of items) totals.set(tokenIdentifier, (totals.get(tokenIdentifier) ?? 0n) + amount);
  return [...totals].map(([tokenIdentifier, amount]) => ({ tokenIdentifier, amount: String(amount) }));
}

// A send with no spend to record (tokens: the sats ledger doesn't count them).
const NO_SPEND = Object.freeze({ undo: async () => {} });

// fetchL402 refuses to pay for an L402 token the server says dies within this
// many seconds: payAndSettle can take up to ~60 s (30 polls x 2 s) and delivery
// retries add a few more, so a pass with less left could be paid for and then
// refused. (It was 60, the whole polling window, with no margin.)
const L402_MIN_TOKEN_LIFETIME_SECONDS = 120;

// After paying, fetchL402 presents the pass up to this many times in one call
// when delivery fails in transit or with a 5xx, 408 or 429, pausing a little
// longer each time. The money is already gone; a fresh challenge would be a
// new invoice. Only for methods that are safe to repeat: a POST or PATCH is
// sent once, and a failure holds the pass for the caller to present again.
const L402_DELIVERY_ATTEMPTS = 3;
const L402_DELIVERY_BACKOFF_MS = 500;
const L402_RETRY_STATUS = (status) => status >= 500 || status === 408 || status === 429;
const L402_REPEATABLE = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
// Unresolved L402 purchases held per agent (undelivered passes, payments in
// doubt, blocks). Nothing held is ever dropped, since each may mean money has
// left; past this many, fetchL402 refuses to start a new purchase.
const L402_MAX_HELD = 1000;

const l402RequestKey = (method, url) => `${String(method).toUpperCase()} ${url}`;

// What fetchL402 throws for a purchase it has stopped on: the service refused
// the paid pass, the pass died before a doubtful payment settled, or a payment
// ended with no proof. A PaymentCommittedError, so code that stops on
// PAYMENT_COMMITTED stops here too; `reason` says which.
function l402BlockedError(blocked) {
  const e = new PaymentCommittedError(blocked.message, { settled: blocked.settled, op: "l402", invoiceHash: blocked.invoiceHash, sendId: blocked.sendId });
  e.reason = blocked.reason;
  if (blocked.status !== undefined) e.status = blocked.status;
  if (blocked.amountSats != null) e.amountSats = blocked.amountSats;
  e.paid = true;
  return e;
}

// How to lift a block for this request: forgetL402 defaults to GET.
const forgetHint = (method) => {
  const m = String(method).toUpperCase();
  return `agent.forgetL402(url${m === "GET" ? "" : `, { method: "${m}" }`})`;
};

// A delivered body is data even when it is not the JSON its header claims:
// after payment, a parse error must not become a reason to pay again.
async function readBody(res) {
  const text = await res.text();
  if ((res.headers.get("content-type") || "").includes("json")) {
    try { return JSON.parse(text); } catch { /* not JSON after all: return the text */ }
  }
  return text;
}

// Host and path of an L402 resource, for messages. Never the query string,
// which can carry API keys.
const l402Target = (url) => { const u = new URL(url); return { host: u.host, path: u.pathname }; };

// Parse an L402 (a.k.a. LSAT) 402 challenge. Spec-compliant servers (aperture,
// lightningfaucet) put the challenge in the WWW-Authenticate HEADER; others
// return it as a JSON body. Read the header FIRST, then fall back to the body.
// Extract each field by name so it survives every real-world shape: either
// scheme prefix (`L402 ` / `LSAT `), any field order, and either credential
// field name — `macaroon="..."` OR the newer `token="..."` (lightningfaucet
// sends `L402 version="0", token="...", invoice="..."`). A fixed-prefix split
// like `split('L402 macaroon="')` misses the token= form entirely, which is why
// a header-only, spec-compliant server used to throw "Invalid L402 challenge".
// Returns { invoice, macaroon }; the caller decides whether missing => error.
export async function parseL402Challenge(response) {
  const field = (s, key) => s.match(new RegExp(`\\b${key}="([^"]*)"`))?.[1];
  const wwwAuth = response.headers.get("www-authenticate") || "";
  let invoice = field(wwwAuth, "invoice");
  let macaroon = field(wwwAuth, "macaroon") ?? field(wwwAuth, "token");
  if (!invoice || !macaroon) {
    let body = {};
    try { body = await response.json(); } catch { /* body absent or not JSON */ }
    invoice ||= body.invoice || body.payment_request || body.pr;
    macaroon ||= body.macaroon || body.token;
  }
  return { invoice, macaroon };
}

export class SparkAgent {
  #wallet;
  #network;
  #vault = null;
  #ledger = null;
  #lnDedup = null;
  // Serializes the ledger's check-then-record critical section across
  // concurrent sends on this instance (see #recordSpend).
  #spendChain = Promise.resolve();
  // L402 payments this agent made whose resource has not arrived yet, keyed
  // by method + URL: { macaroon, preimage, amountSats, invoice?, sendId? }.
  // A later fetchL402 for the same request in this process presents the pass,
  // or finishes the pending payment, instead of buying another. Memory only —
  // never on disk, in a log, or on an error object — so it ends with the process.
  #l402Held = new Map();

  // seedContext (tests / non-env callers only): overrides the seed-bound
  // policy context normally observed by loadMnemonicFromEnv — shape
  // { policy: { dailyBudgetSats }, ledgerHmacKey } or null for "no bound policy".
  constructor(wallet, network, { seedContext } = {}) {
    this.#wallet = wallet;
    this.#network = network;
    this.#ledger = spendLedgerFromEnv(seedContext !== undefined ? seedContext : getLoadedSeedContext());
    this.#lnDedup = lnDedupFromEnv();
    // The fee ladders belong to the wallet object, so a wallet opened without
    // sparkWalletOptions (raw SDK defaults, 0.13+) arrives here with them on:
    // each claim hands the operators signed fee steps and leaves an anchorless
    // refund the exit backup can't use. `config` is SDK-internal; absent = unknown.
    let ladderOn = false;
    try { ladderOn = !!(wallet?.config?.getEnableCpfpRefundLadder?.() || wallet?.config?.getEnableDirectNodeFeeLadder?.()); } catch {}
    if (ladderOn) {
      console.warn(
        "⚠️  this wallet was opened with the SDK's fee ladders ON. Every claim it makes leaves an anchorless\n" +
          "   refund the unilateral-exit backup can't use. Open it with sparkWalletOptions(network) instead\n" +
          "   (references/unilateral-exit.md → fee ladders).",
      );
    }
    // Automatically mirror the unilateral-exit material to disk so funds stay
    // recoverable if the Spark operators go offline — snapshots on boot and on
    // every leaf change (send/receive/deposit) + a refresh safety timer. Opt out
    // with SPARK_LEAF_VAULT set to off/false/0/no. See references/unilateral-exit.md.
    const flag = String(process.env.SPARK_LEAF_VAULT ?? "").trim().toLowerCase();
    if (!["off", "false", "0", "no"].includes(flag)) {
      this.#vault = enableLeafVault(wallet, { networkLabel: network });
    }
  }

  // optimizeLeaves: leave true for long-running agents (the SDK consolidates
  // UTXO "leaves" in the background after balance changes). Set FALSE for a
  // one-shot script that moves value then calls cleanup() in the same process:
  // cleanup() tears down the gRPC streams mid-optimization and the SDK logs
  // "...interrupted due to cleanup". No funds are lost (the op already settled;
  // optimization resumes on next init), but disabling it removes the race
  // entirely. See references/wallet.md → Cleanup.
  static async create(mnemonic, network = "MAINNET", { optimizeLeaves = true } = {}) {
    // A missing mnemonic must fail LOUDLY, not mint a wallet: the SDK happily
    // generates a fresh wallet for an undefined mnemonicOrSeed, so a typo'd
    // env var or a failed seed decrypt used to silently boot a brand-new
    // MAINNET wallet — and inbound deposits then land on a wallet whose seed
    // nobody has backed up. Deliberate fresh-wallet creation is `npm run
    // setup` (which enforces the mnemonic-backup step), not this code path.
    const usable =
      (typeof mnemonic === "string" && mnemonic.trim().length > 0) ||
      (mnemonic instanceof Uint8Array && mnemonic.length > 0);
    if (!usable) {
      throw new Error(
        "SparkAgent.create: no mnemonic/seed provided — refusing to silently generate a fresh wallet. " +
          "Load the seed with loadMnemonicFromEnv() (SPARK_PASSPHRASE + ~/.spark/seed.enc), " +
          "or run `npm run setup` to create a wallet deliberately.",
      );
    }
    const { wallet, mnemonic: generated } = await SparkWallet.initialize({
      mnemonicOrSeed: mnemonic,
      options: sparkWalletOptions(network, { optimizationOptions: { auto: optimizeLeaves } }),
    });
    const agent = new SparkAgent(wallet, network);
    // Surface a broken recovery backup LOUDLY at startup instead of the silent
    // console.error default — the wallet still works, but the operator is told.
    const vaultReady = await agent.#vault?.ready;
    if (vaultReady && !vaultReady.ok) {
      console.warn(
        `⚠️  leaf-vault backup ${vaultReady.anchorless ? "is written but the exit tool can't use it" : "is NOT active"}: ${vaultReady.error}\n` +
        `   The wallet works, but UNILATERAL EXIT may be impossible until this is fixed.\n` +
        `   Set SPARK_LEAF_VAULT=off to silence, or see references/unilateral-exit.md.`,
      );
    }
    // Spark wallets are PUBLICLY readable by default: anyone holding the
    // address can query the balance and full transfer history with no auth
    // (SparkReadonlyClient.createPublic, Sparkscan) — and an agent hands its
    // address to every counterparty. Turn the per-wallet privacy setting on.
    // It persists at the operators, so this is a self-heal on every boot, not
    // a per-boot requirement; a failure must not block the wallet (the funds
    // work either way) but must be loud. SPARK_PRIVACY=off opts out. Token
    // balances stay public regardless — see references/security.md.
    if (privacyPreferenceFromEnv()) {
      try {
        await ensureWalletPrivacy(wallet);
      } catch (err) {
        console.warn(
          `⚠️  wallet privacy is NOT enabled: ${err?.message ?? err}\n` +
          `   Balance and transfer history are publicly readable by address until this succeeds.\n` +
          `   Set SPARK_PRIVACY=off to silence, or see references/security.md → Wallet privacy.`,
        );
      }
    }
    return { agent, mnemonic: generated };
  }

  // --- Outbound safety check (allowlist gate, called by transfer/withdraw)
  //
  // Reads ~/.spark/recipients.allow on every send. If the file is missing
  // or empty, no enforcement. If it contains addresses, the destination
  // MUST match one of them. Bypass = edit the file. This is a guardrail
  // against the agent surprising the operator, NOT a defense against a
  // compromised agent — anything with FS access to ~/.spark can edit it.
  async #assertAllowed(address) {
    const allowlist = await loadRecipientsAllowlist();
    assertRecipientAllowed(address, allowlist);
  }

  // A dry run must refuse what the send would refuse. The SDK checks the
  // recipient only when it sends (decodeSparkAddress, plus no Spark invoice for
  // a sats transfer), so a typo, an address for the other network, or a silent
  // payment address (sp1q…, an L1 destination for withdraw) used to preview
  // fine and then fail at send time.
  #assertSparkRecipient(method, to, { allowInvoice = false } = {}) {
    let decoded;
    try {
      if (!to) throw new Error("no address given");
      decoded = decodeSparkAddress(to, this.#network);
    } catch (err) {
      const hint = /^(sp|tsp|sprt)1q/i.test(String(to))
        ? " It looks like a silent payment address, which is an L1 destination: use withdraw({ to, amount })."
        : "";
      throw new Error(`SparkAgent.${method}: ${JSON.stringify(to)} is not a ${this.#network} Spark address (${err.message}).${hint}`);
    }
    if (decoded.sparkInvoiceFields && !allowInvoice) {
      throw new Error(`SparkAgent.${method}: that's a Spark invoice, not an address. Pay it with fulfillInvoice([invoice]).`);
    }
  }

  // One rule for every send whose SDK call throws. An error that PROVES
  // nothing left (lib/payment-outcome.js: a pre-send SparkValidationError on
  // an audited list) undoes the spend and is returned to be rethrown as is.
  // Anything else may have moved money: the spend stays counted, since
  // over-counting is the safe direction for a runaway-loop guardrail, and the
  // caller gets a PaymentCommittedError instead of an error that invites a
  // retry with a fresh invoice. Before, every SDK error undid the spend, so a
  // loop of timeouts that each may have paid was never counted at all.
  async #spendFailed(err, spend, { method, op, next, invoiceHash, provable = true }) {
    if (provable && provesNothingSent(err)) {
      await spend.undo().catch(() => {});
      return err;
    }
    return new PaymentCommittedError(
      `SparkAgent.${method}: the outcome is UNKNOWN — the payment may have been sent ` +
      `(${String(err?.message ?? err).slice(0, 200)}). The spend stays counted against the budget. ` +
      `Do NOT pay again with a new invoice, address or method. ${next}`,
      { settled: null, op, invoiceHash, cause: err },
    );
  }

  // Budget gate + PRE-commit record for a sats spend. Recording before the
  // SDK call is the safe direction: a crash mid-send overcounts (and rolls
  // off with the window) rather than undercounts. The returned undo() is
  // called only when the SDK's error proves nothing was sent (#spendFailed).
  async #recordSpend(sats, operation) {
    if (!this.#ledger) return { undo: async () => {} };
    // Serialize check-then-record: without this, N concurrent sends
    // (Promise.all(invoices.map(pay))) each pass assertCanSpend against the
    // same pre-burst ledger, then each record() does load→append→atomic-
    // rename with last-writer-wins — so the appends clobber each other, the
    // ledger UNDERCOUNTS, and the parallel spree the budget exists to stop
    // walks straight through. Chaining onto #spendChain makes the critical
    // section atomic per instance. (Cross-PROCESS concurrency is still
    // last-writer-wins by design — one ledger file per agent; see
    // lib/spend-ledger.js.) A rejected send must not poison the queue for
    // the next caller, so the stored chain swallows outcomes.
    const run = this.#spendChain.then(async () => {
      await this.#ledger.assertCanSpend(sats, operation);
      return this.#ledger.record(sats, operation);
    });
    this.#spendChain = run.then(() => {}, () => {});
    const entry = await run;
    return { undo: () => this.#ledger.unrecord(entry.id) };
  }

  // Rolling-window spend against SPARK_DAILY_BUDGET_SATS, or { disabled: true }
  // when no budget is set (parallels vaultHealth()).
  async spendStatus() {
    if (!this.#ledger) return { disabled: true };
    return await this.#ledger.status();
  }

  // --- Identity ---

  async getIdentity() {
    return {
      address: await this.#wallet.getSparkAddress(),
      publicKey: await this.#wallet.getIdentityPublicKey(),
    };
  }

  // --- Balance ---

  // NOTE: this is CLAIMED Spark balance only. A confirmed L1 deposit that hasn't
  // been claimed yet is invisible here — call listPendingDeposits() to answer
  // "did my on-chain deposit arrive?" (kept off this hot path to avoid a deposit-
  // address query on every balance check).
  async getBalance() {
    const { satsBalance, tokenBalances } = await this.#wallet.getBalance();
    const tokens = Object.fromEntries(
      Array.from(tokenBalances.entries()).map(([id, info]) => [
        id,
        {
          balance: info.ownedBalance.toString(),
          name: info.tokenMetadata.tokenName,
          ticker: info.tokenMetadata.tokenTicker,
          decimals: info.tokenMetadata.decimals,
        },
      ])
    );
    // Sats this wallet still owns but can't spend right now: coins in a send
    // or leaf swap still in flight, leaves the SDK leaves out while the
    // operators disagree about them (both settle within minutes), and coins
    // locked by a Lightning send the SSP refused after the SDK had locked them
    // (an expired invoice on hosted REGTEST). Spark's docs: "Funds locked in
    // an outgoing transfer can remain in owned while being excluded from
    // available."
    const locked = (satsBalance.owned ?? satsBalance.available) - satsBalance.available;
    return { sats: satsBalance.available.toString(), lockedSats: (locked > 0n ? locked : 0n).toString(), tokens };
  }

  // --- Deposits ---

  async getDepositAddress() {
    return await this.#wallet.getStaticDepositAddress();
  }

  // Confirmed-but-UNCLAIMED L1 deposits at this wallet's deposit addresses:
  // the static ones, and the single-use ones not yet claimed. getBalance()
  // shows only CLAIMED Spark balance, so THIS is what answers "did my on-chain
  // deposit arrive?" — an empty array means nothing to claim yet. Each entry
  // carries its `type` ("static" | "single-use"); claimDeposit({ txid, vout })
  // claims a static one and refuses a single-use one with the reason, because
  // the operators currently refuse those claims. Listing them still matters:
  // coins sent to an old single-use address are there, and "nothing arrived"
  // would be wrong. A funded single-use address stays on the operators' unused
  // list until it is claimed (hosted REGTEST, 2026-10-26,
  // tests/integration/funded/single-use-deposit.test.js). The SDK gives only
  // { txid, vout } per UTXO (no amount or confirmations); to learn the credit,
  // dry-run a claim.
  async listPendingDeposits({ limit = 100 } = {}) {
    const deposits = [];
    for (const [type, address] of await this.#depositAddresses()) {
      // 4th arg excludeClaimed=true -> only UTXOs not yet claimed on Spark
      const utxos = await this.#wallet.getUtxosForDepositAddress(address, limit, 0, true);
      for (const u of utxos) deposits.push({ address, txid: u.txid, vout: u.vout, type });
    }
    return deposits;
  }

  // [type, address] for each of this wallet's deposit addresses, static first,
  // each address once.
  async #depositAddresses() {
    const [statics, singles] = await Promise.all([
      this.#wallet.queryStaticDepositAddresses(),
      this.#wallet.getUnusedDepositAddresses(),
    ]);
    const seen = new Set();
    const out = [];
    for (const [type, addresses] of [["static", statics], ["single-use", singles]]) {
      for (const address of addresses) {
        if (seen.has(address)) continue;
        seen.add(address);
        out.push([type, address]);
      }
    }
    return out;
  }

  // Which of this wallet's deposit addresses holds txid:vout, unclaimed:
  // "static", "single-use", or null. Asked of the operators. The static
  // addresses first: the single-use list is read only when the deposit isn't
  // there, so a failing single-use query can't block a static claim.
  async #depositType(txid, vout) {
    const want = txid.toLowerCase();
    const holds = async (address) => {
      let previous = null;
      for (let page = 0; page < DEPOSIT_UTXO_MAX_PAGES; page++) {
        const utxos = await this.#wallet.getUtxosForDepositAddress(address, DEPOSIT_UTXO_PAGE, page * DEPOSIT_UTXO_PAGE, true);
        if (utxos.some((u) => String(u.txid).toLowerCase() === want && Number(u.vout) === vout)) return true;
        if (utxos.length < DEPOSIT_UTXO_PAGE) return false;
        // The same page again means the server ignores the offset: the rest
        // can't be read, so say so rather than "not found".
        const first = `${utxos[0].txid}:${utxos[0].vout}`;
        if (first === previous) throw incomplete(address, "the operators returned the same page twice");
        previous = first;
      }
      throw incomplete(address, `stopped after ${DEPOSIT_UTXO_PAGE * DEPOSIT_UTXO_MAX_PAGES} unclaimed UTXOs`);
    };
    const incomplete = (address, why) => {
      const e = new Error(
        `SparkAgent.claimDeposit: can't tell whether ${txid}:${vout} is at ${address}: ${why}. ` +
          "Nothing was spent or changed.",
      );
      e.code = "DEPOSIT_LOOKUP_INCOMPLETE";
      return e;
    };
    const statics = await this.#wallet.queryStaticDepositAddresses();
    for (const address of statics) if (await holds(address)) return "static";
    for (const address of await this.#wallet.getUnusedDepositAddresses()) {
      if (!statics.includes(address) && (await holds(address))) return "single-use";
    }
    return null;
  }

  // Refused: the operators have switched off the step that claims a
  // single-use deposit (finalize_deposit_tree_creation answers UNAVAILABLE on
  // MAINNET and REGTEST, 2026-10-26; a real 2,000-sat mainnet deposit was
  // refused). Coins sent to such an address stay there, visible but
  // unclaimable, and the SDK has no refund path for them. The static address
  // is claimed through the SSP instead and is unaffected.
  async getSingleUseDepositAddress() {
    const e = new Error(
      "SparkAgent.getSingleUseDepositAddress: refused — the Spark operators currently refuse to claim single-use " +
        "deposits (finalize_deposit_tree_creation UNAVAILABLE), so coins sent to one would be stuck. " +
        "Use getDepositAddress() (the static, reusable address) instead. To tell payers apart, give each order " +
        "its own Lightning invoice (createLightningInvoice).",
    );
    e.code = "SINGLE_USE_DEPOSITS_UNAVAILABLE";
    throw e;
  }

  // --- Spark Transfers ---
  //
  // `dryRun: true` returns a structured preview WITHOUT signing or
  // broadcasting. Use it to confirm with the operator before spending:
  //
  //   const preview = await agent.transfer({ to: "sp1...", amount: 1000n, dryRun: true });
  //   // → { dryRun: true, operation: "spark_transfer", from, to, amount, estimatedFee: "0", network }
  //   // → ask user, then call again with dryRun omitted to actually send.
  //
  // Allowlist enforcement applies in BOTH modes (so dry-runs can't be used
  // to silently confirm a send to a disallowed address).

  async transfer({ to, amount, dryRun = false, ...rest }) {
    rejectUnknownOptions("transfer", rest);
    await this.#assertAllowed(to);
    const sats = toSats(amount, "transfer"); // number|bigint -> safe-int Number (dry-run + live agree)
    if (dryRun) {
      this.#assertSparkRecipient("transfer", to); // a Spark invoice is refused here, as the send refuses it
      return {
        dryRun: true,
        operation: "spark_transfer",
        from: await this.#wallet.getSparkAddress(),
        to,
        amount: String(sats),
        unit: "sats",
        estimatedFee: "0", // Spark-to-Spark transfers are free
        network: this.#network,
      };
    }
    const spend = await this.#recordSpend(sats, "spark_transfer");
    try {
      return await this.#wallet.transfer({
        receiverSparkAddress: to,
        amountSats: sats,
      });
    } catch (err) {
      throw await this.#spendFailed(err, spend, {
        method: "transfer",
        op: "spark_transfer",
        next: "Check agent.getTransfers() before sending again: a new transfer is a second payment.",
      });
    }
  }

  async getTransfers(limit = 10, offset = 0) {
    return await this.#wallet.getTransfers(limit, offset);
  }

  // This wallet's latest token transactions, NEWEST FIRST, readable (see
  // readableTokenTransaction). getTransfers() lists sats transfers only, so
  // this is where to look after a token send threw PAYMENT_COMMITTED: find the
  // recipient, token and amount among the newest entries. Optionally one token
  // (btkn1… / btknrt1…). The operators page oldest-first; asking for the
  // previous page with no cursor returns the newest page (hosted REGTEST,
  // 2026-10-26), so the raw query's first page was the wallet's OLDEST. That
  // is the operators' code (query_token_txs_handler.go: no cursor + PREVIOUS
  // orders by UUIDv7 id descending, takes the page, reverses it), but no doc
  // or proto promises it; tests/integration/funded/token-transactions.test.js
  // fails if it changes.
  async getTokenTransactions({ tokenIdentifier, limit = 20, ...rest } = {}) {
    rejectUnknownOptions("getTokenTransactions", rest);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > TOKEN_TX_MAX_LIMIT) {
      throw new RangeError(`SparkAgent.getTokenTransactions: limit must be a whole number from 1 to ${TOKEN_TX_MAX_LIMIT}, got ${JSON.stringify(limit)}.`);
    }
    const res = await this.#wallet.queryTokenTransactionsWithFilters({
      sparkAddresses: [await this.#wallet.getSparkAddress()],
      ...(tokenIdentifier !== undefined ? { tokenIdentifiers: [canonicalTokenId(tokenIdentifier, this.#network, "getTokenTransactions")] } : {}),
      pageSize: limit,
      direction: "PREVIOUS",
    });
    const me = await this.#wallet.getIdentityPublicKey();
    return [...(res?.tokenTransactionsWithStatus ?? [])].reverse().map((t) => readableTokenTransaction(t, this.#network, me));
  }

  // One token transaction by the hash a successful transferTokens or
  // batchTransferTokens returned, readable; null when the operators have none.
  async getTokenTransaction(hash) {
    if (typeof hash !== "string" || !/^[0-9a-fA-F]{64}$/.test(hash)) {
      throw new TypeError(`SparkAgent.getTokenTransaction: pass the 64-character hex hash a token send returned, got ${JSON.stringify(hash)}.`);
    }
    const res = await this.#wallet.queryTokenTransactionsByTxHashes([hash.toLowerCase()]);
    const found = res?.tokenTransactionsWithStatus?.[0];
    return found ? readableTokenTransaction(found, this.#network, await this.#wallet.getIdentityPublicKey()) : null;
  }

  // --- Lightning ---

  async createLightningInvoice(amountSats, memo, options = {}) {
    const request = await this.#wallet.createLightningInvoice({
      amountSats: toSats(amountSats, "createLightningInvoice"),
      memo,
      expirySeconds: options.expirySeconds || 3600,
      includeSparkAddress: options.includeSparkAddress ?? true,
    });
    return request.invoice.encodedInvoice;
  }

  // An invoice you can check later, for telling payers apart (one per order).
  // Without the Spark fallback: a Spark wallet paying an invoice that carries
  // one sends a plain transfer, and the invoice then never shows as paid
  // (hosted REGTEST, 2026-10-26: the money arrived, the receive request stayed
  // INVOICE_CREATED). Every payer pays it over Lightning, Spark wallets
  // included, with the fee on the payer. Keep `id`; getInvoiceStatus(id) says
  // whether it was paid.
  async createTrackedInvoice(amountSats, memo, { expirySeconds = 3600, ...rest } = {}) {
    rejectUnknownOptions("createTrackedInvoice", rest);
    const sats = toSats(amountSats, "createTrackedInvoice");
    // An amountless invoice lets the payer pick the amount, and `paid` would
    // then mark a priced order paid for 1 sat.
    if (!(sats >= 1)) throw new RangeError(`SparkAgent.createTrackedInvoice: amountSats must be at least 1, got ${JSON.stringify(amountSats)}.`);
    const request = await this.#wallet.createLightningInvoice({
      amountSats: sats,
      memo,
      expirySeconds,
      includeSparkAddress: false,
    });
    return {
      id: request.id,
      invoice: request.invoice.encodedInvoice,
      paymentHash: request.invoice.paymentHash,
      expiresAt: request.invoice.expiresAt,
    };
  }

  // Where an invoice from createTrackedInvoice stands, as `state` (see
  // RECEIVE_STATES): unpaid, in_progress, received (the customer has paid; the
  // sats arrive when this wallet claims them), paid, failed (the customer
  // wasn't charged), failed_after_payment (charged, but the sats didn't reach
  // this wallet: take it up with Spark), or unknown (a status this SDK can't
  // name: treat it as in progress). `canReinvoice` is true only once the
  // invoice has expired, plus a grace period, while unpaid or failed: an early
  // failure may not be final (the SSP may retry, the payer may pay again), and
  // a new invoice before then could charge the customer twice. `status` is the
  // SSP's own word. null when there is no such invoice.
  async getInvoiceStatus(id) {
    if (typeof id !== "string" || !id) throw new TypeError("SparkAgent.getInvoiceStatus: pass the id createTrackedInvoice returned.");
    const request = await this.#wallet.getLightningReceiveRequest(id);
    if (!request) return null;
    const state = RECEIVE_STATES[request.status] ?? "unknown";
    const expiresAt = request.invoice?.expiresAt ?? null;
    const expiresMs = expiresAt ? Date.parse(expiresAt) : NaN;
    const now = Date.now();
    return {
      id: request.id,
      state,
      paid: state === "paid",
      customerCharged: state === "paid" || state === "received" || state === "failed_after_payment" ? true : state === "unpaid" || state === "failed" ? false : null,
      expired: Number.isFinite(expiresMs) ? now >= expiresMs : null,
      canReinvoice: (state === "unpaid" || state === "failed") && Number.isFinite(expiresMs) && now >= expiresMs + REINVOICE_GRACE_MS,
      status: request.status,
      paymentHash: request.invoice?.paymentHash ?? null,
      amountSats: wholeSats(request.invoice?.amount),
      expiresAt,
    };
  }

  // `dryRun: true` returns a preview (incl. estimated routing fee) without
  // paying. Lightning recipients are node pubkeys embedded in the BOLT11,
  // so the allowlist (which targets Spark/L1 addresses) does not apply here
  // — confirm the invoice's amount and decoded payee with the operator
  // before paying when stakes warrant it. A Spark-backed invoice settles
  // Spark-direct (free) unless `expectedPaymentHash` binds it or
  // `preferSpark: false` is passed; both pay over Lightning.
  async payLightningInvoice(bolt11, { maxFeeSats, amountSats, maxAmountSats = 10_000, transferId, preferSpark, expectedPaymentHash, dryRun = false, ...rest } = {}) {
    // The raw SDK takes ONE object ({ invoice, ... }); this wrapper takes a bare
    // BOLT11 string + options. The raw layer crashes opaquely on the mix-up
    // ("Cannot read properties of undefined (reading 'toLowerCase')" — no
    // validation in spark-sdk through at least 0.14.0), so the wrapper
    // direction at least must fail loud and name both shapes.
    if (typeof bolt11 !== "string") {
      throw new TypeError(
        `SparkAgent.payLightningInvoice takes a bare BOLT11 string first — ` +
        `payLightningInvoice("lnbc...", { maxFeeSats }) — got ${bolt11 === null ? "null" : typeof bolt11}. ` +
        `The { invoice, ... } object shape belongs to the raw wallet.payLightningInvoice; ` +
        `the two signatures are not interchangeable.`,
      );
    }
    rejectUnknownOptions("payLightningInvoice", rest);
    // transferId (optional): a caller-managed dedup identity. Normalize
    // through the SDK's own UUID parser up front — the SDK requires an
    // instanceof-UUID object, not a string, and a garbage value must throw
    // HERE rather than after fees are estimated and the spend is recorded.
    let explicitTransferId;
    if (transferId !== undefined) {
      try {
        explicitTransferId = UUID.parse(transferId).toString();
      } catch {
        throw new Error(
          `SparkAgent.payLightningInvoice: transferId must be a UUID string, got ${JSON.stringify(transferId)} — ` +
          `an unreadable dedup identity would forfeit the retry safety it exists to provide.`,
        );
      }
    }
    // Spark-direct pays an invoice's Spark fallback as a plain transfer to the
    // fallback key: the payment hash plays no part and no preimage comes back.
    // So it defeats any check that pins the hash. A fallback spliced into a
    // merchant's invoice keeps the hash, amount and description (nothing
    // checks the signature without an `n` tag), and any Spark user can get a
    // genuinely SSP-signed invoice with a hash of their choosing and their own
    // fallback (createLightningHodlInvoice). Over Lightning, the payment only
    // completes against the preimage of that hash. expectedPaymentHash checks
    // the binding here, before any I/O, and pays over Lightning; preferSpark:
    // false alone is for a caller that needs the preimage (fetchL402).
    if (preferSpark !== undefined && typeof preferSpark !== "boolean") {
      throw new TypeError(`SparkAgent.payLightningInvoice: preferSpark must be a boolean, got ${JSON.stringify(preferSpark)}.`);
    }
    const hashBound = expectedPaymentHash !== undefined && expectedPaymentHash !== null;
    if (hashBound) {
      if (typeof expectedPaymentHash !== "string" || !/^[0-9a-f]{64}$/i.test(expectedPaymentHash)) {
        throw new TypeError(
          `SparkAgent.payLightningInvoice: expectedPaymentHash must be a 64-character hex string, or null for ` +
          `no binding — got ${JSON.stringify(expectedPaymentHash)}.`,
        );
      }
      if (preferSpark === true) {
        throw new Error(
          `SparkAgent.payLightningInvoice: preferSpark: true can't be combined with expectedPaymentHash — ` +
          `a Spark-direct payment ignores the payment hash, so the binding would check nothing.`,
        );
      }
      if (!paymentHashMatches(bolt11, expectedPaymentHash)) {
        throw new Error(
          `Payment blocked: the invoice's payment hash (${invoicePaymentHash(bolt11) ?? "none readable"}) is not ` +
          `expectedPaymentHash (${expectedPaymentHash.toLowerCase()}) — this is not the invoice the checkout issued.`,
        );
      }
    }
    // BOLT11 allows exactly one payment hash. With two, the SDK pays under the
    // last one and no preimage can be checked against "the" hash, so payAndSettle
    // would report any preimage as proof (ToB review 2026-10-26). Refuse it.
    const hashCount = invoicePaymentHashCount(bolt11);
    if (hashCount !== null && hashCount !== 1) {
      throw new Error(
        `Payment blocked: the invoice carries ${hashCount} payment hashes; a valid BOLT11 invoice has exactly one.`,
      );
    }
    // One hash that isn't 32 bytes reads as no hash at all, and the preimage
    // check would then pass anything (ToB review of 375e6fb..HEAD).
    if (hashCount === 1 && !invoicePaymentHash(bolt11)) {
      throw new Error("Payment blocked: the invoice's payment hash is not a 32-byte hash, so no preimage could prove this payment.");
    }
    // An expired invoice can't be paid, but the SDK locks the coins before the
    // SSP says so: on hosted REGTEST (2026-10-26) paying one tied up 303 sats
    // in a pending transfer that expires 16 days later, with no way to cancel
    // it. Refuse before any I/O, with a margin for the seconds a send takes to
    // reach the SSP. An undecodable invoice has no expiry to read; the SDK
    // refuses it.
    const secondsLeft = invoiceSecondsRemaining(bolt11);
    if (secondsLeft !== null && secondsLeft < LIGHTNING_MIN_INVOICE_SECONDS) {
      const when = secondsLeft <= 0 ? `expired ${Math.ceil(-secondsLeft)} s ago` : `expires in ${Math.floor(secondsLeft)} s`;
      // A retry of a payment whose outcome was unknown lands here once the
      // invoice has expired. "Nothing was sent" is then true of THIS call
      // only: the earlier attempt may have paid, and a new invoice from the
      // payee would be a second payment. The dedup store knows.
      const earlier = this.#lnDedup ? await this.#lnDedup.peek(bolt11).catch(() => ({ unreadable: true })) : null;
      if (earlier) {
        const e = new PaymentCommittedError(
          `SparkAgent.payLightningInvoice: the invoice ${when}, so it can't be paid now, and an earlier attempt to pay ` +
            `it is on record (transferId ${earlier.transferId ?? "unreadable"}) that may have gone through. Check ` +
            `agent.getTransfers() before paying a new invoice for the same thing: that would be a second payment. ` +
            `Nothing was sent by this call.`,
          { settled: null, op: "lightning_pay", invoiceHash: invoicePaymentHash(bolt11) ?? undefined },
        );
        e.reason = "INVOICE_EXPIRED_AFTER_ATTEMPT";
        throw e;
      }
      const e = new Error(
        `Payment blocked: the invoice ${when}. Paying it would lock the amount in a transfer the SSP refuses, ` +
          `with no set time for it to come back. Nothing was sent by this call. Ask the payee for a new invoice, ` +
          `unless an earlier attempt to pay this one had an unclear outcome: then check agent.getTransfers() first.`,
      );
      e.code = "INVOICE_EXPIRED";
      throw e;
    }
    const sparkDirect = !hashBound && preferSpark !== false;
    // Validate BEFORE any I/O: a garbage ceiling must throw here, not degrade
    // to "no cap set" inside the guards (see requireNumericOption).
    const maxFee = requireNumericOption("payLightningInvoice", "maxFeeSats", maxFeeSats);
    const maxAmt = requireNumericOption("payLightningInvoice", "maxAmountSats", maxAmountSats) ?? 10_000;
    const amtSats = toSats(amountSats, "payLightningInvoice", "amountSats"); // bigint -> safe-int Number
    const invoiceAmt = invoiceAmountSats(bolt11); // embedded amount; undefined for amountless/undecodable
    const est = await this.#wallet.getLightningSendFeeEstimate({
      encodedInvoice: bolt11,
      amountSats: amtSats,
    });
    const estimatedFee = lightningEstimateSats(est);
    // The INVOICE wins over the caller's number. For an amount-bearing invoice
    // the SDK pays the embedded amount (it rejects amountSatsToSend for those,
    // see below), so checking a caller-supplied figure would guard a number
    // nobody pays: pass amountSats: 100 with a 20,000-sat invoice and the
    // ceiling validates 100 while 20,000 leaves the wallet — and the dry-run
    // preview would show the operator the wrong number too. Disagreement is a
    // bug or an injected parameter, so refuse rather than silently pick one.
    if (invoiceAmt !== undefined && amtSats !== undefined && amtSats !== invoiceAmt) {
      throw new Error(
        `SparkAgent.payLightningInvoice: amountSats (${amountSats}) disagrees with the invoice's ` +
        `embedded amount (${invoiceAmt} sats). The invoice amount is what gets paid — omit amountSats ` +
        `for amount-bearing invoices.`,
      );
    }
    const amt = invoiceAmt ?? amtSats;
    // Fee cap: amount-aware (0.5% of amount, min 25 sats — Spark's flat fee
    // component alone hit 25 on a live 4.5k-sat send). Explicit maxFeeSats wins.
    const cap = maxFee ?? lightningFeeCap({ amountSats: amt, estimatedFeeSats: estimatedFee });
    const feeCheck = checkFeeAgainstCap(estimatedFee, cap);
    // Amount ceiling: the fee cap alone CANNOT stop an induced full-balance send
    // (routing ~0.25% always fits a 0.5% fee cap), so bound the AMOUNT too — the
    // same guard the L402 path uses. Fails closed on an amountless/undecodable
    // invoice. Raise maxAmountSats for a genuinely larger send.
    const amtCheck = checkL402Amount({ amountSats: amt, maxAmountSats: maxAmt });
    const ok = feeCheck.ok && amtCheck.ok;
    const reason = !amtCheck.ok ? amtCheck.reason : feeCheck.reason;
    if (dryRun) {
      return {
        dryRun: true,
        operation: "lightning_pay",
        from: await this.#wallet.getSparkAddress(),
        invoice: bolt11,
        amount: amt !== undefined ? String(amt) : "<from invoice>",
        unit: "sats",
        estimatedFee: estimatedFee != null ? String(estimatedFee) : "unknown",
        maxFeeSats: String(cap),
        maxAmountSats: String(maxAmt),
        withinCap: ok,
        capReason: ok ? "within caps" : reason,
        network: "lightning",
        preferSpark: sparkDirect,
      };
    }
    if (!ok) {
      const hint = !amtCheck.ok ? "Raise maxAmountSats" : "Raise maxFeeSats";
      throw new Error(`Lightning send blocked: ${reason}. ${hint} to override.`);
    }
    // Resolve the payment's dedup identity BEFORE recording the spend or
    // touching the SDK: one persisted transferId per invoice (write-ahead), so
    // a retry of this same invoice — this process or the next one — reuses it
    // and the SDK's cross-rail dedup refuses a second payment (see
    // lib/transfer-ids.js). A store failure throws HERE, with no money moved
    // and no ledger entry to undo. With the store opted off, an explicit
    // transferId still forwards (the caller owns dedup); with neither, the
    // SDK mints per call — today's double-pay-on-retry gamble.
    let sdkTransferId;
    let resolved; // kept in scope: `reused` proves a later AlreadyExists means SETTLED
    if (this.#lnDedup) {
      resolved = await this.#lnDedup.idForInvoice(
        bolt11,
        () => generateTransferId().toString(),
        { explicitId: explicitTransferId },
      );
      sdkTransferId = UUID.parse(resolved.transferId);
    } else if (explicitTransferId !== undefined) {
      sdkTransferId = UUID.parse(explicitTransferId);
    }
    // Budget counts the AMOUNT; routing fees are bounded separately by the cap
    // above (≤0.5% + floor). An unreadable amount with a budget set fails
    // closed inside the ledger. A deduped retry re-records here, so the budget
    // can OVERCOUNT one payment attempted twice — the safe direction for a
    // runaway-loop guardrail (see #recordSpend's crash trade-off).
    // A dedup id this attempt minted must not outlive an attempt that provably
    // sent nothing: left behind, it later reads as "an earlier attempt may have
    // paid" (the expired-invoice refusal above), and blocks a legitimate
    // purchase (ToB review of 9bc0f22..f88fbec).
    const forgetIfMinted = async () => {
      if (resolved && !resolved.reused) await this.#lnDedup.forget(bolt11).catch(() => {});
    };
    let spend;
    try {
      spend = rest[LN_RESUMING] ? NO_SPEND : await this.#recordSpend(amt, "lightning_pay");
    } catch (err) {
      await forgetIfMinted(); // the budget refused before the SDK was called
      throw err;
    }
    let result;
    try {
      // The SDK REQUIRES amountSatsToSend for a zero-amount invoice and REJECTS it
      // for an invoice that carries one — forward the caller's amount only in the
      // amountless case. (Without this, amountless sends fail at payment time even
      // though the fee estimate above accepted the amount.)
      result = await this.#wallet.payLightningInvoice({
        invoice: bolt11,
        maxFeeSats: cap,
        preferSpark: sparkDirect, // false when a hash binds the payment or the caller opted out (above)
        ...(sdkTransferId !== undefined ? { transferId: sdkTransferId } : {}),
        ...(invoiceAmt === undefined && amtSats !== undefined ? { amountSatsToSend: amtSats } : {}),
      });
    } catch (err) {
      // AlreadyExists on a KNOWN retry (the store proved this id was already
      // used for THIS invoice) is proof of settlement, not failure — the
      // Spark-fallback rail dedupes via a DB uniqueness constraint and
      // surfaces it as a raw gRPC error that reads as the opposite of what
      // happened (2026-08-31 live QA + ToB sharp-edges F1). Translate it
      // HERE, where the wrapper holds the proof. This attempt's spend entry
      // is a duplicate — the attempt that paid recorded it — so it is undone.
      // A non-reused AlreadyExists (store deleted between attempts?) is a
      // state we can't vouch for, so it falls through to "outcome unknown".
      if (resolved?.reused && /already\s?exists/i.test(String(err?.message ?? ""))) {
        await spend.undo().catch(() => {});
        const settled = new Error(
          `SparkAgent.payLightningInvoice: this invoice's payment ALREADY SETTLED — the operators ` +
          `refused a second transfer under the recorded transferId (${resolved.transferId}). This is ` +
          `dedup working, not a failed payment. Do NOT retry on any rail or by any path: not with a ` +
          `fresh invoice (a new payment hash escapes dedup = a real second payment) and not via the ` +
          `raw SDK. Verify via the balance delta or transfer list.`,
        );
        settled.code = "PAYMENT_ALREADY_SETTLED";
        settled.cause = err;
        throw settled;
      }
      if (provesNothingSent(err)) await forgetIfMinted();
      throw await this.#spendFailed(err, spend, {
        method: "payLightningInvoice",
        op: "lightning_pay",
        invoiceHash: invoicePaymentHash(bolt11) ?? undefined,
        next: this.#lnDedup
          ? "Retrying THIS invoice through payLightningInvoice is safe: the dedup store reuses its transferId, so the operators refuse a second payment. For anything else, check agent.getTransfers() first."
          : "SPARK_LN_DEDUP is off, so even retrying this same invoice may pay twice: check agent.getTransfers() first.",
      });
    }
    if (!result || typeof result !== "object") return result;
    // A copy, so a frozen SDK result can't lose the fields added here.
    const out = { ...result };
    // Surface the dedup verdict: a reused id means this "success" is the
    // ORIGINAL payment's result replayed (Lightning rail), not a new debit —
    // without the flag, a deliberate second pay of the same invoice reads as
    // a fresh payment while no money moved (ToB sharp-edges F3).
    if (resolved) out.dedupReused = resolved.reused;
    const settling = rest[LN_SETTLING];
    if (settling) {
      Object.assign(settling, { amountSats: amt, capSats: cap });
      return out;
    }
    const fee = await this.#lightningFee(out, { amountSats: amt, capSats: cap, settled: Boolean(out.paymentPreimage), pollMs: LIGHTNING_FEE_POLL_MS });
    return Object.assign(out, fee);
  }

  // The fee fields of a paid Lightning result: `feeSats`, and `feeNote` when
  // feeSats is the cap standing in for a cost nobody has reported. Paid over
  // Spark (the invoice's fallback address: the SDK answers with a transfer,
  // not a send request), there is no Lightning fee. Settled: status reads
  // until one says what it cost, at most LIGHTNING_FEE_READS, counting
  // `preimageRead`, the read that brought the preimage, if one did. Not
  // settled, or no read says: the cap, which over-reports — the safe direction.
  async #lightningFee(result, { amountSats, capSats, settled, pollMs, preimageRead = null }) {
    if (!("encodedInvoice" in result)) return { feeSats: 0 };
    for (let i = 0; settled && i < LIGHTNING_FEE_READS; i++) {
      let read = i === 0 ? preimageRead : null;
      if (!read) {
        if (i > 0) await new Promise((r) => setTimeout(r, pollMs));
        try {
          read = await this.#wallet.getLightningSendRequest(result.id);
        } catch {
          read = null; // a failed status read says nothing about the payment
        }
      }
      const fee = read && typeof read === "object" ? lightningPaidFeeSats(read, amountSats) : null;
      if (fee !== null) return { feeSats: fee };
    }
    const why = settled
      ? "the wallet hasn't reported what this payment cost"
      : "the payment hasn't settled, so what it cost isn't known yet";
    return { feeSats: capSats, feeNote: `feeSats is the fee cap: ${why}. It was at most ${capSats} sats.` };
  }


  async estimateLightningFee(bolt11, amountSats) {
    return await this.#wallet.getLightningSendFeeEstimate({
      encodedInvoice: bolt11,
      amountSats: toSats(amountSats, "estimateLightningFee"),
    });
  }

  // payLightningInvoice can return LIGHTNING_PAYMENT_INITIATED before the
  // preimage exists; poll the send request by id until it appears or fails.
  async getLightningSendRequest(id) {
    return await this.#wallet.getLightningSendRequest(id);
  }

  // Pay a BOLT11 and wait for the settlement preimage — the proof-of-payment
  // that merchant policy says to log. Wraps the LIGHTNING_PAYMENT_INITIATED
  // poll loop every merchant purchase otherwise re-implements. Throws on
  // LIGHTNING_PAYMENT_FAILED. A Spark-direct payment returns at once with
  // { settled: true, sparkDirect: true, paymentPreimage: null }: the payee has
  // the money, and there is no Lightning proof to wait for.
  // On poll exhaustion returns { settled: false }:
  // do NOT reflex-retry after a timeout — the payment may still settle (hold
  // invoices legitimately stay pending for many minutes); check
  // getLightningSendRequest(result.id) first. When a retry IS warranted, the
  // persisted per-invoice transferId (see payLightningInvoice) makes it
  // dedup-safe — the SDK cannot pay the same invoice twice through this
  // wrapper while the ~/.spark/ln-dedup store is intact. The residual hazard
  // is a deleted/absent store (or SPARK_LN_DEDUP=off), where a retry is the
  // old double-pay gamble again. A deduped retry's SHAPE differs by rail
  // (live-validated, one debit either way): the Lightning rail REPLAYS the
  // original result (same id + preimage, reads as success); the Spark-fallback
  // rail THROWS "AlreadyExists ... transfer already exists" — which means
  // ALREADY PAID, not failed. On AlreadyExists the payment is settled: do not
  // retry on any rail, by ANY path — not via a fresh invoice (new payment
  // hash = new dedup entry = a real second payment) and not via the raw SDK
  // (bypasses the store). Confirm via the balance/transfer list.
  async payAndSettle(bolt11, { pollMs = 2000, maxPolls = 30, ...payOptions } = {}) {
    const sent = {}; // filled by payLightningInvoice: { amountSats, capSats }
    const result = await this.payLightningInvoice(bolt11, { ...payOptions, [LN_SETTLING]: sent });
    if (payOptions.dryRun) return result;
    // Spark-direct: the SDK paid the invoice's Spark fallback as a plain
    // transfer (a WalletTransfer, not a LightningSendRequest). The payee has
    // the money and no preimage will ever come, so there is nothing to poll:
    // polling Lightning status with a transfer id used to wait ~60 s and then
    // report settled: false for a payment that had gone through.
    if (result && !("encodedInvoice" in result) && "transferDirection" in result) {
      return { ...result, paymentPreimage: null, settled: true, sparkDirect: true, lastStatus: result.status ?? null, feeSats: 0 };
    }
    let preimage = result.paymentPreimage ?? null;
    let lastStatus = result.status ?? null;
    let preimageRead = null;
    for (let i = 0; !preimage && result.id && i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, pollMs));
      // A status read that fails says nothing about the payment, and the money
      // may already be gone: keep polling. Thrown, it used to reach the caller
      // as a raw error after paying (fetchL402 then bought a second time).
      const status = await this.#wallet.getLightningSendRequest(result.id).catch(() => null);
      lastStatus = status?.status ?? lastStatus;
      if (status?.paymentPreimage) {
        preimage = status.paymentPreimage;
        preimageRead = status;
      } else if (PAYEE_MAYBE_PAID_STATUSES.has(status?.status)) {
        // After the Lightning leg succeeded: the payee may have the money. Not
        // "failed" (that invites a fresh invoice) and not a silent timeout
        // either. The dedup id is kept, so a retry of THIS invoice is refused.
        throw new PaymentCommittedError(
          `SparkAgent.payAndSettle: the payment ended in ${status.status}, after the Lightning payment ` +
          `succeeded, so the payee may already have been paid. Do NOT pay again with a new invoice or method; ` +
          `check agent.getTransfers(). Retrying THIS invoice through payLightningInvoice is deduped.`,
          { settled: null, op: "lightning_pay", sendId: result.id, invoiceHash: invoicePaymentHash(bolt11) ?? undefined },
        );
      } else if (isTerminalLightningFailure(status?.status)) {
        // Distinguishing a DEFINITIVE failure from a slow settle is what makes
        // the never-retry-on-timeout rule safe: a failed-and-refunded payment
        // that merely timed out would otherwise look pending forever, and the
        // rule would forbid the retry that is actually correct.
        // The dead transferId must not outlive the failure: kept, it makes a
        // legitimate re-pay of the still-valid invoice replay the failure (or
        // hit AlreadyExists, which the docs then read as "already paid") —
        // ToB sharp-edges F5. The SDK marked this TERMINAL (funds failed or
        // returned), so a fresh id on the next attempt is the correct state.
        if (this.#lnDedup) await this.#lnDedup.forget(bolt11);
        const failed = new Error(`Lightning payment failed (${status.status})`);
        failed.code = "LIGHTNING_PAYMENT_FAILED";
        failed.status = status.status;
        throw failed;
      }
    }
    // Proof means PROOF: a Lightning preimage settles THIS invoice only if
    // sha256(preimage) equals the invoice's payment hash. A non-matching
    // preimage is the replay shape — a transferId wrongly shared with a
    // DIFFERENT payment makes the SDK hand back that payment's result as this
    // one's "success" while this invoice was never paid (ToB sharp-edges F2).
    // Undecodable invoices carry no hash to check; the raw result passes
    // through as before.
    if (preimage) {
      const expected = invoicePaymentHash(bolt11);
      if (expected) {
        const got = createHash("sha256").update(Buffer.from(preimage, "hex")).digest("hex");
        if (got !== expected) {
          throw new Error(
            `SparkAgent.payAndSettle: the returned preimage does NOT hash to this invoice's payment ` +
            `hash (sha256(preimage) = ${got}, invoice = ${expected}) — refusing to report settled. ` +
            `This is the signature of a transferId shared with a different payment: THIS invoice was ` +
            `not paid. Check the transfer list, and never reuse one transferId across invoices.`,
          );
        }
      }
    }
    // What it cost, read once it has settled (#lightningFee): the SDK's
    // first answer can say 0 before the payment has been priced. Not for
    // fetchL402: it reports no fee, and its paid pass is waiting to be
    // presented before the token expires.
    const fee = sent.capSats === undefined || payOptions[LN_NO_FEE_READS]
      ? {}
      : await this.#lightningFee(result, { ...sent, settled: Boolean(preimage), pollMs, preimageRead });
    return { ...result, paymentPreimage: preimage, settled: Boolean(preimage), lastStatus, ...fee };
  }

  // --- Spark Invoices ---

  async createSatsInvoice(amountSats, memo) {
    return await this.#wallet.createSatsInvoice({
      amount: toSats(amountSats, "createSatsInvoice"),
      memo,
    });
  }

  async createTokenInvoice(tokenIdentifier, amount, memo) {
    return await this.#wallet.createTokensInvoice({
      amount,
      tokenIdentifier,
      memo,
    });
  }

  // Paying a Spark invoice sends real sats/tokens to whoever created it — the
  // easiest artifact to hand a confused agent. So this path gets the same
  // scaffolding as every other outbound send: the allowlist gate (on the
  // receiver decoded from each invoice, enforced in dryRun mode too), strict
  // options, and a dryRun preview showing WHO gets paid before anything moves.
  async fulfillInvoice(invoices, { dryRun = false, ...rest } = {}) {
    rejectUnknownOptions("fulfillInvoice", rest);
    if (!Array.isArray(invoices)) {
      throw new Error(
        "SparkAgent.fulfillInvoice: pass an array of { invoice, amount } entries (see references/spark-invoices.md).",
      );
    }
    const allowlist = await loadRecipientsAllowlist();
    const sdkEntries = []; // what the SDK gets, built from the checked entries
    const entries = invoices.map((entry) => {
      const invoice = entry?.invoice;
      if (typeof invoice !== "string" || !invoice) {
        throw new Error(
          "SparkAgent.fulfillInvoice: every entry needs an `invoice` string — refusing to forward an entry whose receiver cannot be checked.",
        );
      }
      const receiver = sparkInvoiceReceiver(invoice, this.#network);
      assertSparkReceiverAllowed(receiver, invoice, allowlist);
      const embedded = receiver.invoiceFields?.paymentType;
      // Same doctrine as payLightningInvoice: the INVOICE's embedded amount
      // is the authoritative figure. A caller amount that disagrees with it
      // is a bug or an injected parameter — refuse rather than silently pick
      // one and preview/budget a number nobody pays. Token amounts stay
      // bigint base units (they pass 2^53, and the SDK takes bigint; a string
      // "100" used to reach it raw and be read as hex, 256 units).
      if (embedded?.type === "tokens") {
        const embeddedAmt = embedded.amount == null ? null : BigInt(embedded.amount);
        const callerAmt = entry.amount == null ? null : toTokenAmount(entry.amount, "fulfillInvoice", "entry amount");
        if (embeddedAmt !== null && callerAmt !== null && embeddedAmt !== callerAmt) {
          throw new Error(
            `SparkAgent.fulfillInvoice: entry amount (${callerAmt}) disagrees with the invoice's ` +
              `embedded amount (${embeddedAmt}). Omit the entry amount for amount-bearing invoices.`,
          );
        }
        sdkEntries.push(embeddedAmt === null && callerAmt !== null ? { invoice, amount: callerAmt } : { invoice });
        return { invoice, to: receiver.address, amount: String(embeddedAmt ?? callerAmt ?? "unknown"), type: "tokens" };
      }
      const embeddedAmt = embedded?.amount == null ? null : Number(embedded.amount);
      const callerAmt = entry.amount == null ? null : Number(entry.amount);
      if (embeddedAmt !== null && callerAmt !== null && embeddedAmt !== callerAmt) {
        throw new Error(
          `SparkAgent.fulfillInvoice: entry amount (${callerAmt}) disagrees with the invoice's ` +
            `embedded amount (${embeddedAmt}). Omit the entry amount for amount-bearing invoices.`,
        );
      }
      // The SDK gets an amount only for an amountless invoice, as bigint (the
      // check below has made sure it is a positive whole number of sats).
      sdkEntries.push(embeddedAmt === null && callerAmt !== null ? { invoice, sats: callerAmt } : { invoice });
      return {
        invoice,
        to: receiver.address,
        amount: String(embeddedAmt ?? callerAmt ?? "unknown"),
        type: embedded?.type ?? "unknown",
      };
    });
    // An invoice the SDK is certain to refuse is refused HERE, before the
    // ledger or the SDK, with one clear message: no payment type, no amount
    // anywhere (an amountless invoice needs the caller's), or a sats amount
    // that isn't a positive integer. Same rules the SDK applies, earlier.
    for (const e of entries) {
      const head = `SparkAgent.fulfillInvoice: invoice ${e.invoice.slice(0, 24)}…`;
      if (e.type === "unknown") throw new Error(`${head} names no payment type (sats or tokens), so it can't be paid.`);
      if (e.amount === "unknown") {
        throw new Error(`${head} has no amount — pass { invoice, amount } (${e.type === "tokens" ? "token base units, bigint" : "sats"}).`);
      }
      if (e.type === "sats" && !(Number.isSafeInteger(Number(e.amount)) && Number(e.amount) > 0)) {
        throw new Error(`${head}: the amount must be a positive integer of sats, got ${e.amount}.`);
      }
    }
    if (dryRun) {
      return {
        dryRun: true,
        operation: "fulfill_spark_invoice",
        from: await this.#wallet.getSparkAddress(),
        entries,
        network: this.#network,
      };
    }
    // Budget: sum the sats entries (token invoices aren't sats and are
    // bounded by the allowlist above, not the sat budget). A sats invoice
    // whose amount can't be read fails closed when a budget is set — a spend
    // the ledger can't count is a spend the budget can't bound.
    const satsTotal = entries.reduce((sum, e) => {
      if (e.type === "tokens") return sum;
      const n = Number(e.amount);
      return Number.isFinite(n) ? sum + n : NaN;
    }, 0);
    const spend = await this.#recordSpend(satsTotal, "fulfill_spark_invoice");
    let result;
    try {
      result = await this.#wallet.fulfillSparkInvoice(
        sdkEntries.map((e) => ("sats" in e ? { invoice: e.invoice, amount: BigInt(e.sats) } : e)),
      );
    } catch (err) {
      // A batch with tokens AND sats: the SDK sends the token transfer first,
      // then can fail the sats leg with a message that is on the pre-send list
      // ("Total target amount exceeds available balance"), although the tokens
      // already went (ToB review 2026-10-26). Such an error proves nothing.
      const mixed = entries.some((e) => e.type === "tokens") && entries.some((e) => e.type === "sats");
      throw await this.#spendFailed(err, spend, {
        method: "fulfillInvoice",
        op: "fulfill_spark_invoice",
        next: "Check agent.getTransfers() and agent.getTokenTransactions() before paying these invoices again.",
        provable: !mixed,
      });
    }
    // The SDK does not throw for a refused invoice: it RETURNS the failures.
    // Treating any return as success counted refused payments as paid (seen
    // on REGTEST: a paid-twice, an expired and a wrong-sender invoice). Read
    // the result:
    //   invalidInvoices — returned before ANY of the batch is sent (the SDK
    //     validates first and returns early), so nothing left: refund, throw.
    //   transaction errors — sending had begun; that failure doesn't prove
    //     nothing moved: the spend stays counted, and the caller gets
    //     PAYMENT_COMMITTED naming what did pay.
    // A token failure names its invoices as `invoices` (one transaction can pay several).
    const named = (f) => f.invoice ?? (f.invoices ?? []).join(",");
    const reasons = (list) => list.map((f) => `${String(named(f)).slice(0, 24)}…: ${f.error?.message ?? f.error ?? "unknown error"}`).join("; ");
    const invalid = result?.invalidInvoices ?? [];
    if (invalid.length) {
      await spend.undo().catch(() => {});
      const e = new Error(
        `SparkAgent.fulfillInvoice: the SDK refused ${invalid.length} invoice(s) before sending anything, so nothing was paid ` +
          `and the budget is untouched — ${reasons(invalid).slice(0, 400)}`,
      );
      e.code = "INVOICE_REFUSED";
      e.invalidInvoices = invalid.map((f) => ({ invoice: f.invoice, reason: String(f.error?.message ?? f.error ?? "") }));
      throw e;
    }
    const failed = [...(result?.satsTransactionErrors ?? []), ...(result?.tokenTransactionErrors ?? [])];
    if (failed.length) {
      const paid = [
        ...(result?.satsTransactionSuccess ?? []).map((x) => ({ invoice: x.invoice, id: x.transferResponse?.id })),
        ...(result?.tokenTransactionSuccess ?? []).flatMap((x) => (x.invoices ?? []).map((invoice) => ({ invoice, id: x.txid }))),
      ];
      const e = new PaymentCommittedError(
        `SparkAgent.fulfillInvoice: ${failed.length} invoice(s) failed after sending began, ${paid.length} paid. ` +
          `The failed ones' outcome is UNKNOWN — the whole spend stays counted against the budget. Do NOT pay them ` +
          `again with a new invoice, address or method; check agent.getTransfers() first. ${reasons(failed).slice(0, 400)}`,
        { settled: null, op: "fulfill_spark_invoice" },
      );
      e.paid = paid;
      e.failed = failed.flatMap((f) =>
        (f.invoice !== undefined ? [f.invoice] : f.invoices ?? [undefined]).map((invoice) => ({ invoice, reason: String(f.error?.message ?? f.error ?? "") })));
      throw e;
    }
    return result;
  }

  // --- Tokens ---

  // Token sends get the same input checks and failure rule as sats sends:
  // the token id must be this network's, the amount a positive integer of base
  // units, and an error that doesn't prove nothing left throws
  // PAYMENT_COMMITTED. (The sats budget doesn't count tokens.)
  async transferTokens({ tokenIdentifier, amount, to, dryRun = false, ...rest }) {
    rejectUnknownOptions("transferTokens", rest);
    if (!to) throw new Error("SparkAgent.transferTokens: `to` (the receiver's Spark address) is required.");
    const id = canonicalTokenId(tokenIdentifier, this.#network, "transferTokens");
    const units = toTokenAmount(amount, "transferTokens");
    await this.#assertAllowed(to);
    if (dryRun) {
      // The SDK's transferTokens refuses a Spark invoice ("Use fulfillSparkInvoice"), so the preview does too.
      this.#assertSparkRecipient("transferTokens", to);
      return {
        dryRun: true,
        operation: "token_transfer",
        from: await this.#wallet.getSparkAddress(),
        to,
        tokenIdentifier: id,
        amount: String(units),
        unit: "tokens",
        estimatedFee: "0", // Spark token transfers are free
        network: this.#network,
      };
    }
    try {
      return await this.#wallet.transferTokens({
        tokenIdentifier: id,
        tokenAmount: units,
        receiverSparkAddress: to,
      });
    } catch (err) {
      throw await this.#spendFailed(err, NO_SPEND, {
        method: "transferTokens",
        op: "token_transfer",
        next: "Look for this send among agent.getTokenTransactions() (newest first) before sending again: a new transfer is a second payment.",
      });
    }
  }

  // Allowlist applies to every receiver in the batch. One disallowed
  // recipient blocks the whole batch — that's the safer default. An entry
  // whose receiver can't be read can't be checked: fail CLOSED like
  // fulfillInvoice, never skip the gate for that entry.
  // Entries: { tokenIdentifier, tokenAmount (or amount), receiverSparkAddress
  // (or to) }. They reach the SDK normalized: before, an entry written with the
  // `to` alias passed the allowlist check, then went to the SDK with no
  // receiverSparkAddress. Unknown entry keys throw.
  async batchTransferTokens(transfers, { dryRun = false, ...rest } = {}) {
    rejectUnknownOptions("batchTransferTokens", rest);
    if (!Array.isArray(transfers) || transfers.length === 0) {
      throw new Error(
        "SparkAgent.batchTransferTokens: pass a non-empty array of { tokenIdentifier, tokenAmount, receiverSparkAddress } entries.",
      );
    }
    const outputs = transfers.map((t, i) => {
      const { tokenIdentifier, tokenAmount, amount, receiverSparkAddress, to, ...extra } = t ?? {};
      if (receiverSparkAddress !== undefined && to !== undefined && receiverSparkAddress !== to) {
        throw new Error(`SparkAgent.batchTransferTokens: entry ${i} names two different recipients (receiverSparkAddress and to) — pass one.`);
      }
      const receiver = receiverSparkAddress ?? to;
      if (!receiver) {
        throw new Error(
          "SparkAgent.batchTransferTokens: every entry needs a recipient (receiverSparkAddress) — " +
            "refusing to forward an entry whose receiver cannot be checked.",
        );
      }
      rejectUnknownOptions(`batchTransferTokens (entry ${i})`, extra);
      if (tokenAmount !== undefined && amount !== undefined) {
        throw new Error(`SparkAgent.batchTransferTokens: entry ${i} sets both tokenAmount and amount — pass one.`);
      }
      return {
        tokenIdentifier: canonicalTokenId(tokenIdentifier, this.#network, "batchTransferTokens"),
        tokenAmount: toTokenAmount(tokenAmount ?? amount, "batchTransferTokens", `entry ${i} tokenAmount`),
        receiverSparkAddress: receiver,
      };
    });
    for (const o of outputs) await this.#assertAllowed(o.receiverSparkAddress);
    if (dryRun) {
      for (const o of outputs) this.#assertSparkRecipient("batchTransferTokens", o.receiverSparkAddress, { allowInvoice: true });
      return {
        dryRun: true,
        operation: "token_transfer",
        from: await this.#wallet.getSparkAddress(),
        entries: outputs.map((o) => ({ to: o.receiverSparkAddress, tokenIdentifier: o.tokenIdentifier, amount: String(o.tokenAmount) })),
        totals: tokenTotals(outputs.map((o) => ({ tokenIdentifier: o.tokenIdentifier, amount: o.tokenAmount }))),
        unit: "tokens",
        estimatedFee: "0", // Spark token transfers are free
        network: this.#network,
      };
    }
    try {
      return await this.#wallet.batchTransferTokens(outputs);
    } catch (err) {
      throw await this.#spendFailed(err, NO_SPEND, {
        method: "batchTransferTokens",
        op: "token_transfer",
        next: "Look for this batch among agent.getTokenTransactions() (newest first) before sending again: a new batch is a second payment.",
      });
    }
  }

  // --- Deposits (claim to Spark) ---

  // Claim a confirmed L1 deposit into Spark balance with a SERVER-ENFORCED fee
  // ceiling: the SDK's claimStaticDepositWithMaxFee rejects the claim if the SSP's
  // fee (its spread for sweeping the UTXO on-chain) exceeds the ceiling.
  //
  // The default ceiling is SIZE-AWARE: maxFeePct (default 10%) of the quoted
  // credit, and never above CLAIM_MAX_FEE_SATS — the same posture as
  // withdraw(). The old flat 5,000-sat default
  // authorized the SSP to take 83% of a 6,000-sat deposit without a peep. An
  // explicit maxFeeSats still wins as an absolute cap; with neither a readable
  // quote nor an explicit cap the claim FAILS CLOSED rather than picking a
  // number for a deposit whose size it cannot see. dryRun previews the quoted
  // credit and the ceiling that would be enforced, without claiming.
  //
  // It claims only a deposit the operators list, unclaimed, at this wallet's
  // STATIC address, and looks that up itself rather than trusting the caller.
  // The SSP claims static deposits only, yet it quotes a single-use one as if
  // it would claim it (a 2,000-sat mainnet single-use deposit quoted a
  // 1,703-sat credit, 2026-10-26), so without the lookup a dry run promised
  // money and the claim then failed with "Static deposit address … not found".
  async claimDeposit({ txid, vout = 0, maxFeeSats, maxFeePct = 10, dryRun = false, ...rest }) {
    rejectUnknownOptions("claimDeposit", rest);
    if (typeof txid !== "string" || !/^[0-9a-fA-F]{64}$/.test(txid)) {
      throw new TypeError(`SparkAgent.claimDeposit: txid must be a 64-character hex transaction id, got ${JSON.stringify(txid)}.`);
    }
    if (!Number.isSafeInteger(vout) || vout < 0) {
      throw new TypeError(`SparkAgent.claimDeposit: vout must be a non-negative integer, got ${JSON.stringify(vout)}.`);
    }
    // Garbage ceiling values throw here (requireNumericOption): a NaN maxFee
    // passed to the SDK never trips its `feeCharged > maxFee` check, which
    // would silently remove the ceiling entirely.
    const explicit = requireNumericOption("claimDeposit", "maxFeeSats", maxFeeSats) ?? null;
    const pct = requireNumericOption("claimDeposit", "maxFeePct", maxFeePct) ?? 10;
    if (pct < 0 || pct > 100) throw new RangeError(`SparkAgent.claimDeposit: maxFeePct must be between 0 and 100, got ${pct}.`);
    if (explicit !== null && explicit < 0) throw new RangeError(`SparkAgent.claimDeposit: maxFeeSats must not be negative, got ${explicit}.`);
    const type = await this.#depositType(txid, vout);
    if (type === "single-use") {
      const e = new Error(
        `SparkAgent.claimDeposit: ${txid}:${vout} is a single-use deposit. The operators currently refuse to claim ` +
          "those (finalize_deposit_tree_creation UNAVAILABLE), so it stays at its address until they switch the step " +
          "back on, and only this wallet's keys can claim it then: keep the recovery words backed up. " +
          "Nothing was spent or changed.",
      );
      e.code = "SINGLE_USE_DEPOSITS_UNAVAILABLE";
      throw e;
    }
    if (type === null) {
      const e = new Error(
        `SparkAgent.claimDeposit: ${txid}:${vout} isn't an unclaimed deposit at this wallet's deposit address. ` +
          "It may need more confirmations (the claim needs 3), be claimed already, or have another vout; this " +
          "doesn't mean the coins went elsewhere. listPendingDeposits() lists what can be claimed. Nothing was spent or changed.",
      );
      e.code = "DEPOSIT_NOT_FOUND";
      throw e;
    }
    let cap = explicit;
    let credit = null;
    if (cap === null || dryRun) {
      const quote = await this.#wallet.getClaimStaticDepositQuote(txid, vout);
      // Number(null) === 0 — a missing credit must read as unreadable, not as
      // a zero-sat deposit (the same trap checkL402Amount documents).
      const quoted = quote?.creditAmountSats == null ? NaN : Number(quote.creditAmountSats);
      credit = Number.isFinite(quoted) ? quoted : null;
      if (cap === null) {
        if (credit === null) {
          throw new Error(
            "SparkAgent.claimDeposit: the claim quote is unreadable, so a size-aware fee ceiling " +
              "cannot be derived — pass an explicit maxFeeSats to claim anyway.",
          );
        }
        cap = Math.min(Math.ceil((credit * pct) / 100), CLAIM_MAX_FEE_SATS);
      }
    }
    if (dryRun) {
      return {
        dryRun: true,
        operation: "claim_deposit",
        txid,
        vout,
        creditSats: credit !== null ? String(credit) : "unknown",
        maxFeeSats: String(cap),
        network: this.#network,
      };
    }
    return await this.#wallet.claimStaticDepositWithMaxFee({
      transactionId: txid,
      maxFee: cap,
      outputIndex: vout,
    });
  }

  // --- Withdrawal ---

  async getWithdrawalFeeQuote(amountSats, onchainAddress) {
    return await this.#wallet.getWithdrawalFeeQuote({
      amountSats: toSats(amountSats, "getWithdrawalFeeQuote"),
      withdrawalAddress: onchainAddress,
    });
  }

  // Cooperative exit back to L1 Bitcoin. Allowlist applies to `to` (L1 BTC
  // address). dryRun returns the fee quote without broadcasting.
  async withdraw({ to, amount, speed = "MEDIUM", maxFeeSats, maxFeePct = 10, dryRun = false, ...rest }) {
    rejectUnknownOptions("withdraw", rest);
    // Garbage ceiling values throw BEFORE any I/O (requireNumericOption) — a
    // non-finite cap would silently disable the ceiling below, and the quote
    // fetch itself is not side-effect-free (it can restructure leaves).
    const pct = requireNumericOption("withdraw", "maxFeePct", maxFeePct) ?? 10;
    if (pct < 0 || pct > 100) throw new RangeError(`SparkAgent.withdraw: maxFeePct must be between 0 and 100, got ${pct}.`);
    const abs = requireNumericOption("withdraw", "maxFeeSats", maxFeeSats);
    await this.#assertAllowed(to);
    const sats = toSats(amount, "withdraw"); // number|bigint -> safe-int Number (SDK rejects bigint)
    const quote = await this.#wallet.getWithdrawalFeeQuote({
      amountSats: sats,
      withdrawalAddress: to,
    });
    // Total exit fee = userFee + l1BroadcastFee for the chosen speed. Ceiling:
    // reject an exit whose fee exceeds maxFeePct (default 10%) of the amount or an
    // absolute maxFeeSats — which legibly refuses uneconomical small withdrawals,
    // consistent with "discourage sub-25k-sat exits".
    const fee = withdrawalTotalFee(quote, speed);
    const pctCap = Number.isFinite(sats) ? Math.ceil((sats * pct) / 100) : Infinity;
    const absCap = abs ?? Infinity;
    const cap = Math.min(pctCap, absCap);
    // Unlike the Lightning/L402/claim paths — which hand the SDK a SERVER-enforced
    // maxFee — the executed withdraw binds to `feeQuote` below. So an UNREADABLE quote
    // means we cannot confirm the fee is within the ceiling; fail CLOSED rather than
    // defer to an SDK cap that does not exist for this path.
    const check = (fee == null && Number.isFinite(cap))
      ? { ok: false, fee: null, cap, reason: `fee quote is unreadable — cannot verify it is within the ${cap}-sat ceiling` }
      : checkFeeAgainstCap(fee, cap);
    if (dryRun) {
      return {
        dryRun: true,
        operation: "l1_withdraw",
        from: await this.#wallet.getSparkAddress(),
        to,
        amount: String(sats),
        unit: "sats",
        estimatedFee: fee != null ? String(fee) : "unknown",
        maxFeeSats: Number.isFinite(cap) ? String(cap) : null,
        withinCap: check.ok,
        capReason: check.reason,
        speed,
        network: "bitcoin",
        quote, // raw SDK quote, in case caller needs per-speed breakdown
      };
    }
    if (!check.ok) {
      const detail = check.fee != null
        ? ` (${((check.fee / sats) * 100).toFixed(1)}% of the ${sats}-sat exit). Raise maxFeeSats/maxFeePct to override.`
        : `. Re-fetch the quote or check the SDK CoopExitFeeQuote shape.`;
      throw new Error(`Withdrawal blocked: ${check.reason}${detail}`);
    }
    // Budget counts amount + the vetted fee — both leave the wallet on an exit.
    const spend = await this.#recordSpend(sats + (check.fee ?? 0), "l1_withdraw");
    let result;
    try {
      // Bind the executed exit to the SAME quote we just vetted, so the operator
      // charges the quoted fee we checked rather than re-pricing at broadcast
      // (closes the TOCTOU gap). feeQuoteId + feeAmountSats is the current SDK
      // API; the `feeQuote` object param does the same but is @deprecated — kept
      // only as the fallback when our reader couldn't extract a scalar fee.
      result = await this.#wallet.withdraw({
        onchainAddress: to,
        exitSpeed: speed,
        amountSats: sats,
        ...(check.fee != null && quote?.id
          ? { feeQuoteId: quote.id, feeAmountSats: check.fee }
          : { feeQuote: quote }),
      });
    } catch (err) {
      throw await this.#spendFailed(err, spend, {
        method: "withdraw",
        op: "l1_withdraw",
        next: "Check agent.getTransfers() and the coop exit status before withdrawing again: a new exit is a second payment.",
      });
    }
    // The SDK moves the leaves BEFORE it asks the SSP for the exit record, and
    // types that record as nullable. Without one the caller would crash on
    // result.coopExitTxid after the money left, and a retry would exit twice.
    // The spend stays recorded: the sats are gone.
    if (!result) {
      // A PaymentCommittedError like every other "money may have left" case,
      // so code that checks for PAYMENT_COMMITTED stops here instead of
      // retrying into a second exit.
      const err = new PaymentCommittedError(
        `SparkAgent.withdraw: the exit was sent, but the SSP returned no record of it. ` +
        `Do NOT retry, that would withdraw again. Find it with getTransfers().`,
        { settled: null, op: "l1_withdraw" },
      );
      err.paid = true;
      throw err;
    }
    return result;
  }

  // --- Message Signing ---

  async signMessage(text) {
    return await this.#wallet.signMessageWithIdentityKey(text);
  }

  // Validates that `text`+`signature` was signed by THIS agent's own identity
  // key. To verify a signature from another party, use secp256k1.verify from
  // @noble/curves directly with their public key.
  async verifyOwnSignature(text, signature) {
    return await this.#wallet.validateMessageWithIdentityKey(text, signature);
  }

  // --- L402 paywalls (see references/l402.md) ---

  async fetchL402(url, options = {}) {
    const { decode } = await import("light-bolt11-decoder");
    const { method = "GET", headers = {}, body, maxFeeSats, maxAmountSats = 10_000, resend = false, ...rest } = options;
    // Same strictness as every other money-moving method: an ignored option
    // here is not cosmetic. `fetchL402(url, { dryRun: true })` used to PAY —
    // the exact phantom-dryRun failure the wrapper exists to prevent.
    rejectUnknownOptions("fetchL402", rest);
    assertHttpsUrl("fetchL402", url);
    if (typeof resend !== "boolean") throw new TypeError(`SparkAgent.fetchL402: resend must be true or false, got ${JSON.stringify(resend)}.`);
    // Garbage ceiling values throw BEFORE any network I/O (requireNumericOption).
    const maxFee = requireNumericOption("fetchL402", "maxFeeSats", maxFeeSats);
    const maxAmt = requireNumericOption("fetchL402", "maxAmountSats", maxAmountSats) ?? 10_000;
    const reqBody = body ? JSON.stringify(body) : undefined;
    const request = { method, headers, reqBody, resend };

    // An earlier call in this process already paid, or may have paid, for
    // exactly this request: finish that purchase, don't make another.
    const key = l402RequestKey(method, url);
    const held = this.#l402Held.get(key);
    if (held) {
      const resumed = await this.#resumeL402(url, key, held, request);
      if (resumed) return resumed;
      // null: that payment failed for good, so no money left — buying below is safe.
    }

    const initialResponse = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: reqBody,
    });

    if (initialResponse.status !== 402) {
      const ct = initialResponse.headers.get("content-type") || "";
      const data = ct.includes("json") ? await initialResponse.json() : await initialResponse.text();
      return { paid: false, data };
    }

    // Header first (spec-compliant), body fallback — see parseL402Challenge.
    const { invoice, macaroon } = await parseL402Challenge(initialResponse);
    if (!invoice || !macaroon) throw new Error("Invalid L402 challenge");

    // A pass the server has already declared dead buys nothing. The invoice
    // expires separately, so it can still be paid after the token's expiry
    // caveat has passed — and the retry is then refused with the sats gone.
    // Refuse up front. An undecodable token is not a reason to block: opaque
    // tokens exist, and null means "no information".
    const tokenExpiry = l402TokenExpiry(macaroon)?.expiresAt ?? null;
    const nowSec = Date.now() / 1000;
    if (tokenExpiry !== null && tokenExpiry - nowSec < L402_MIN_TOKEN_LIFETIME_SECONDS) {
      const err = new Error(
        `L402 payment blocked: the server's token ${tokenExpiry <= nowSec ? "expired" : "expires"} at ` +
        `${new Date(tokenExpiry * 1000).toISOString()} — paying now would buy a pass the server itself says ` +
        `is dead or about to be. Request the resource again for a fresh challenge.`,
      );
      err.code = "L402_TOKEN_EXPIRED";
      throw err;
    }

    const decoded = decode(invoice);
    const amountSection = decoded.sections.find((s) => s.name === "amount");
    const amountSats = amountSection?.value ? Math.ceil(Number(amountSection.value) / 1000) : null;

    // Bound the invoice AMOUNT, not just the routing fee — a malicious/compromised
    // paywall can demand an arbitrarily large invoice, and fetchL402 re-fetches a
    // fresh 402 challenge (so previewL402's price is NOT authoritative). Also
    // refuses an amountless invoice. Raise maxAmountSats for pricier resources.
    const amtCheck = checkL402Amount({ amountSats, maxAmountSats: maxAmt });
    if (!amtCheck.ok) throw new Error(`L402 payment blocked: ${amtCheck.reason}. Raise maxAmountSats to override.`);

    // Route through the guarded wrapper so the payment also gets the amount-aware
    // routing-fee cap (maxFeeSats undefined => sized from the invoice amount).
    // payAndSettle owns the poll loop: it throws on every terminal failure
    // status and reports { settled: false } on timeout instead of throwing —
    // because after this line the money is GONE. A thrown timeout invites a
    // retry that pays the invoice a second time. Over Lightning only: the
    // preimage IS the credential, and a Spark-direct payment returns none.
    const payOptions = { maxFeeSats: maxFee, maxAmountSats: maxAmt, preferSpark: false, [LN_NO_FEE_READS]: true };
    const { host, path } = l402Target(url);
    if (this.#l402Held.size >= L402_MAX_HELD) {
      throw new Error(
        `L402 payment blocked: this agent holds ${this.#l402Held.size} unresolved L402 purchases (undelivered, in doubt or ` +
          `refused), the most it keeps. Nothing was paid. Resolve them (call fetchL402 again for each) or, on the user's ` +
          `say-so, agent.forgetL402(url).`,
      );
    }
    let payResult;
    try {
      payResult = await this.payAndSettle(invoice, payOptions);
    } catch (err) {
      // A payment that may have gone through must not leave this purchase
      // unrecorded: the natural retry fetches a NEW challenge, a new invoice,
      // and pays again (ToB review 2026-10-26). Hold it, so the next call for
      // this request settles THIS invoice instead. A refusal before paying
      // (amount or fee cap, budget, an SDK pre-send check) is rethrown as is.
      if (err?.code !== "PAYMENT_COMMITTED" && err?.code !== "PAYMENT_ALREADY_SETTLED") throw err;
      this.#holdL402(key, { macaroon, invoice, amountSats, sendId: err.sendId ?? null, preimage: null, payOptions });
      const e = new PaymentCommittedError(
        `L402: the payment for ${host}${path} may have gone through (${String(err.message).slice(0, 160)}). ` +
        `Do NOT buy this resource again another way. ` +
        (err.sendId || this.#lnDedup
          ? `Call fetchL402 with the same URL again in this process: it finishes THIS payment and presents its proof, without paying again.`
          : `SPARK_LN_DEDUP is off, so this agent can't safely settle it again: check agent.getTransfers().`),
        { settled: err.code === "PAYMENT_ALREADY_SETTLED" ? true : null, op: "l402", sendId: err.sendId, invoiceHash: invoicePaymentHash(invoice) ?? undefined, cause: err },
      );
      e.paid = true;
      throw e;
    }
    const preimage = payResult.paymentPreimage;
    if (!preimage) {
      this.#holdL402(key, { macaroon, invoice, amountSats, sendId: payResult.id, preimage: null, payOptions });
      const err = new PaymentCommittedError(
        `L402 invoice PAID but no preimage yet (status ${payResult.lastStatus ?? "unknown"}). ` +
        `Do NOT buy this resource again another way. Call fetchL402 with the same URL again in this ` +
        `process: it checks this payment and presents its proof instead of paying.`,
        { settled: null, op: "l402", sendId: payResult.id, invoiceHash: invoicePaymentHash(invoice) ?? undefined },
      );
      err.paid = true; // kept for callers written against the earlier error shape
      err.macaroon = macaroon; // not a working pass without the preimage
      throw err;
    }
    return this.#deliverL402(url, key, { macaroon, preimage, amountSats, invoiceHash: invoicePaymentHash(invoice) ?? undefined }, request, { recovered: false });
  }

  // Lets this agent buy `url` again after fetchL402 stopped doing so: the
  // service refused the pass it paid for, the pass died before a doubtful
  // payment could be settled, or a payment ended with no proof. Only on the
  // user's say-so: if the earlier payment went through, the next fetchL402
  // for this URL is a second purchase. Also drops a held, undelivered pass.
  // Returns whether anything was held.
  forgetL402(url, { method = "GET" } = {}) {
    return this.#l402Held.delete(l402RequestKey(method, url));
  }

  // Present a paid pass and return the resource. The money is already gone,
  // so a failure in transit or a 5xx is retried with the SAME pass — a fresh
  // challenge would be a new invoice. If every attempt fails, the pass is held
  // for the next call in this process and a PaymentCommittedError (settled:
  // true) is thrown. A request that isn't safe to repeat (POST, PATCH) is sent
  // once, and sent again only with { resend: true }: the service may already
  // have acted on it. A 401 or 402 means the service refused a paid pass;
  // any other status is its answer, returned as is with `status`.
  async #deliverL402(url, key, pass, { method, headers, reqBody }, { recovered }) {
    const { host, path } = l402Target(url);
    const repeatable = L402_REPEATABLE.has(String(method).toUpperCase());
    const attempts = repeatable ? L402_DELIVERY_ATTEMPTS : 1;
    let failure;
    let tried = 0;
    for (let attempt = 1; attempt <= attempts; attempt++) {
      tried = attempt;
      if (attempt > 1) await new Promise((r) => setTimeout(r, L402_DELIVERY_BACKOFF_MS * (attempt - 1)));
      let res;
      try {
        res = await fetch(url, {
          method,
          // Authorization last: a caller-supplied header must not clobber the
          // L402 proof we paid for (that would pay and then not present it).
          headers: { ...headers, "Authorization": `L402 ${pass.macaroon}:${pass.preimage}` },
          body: reqBody,
        });
      } catch (err) {
        failure = err?.message ?? String(err);
        continue;
      }
      if (L402_RETRY_STATUS(res.status)) {
        failure = `HTTP ${res.status}`;
        await res.text().catch(() => "");
        continue;
      }
      if (res.status === 401 || res.status === 402) {
        // The service refused a pass it was paid for. Its body may hold a NEW
        // challenge; paying that is a second purchase. Remember the refusal,
        // so a retry loop gets this error again instead of buying.
        await res.text().catch(() => "");
        const blocked = {
          reason: "L402_PASS_REFUSED",
          settled: true,
          status: res.status,
          invoiceHash: pass.invoiceHash ?? (pass.invoice ? invoicePaymentHash(pass.invoice) ?? undefined : undefined),
          amountSats: pass.amountSats ?? null,
          message:
            `L402: ${host}${path} refused the pass this agent paid ${pass.amountSats ?? "?"} sats for (HTTP ${res.status}). ` +
            `Do NOT pay its new challenge: that buys the resource a second time. Take it up with the service; the ` +
            `error's invoiceHash identifies the payment. This agent won't buy ${host}${path} again on its own; ` +
            `${forgetHint(method)} allows it, on the user's say-so.`,
        };
        this.#holdL402(key, { blocked });
        throw l402BlockedError(blocked);
      }
      const data = await readBody(res);
      this.#l402Held.delete(key);
      return {
        paid: !recovered, // false when this call delivered a pass an earlier call bought
        ...(recovered ? { recovered: true } : {}),
        status: res.status,
        amountSats: pass.amountSats,
        macaroon: pass.macaroon,
        preimage: pass.preimage,
        data,
      };
    }
    this.#holdL402(key, {
      macaroon: pass.macaroon,
      preimage: pass.preimage,
      amountSats: pass.amountSats,
      invoiceHash: pass.invoiceHash ?? (pass.invoice ? invoicePaymentHash(pass.invoice) ?? undefined : undefined),
      ...(repeatable ? {} : { sentOnce: true, reqBody }),
    });
    const e = new PaymentCommittedError(
      `L402: paid ${pass.amountSats ?? "?"} sats for ${host}${path} but the resource was not delivered ` +
      `after ${tried} attempt${tried === 1 ? "" : "s"} (${failure}). The pass is kept in this process. ` +
      (repeatable
        ? `Call fetchL402 with the same URL again to present it without paying. `
        : `The ${String(method).toUpperCase()} was sent and the service may have acted on it: check with the service. ` +
          `To send it again with the same pass (no new payment), call fetchL402 with { resend: true }. `) +
      `Do NOT buy this resource another way.`,
      { settled: true, op: "l402" },
    );
    e.paid = true;
    throw e;
  }

  // A held L402 purchase from an earlier call: finish it instead of buying
  // again. Returns the delivered result, throws while it can't be finished
  // (always a PaymentCommittedError: money may have left), or returns null
  // once the payment has failed for good (no money left, buying is safe).
  async #resumeL402(url, key, held, request) {
    const { host, path } = l402Target(url);
    if (held.blocked) throw l402BlockedError(held.blocked);
    const invoiceHash = held.invoiceHash ?? (held.invoice ? invoicePaymentHash(held.invoice) ?? undefined : undefined);
    const pending = (detail, extra = {}) =>
      Object.assign(
        new PaymentCommittedError(
          `L402: the earlier payment for ${host}${path} ${detail} Nothing new was paid. ` +
          `Do NOT buy this resource another way.`,
          { settled: null, op: "l402", invoiceHash, ...extra },
        ),
        { paid: true },
      );
    const block = (blocked) => {
      this.#holdL402(key, { blocked });
      return l402BlockedError(blocked);
    };

    if (!held.preimage && !held.sendId) {
      // The earlier pay call failed ambiguously, so there is no send id to ask
      // about. Settle THIS invoice again: with the dedup store its persisted
      // transferId makes the operators refuse a second payment (the Lightning
      // rail replays the original result). Without the store that would be a
      // double-pay gamble, so refuse and say what to check.
      if (!this.#lnDedup) {
        throw pending(`may have gone through, and SPARK_LN_DEDUP is off, so settling it again could pay twice. Check agent.getTransfers().`);
      }
      // If that first payment never happened, settling now is the real
      // purchase: don't make it for a pass the service has declared dead.
      const tokenExpiry = l402TokenExpiry(held.macaroon)?.expiresAt ?? null;
      if (tokenExpiry !== null && tokenExpiry - Date.now() / 1000 < L402_MIN_TOKEN_LIFETIME_SECONDS) {
        throw block({
          reason: "L402_PASS_EXPIRED",
          settled: null,
          message:
            `L402: the earlier payment for ${host}${path} may have gone through, but the service's pass ` +
            `expires at ${new Date(tokenExpiry * 1000).toISOString()}, so settling it now could buy a dead pass. ` +
            `Nothing new was paid; check agent.getTransfers(). This agent won't buy ${host}${path} again on its own; ` +
            `${forgetHint(request.method)} allows it, on the user's say-so (a second purchase if the first payment went through).`,
          invoiceHash,
          amountSats: held.amountSats ?? null,
        });
      }
      let settled;
      try {
        // The spend was counted when this purchase was first attempted.
        settled = await this.payAndSettle(held.invoice, { ...held.payOptions, [LN_RESUMING]: true });
      } catch (err) {
        if (err?.code === "LIGHTNING_PAYMENT_FAILED") {
          // The operators' record of this payment ended in failure: no money left.
          this.#l402Held.delete(key);
          return null;
        }
        if (err?.reason === "INVOICE_EXPIRED_AFTER_ATTEMPT" || err?.code === "INVOICE_EXPIRED") {
          // The invoice died before the doubtful payment could be settled
          // again, so settling it can't tell us whether it went through.
          throw block({
            reason: "L402_INVOICE_EXPIRED",
            settled: null,
            message:
              `L402: the earlier payment for ${host}${path} may have gone through, but its invoice has expired, so ` +
              `it can't be settled again to find out. Nothing new was paid; check agent.getTransfers(). This agent ` +
              `won't buy ${host}${path} again on its own; ${forgetHint(request.method)} allows it, on the user's say-so ` +
              `(a second purchase if the first payment went through).`,
            invoiceHash,
            amountSats: held.amountSats ?? null,
          });
        }
        if (err?.sendId) held.sendId = err.sendId;
        throw pending(
          `may have gone through; settling it again failed (${String(err?.message ?? err).slice(0, 160)}). ` +
          `Call fetchL402 again later, or check agent.getTransfers().`,
          { sendId: held.sendId ?? undefined, cause: err },
        );
      }
      if (!settled.paymentPreimage) {
        if (settled.id) held.sendId = settled.id;
        throw pending(`is still pending (status ${settled.lastStatus ?? "unknown"}). Call fetchL402 again later.`, { sendId: settled.id });
      }
      held.preimage = settled.paymentPreimage;
    }
    if (!held.preimage) {
      let status;
      try {
        status = await this.#wallet.getLightningSendRequest(held.sendId);
      } catch (err) {
        throw pending(`can't be checked right now (${String(err?.message ?? err).slice(0, 160)}). Call fetchL402 again later.`, { sendId: held.sendId, cause: err });
      }
      if (status?.paymentPreimage) {
        // Same proof check as payAndSettle: a preimage settles THIS invoice
        // only if it hashes to the invoice's payment hash.
        const got = createHash("sha256").update(Buffer.from(status.paymentPreimage, "hex")).digest("hex");
        if (!invoiceHash || got !== invoiceHash) {
          throw block({
            reason: "L402_NO_PROOF",
            settled: null,
            message:
              `L402: the earlier payment for ${host}${path} came back with a preimage that does NOT prove THIS invoice ` +
              `(sha256(preimage) = ${got}, invoice = ${invoiceHash ?? "unreadable"}), so there is no pass to present. ` +
              `Check agent.getTransfers(). This agent won't buy ${host}${path} again on its own; ${forgetHint(request.method)} allows it, on the user's say-so.`,
            invoiceHash,
            sendId: held.sendId,
            amountSats: held.amountSats ?? null,
          });
        }
        held.preimage = status.paymentPreimage;
      } else if (isTerminalLightningFailure(status?.status)) {
        this.#l402Held.delete(key);
        if (this.#lnDedup) await this.#lnDedup.forget(held.invoice);
        return null;
      } else if (PAYEE_MAYBE_PAID_STATUSES.has(status?.status)) {
        // The Lightning leg succeeded, so the service may have been paid, but
        // no preimage came back: there is no pass, and this won't change.
        throw block({
          reason: "L402_NO_PROOF",
          settled: null,
          message:
            `L402: the earlier payment for ${host}${path} ended in ${status.status}: the service may have been paid, ` +
            `but no proof came back, so there is no pass to present. Take it up with the service; check agent.getTransfers(). ` +
            `This agent won't buy ${host}${path} again on its own; ${forgetHint(request.method)} allows it, on the user's say-so.`,
          invoiceHash,
          sendId: held.sendId,
          amountSats: held.amountSats ?? null,
        });
      } else {
        throw pending(`is still pending (status ${status?.status ?? "unknown"}). Call fetchL402 again later.`, { sendId: held.sendId });
      }
    }
    if (held.sentOnce && request.resend && request.reqBody !== held.reqBody) {
      throw new TypeError(
        `SparkAgent.fetchL402: { resend: true } sends the original ${String(request.method).toUpperCase()} again, and this ` +
          `call's body differs from it. Pass the same body, or check with the service before buying anything new.`,
      );
    }
    if (held.sentOnce && !request.resend) {
      const e = new PaymentCommittedError(
        `L402: the ${String(request.method).toUpperCase()} to ${host}${path} was already sent once with the pass ` +
        `this agent paid for, and the service may have acted on it. Check with the service. To send it again ` +
        `with the same pass (no new payment), call fetchL402 with { resend: true }.`,
        { settled: true, op: "l402" },
      );
      e.paid = true;
      throw e;
    }
    return this.#deliverL402(url, key, held, request, { recovered: true });
  }

  // Never evicts: a dropped hold or block lets the next call buy that URL again
  // on nobody's say-so (ToB reviews of 7ec89b9 and of 9bc0f22..f88fbec). The
  // map is bounded by fetchL402 refusing new purchases at L402_MAX_HELD.
  #holdL402(key, entry) {
    this.#l402Held.delete(key);
    this.#l402Held.set(key, entry);
  }

  async previewL402(url) {
    assertHttpsUrl("previewL402", url);
    const response = await fetch(url);
    if (response.status !== 402) return { requiresPayment: false };

    const { decode } = await import("light-bolt11-decoder");
    const { invoice, macaroon } = await parseL402Challenge(response); // header first, body fallback
    if (!invoice) throw new Error("Invalid L402 challenge: no invoice in header or body");
    const decoded = decode(invoice);
    const amountSection = decoded.sections.find((s) => s.name === "amount");
    if (!amountSection?.value) throw new Error("L402 invoice has no amount");

    const tokenExpiry = l402TokenExpiry(macaroon)?.expiresAt ?? null;
    return {
      requiresPayment: true,
      amountSats: Math.ceil(Number(amountSection.value) / 1000),
      invoice,
      macaroon,
      // When the server says the pass dies (ISO), or null: no expiry caveat, or
      // an opaque token. fetchL402 refuses to pay with less than
      // L402_MIN_TOKEN_LIFETIME_SECONDS (120 s) left.
      tokenExpiresAt: tokenExpiry === null ? null : new Date(tokenExpiry * 1000).toISOString(),
    };
  }

  // --- Events ---

  onTransferReceived(callback) {
    this.#wallet.on("transfer:claimed", callback);
  }

  onDepositConfirmed(callback) {
    this.#wallet.on("deposit:confirmed", callback);
  }

  // Recovery-backup health: { healthy, lastSuccessAt, consecutiveFailures,
  // lastError, anchorless }, or { disabled: true } when opted out via
  // SPARK_LEAF_VAULT. A non-empty `anchorless` makes it unhealthy.
  vaultHealth() {
    return this.#vault?.health?.() ?? { disabled: true };
  }

  // --- Lifecycle ---

  async cleanup() {
    // The vault flush below waits for the leaf-vault's OWN snapshot, but it
    // cannot make the SDK's background leaf optimizer finish — cleanup() tears
    // down the gRPC streams underneath it. If this agent moved value and is a
    // one-shot process, prefer SparkAgent.create(..., { optimizeLeaves: false })
    // so there's no in-flight optimization to interrupt. See references/wallet.md.
    await this.#vault?.dispose?.(); // first: the final flush needs the live wallet
    await this.#wallet.cleanup();
  }
}

// --- Demo ---

async function main() {
  await import("dotenv/config"); // the demo reads SPARK_PASSPHRASE from ./.env; the library never does
  const network = process.env.SPARK_NETWORK || "MAINNET";
  const mnemonic = await loadMnemonicFromEnv();
  const { agent } = await SparkAgent.create(mnemonic, network);

  const identity = await agent.getIdentity();
  console.log("=== Agent Identity ===");
  console.log("Spark Address:", identity.address);
  console.log("Public Key:   ", identity.publicKey);

  const { sats, tokens } = await agent.getBalance();
  console.log("\n=== Balance ===");
  console.log("BTC:", sats.toString(), "sats");

  for (const [, info] of Object.entries(tokens)) {
    console.log(`${info.ticker}: ${info.balance}`);
  }

  const depositAddr = await agent.getDepositAddress();
  console.log("\n=== Deposit ===");
  console.log("Send BTC to:", depositAddr);

  console.log("\n=== Lightning Invoice ===");
  const bolt11 = await agent.createLightningInvoice(1000, "SparkAgent test");
  console.log("BOLT11:", bolt11);

  await agent.cleanup();
}

// Run the demo only when executed directly (`node spark-agent.js`), so the
// SparkAgent class can be imported by other code without side effects.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
