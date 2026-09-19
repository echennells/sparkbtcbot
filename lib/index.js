// Public entry point for `npm install sparkbtcbot-skill`.
//
// Two flavors of export:
//   1. The encryption library (saveEncryptedMnemonic, loadMnemonic, etc.)
//      Used by code an LLM agent generates when it needs a Spark wallet.
//   2. Skill-content helpers (getSkillContent, getReference, ...) for
//      non-Claude LLM frameworks (Cursor, LangChain, OpenAI Agents SDK,
//      Aider, etc.) — load the skill's instructions into the LLM's
//      context however your framework supports it.
//
// Claude Code users do NOT need to npm-install this. They use the plugin
// marketplace path documented in the README. This package is for everyone
// else.

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// --- 1. Encryption library re-exports ---
export {
  saveEncryptedMnemonic,
  loadMnemonic,
  loadMnemonicFromEnv,
  loadSeedPayload,
  loadSeedPayloadFromEnv,
  getLoadedSeedContext,
  validateSeedPolicy,
  rekeyEncryptedSeed,
  deriveLedgerHmacKey,
  DEFAULT_SEED_PATH,
} from "./encrypted-seed.js";
export {
  validatePolicyObject,
  evaluatePolicy,
  evaluateDeclarativeRules,
  runPolicyExec,
  sha256File,
  PolicyDeniedError,
  POLICY_OPS,
  OUTBOUND_OPS,
  POLICY_EXEC_TIMEOUT_MS,
} from "./policy.js";
export { createAuditLog, auditLogFromEnv, DEFAULT_AUDIT_LOG_PATH } from "./audit-log.js";

// --- 1b. Recipient allowlist helpers (opt-in guardrail) ---
export {
  loadRecipientsAllowlist,
  assertRecipientAllowed,
  DEFAULT_ALLOWLIST_PATH,
} from "./recipients-allowlist.js";

// --- 1c. Fee guardrails (bound the fee on sends, claims, and withdrawals) ---
export {
  satsFromCurrencyAmount,
  lightningEstimateSats,
  lightningFeeCap,
  estimateFirstFeeCap,
  checkFeeAgainstCap,
  checkL402Amount,
  checkInvoiceAgainstQuote,
  estimateOnrampDeposit,
  withdrawalTotalFee,
  maxSpendableFace,
} from "./fee-guards.js";

// --- 1c³. Fiat rate (two keyless sources, cross-checked) — the number behind
// "make an invoice for $100" and "how much is my balance worth" ---
export { fetchBtcPrice, fiatToSats, satsToFiat, describeRate, DEFAULT_SOURCES as DEFAULT_PRICE_SOURCES } from "./fiat-rate.js";

// --- 1c². Spend ledger (cumulative rolling-window budget — the guard that
// bounds a LOOP of sends, which per-call ceilings cannot) ---
export {
  createSpendLedger,
  checkSpendBudget,
  spentInWindow,
  initSignedLedger,
  DEFAULT_SPEND_LEDGER_PATH,
  DAY_MS,
} from "./spend-ledger.js";

// --- 1d. BOLT11 read helpers (invoice amount / payment-hash binding) ---
export {
  decodeInvoiceSats,
  invoicePaymentHash,
  paymentHashMatches,
  invoiceSecondsRemaining,
  invoiceIsExpired,
} from "./bolt11.js";

// --- 1e. Lightning payment-dedup store (persisted per-invoice transferId) ---
export {
  createTransferIdStore,
  invoiceDedupKey,
  DEFAULT_TRANSFER_IDS_DIR,
} from "./transfer-ids.js";

// --- 1f. Wallet privacy (Spark wallets are publicly readable by default) ---
export { ensureWalletPrivacy, privacyPreferenceFromEnv } from "./wallet-privacy.js";

// --- 2. Skill-content helpers ---

// Resolve paths to the bundled skill files. Works whether the package was
// installed to node_modules/sparkbtcbot-skill or symlinked via `npm link`.
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const skillPath = join(PKG_ROOT, "skills/sparkbtcbot/SKILL.md");
export const referencesDir = join(PKG_ROOT, "skills/sparkbtcbot/references");

// Returns the always-loaded skill body as a string.
// Pass to your LLM framework's system-prompt / context-injection mechanism.
export async function getSkillContent() {
  return await readFile(skillPath, "utf8");
}

// Returns a specific reference doc by name (without the .md extension).
// Example: getReference("encrypted-seed") → contents of references/encrypted-seed.md
export async function getReference(name) {
  // Reference names are a closed set of kebab-case doc basenames. Anything
  // else — most importantly a crafted (e.g. prompt-injected) name like
  // "../../secrets" — must throw, not traverse out of referencesDir.
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(`Invalid reference name: ${JSON.stringify(name)}`);
  }
  return await readFile(join(referencesDir, `${name}.md`), "utf8");
}

// Returns the names of all reference docs (without .md extension).
// Useful for "tools/dynamic loading" patterns where the agent decides which
// reference to load based on the user's task.
export async function listReferences() {
  const entries = await readdir(referencesDir);
  return entries
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}
