// Wallet privacy: make the agent's balance and history NOT publicly readable.
//
// Spark wallets are PUBLIC by default. Every wallet has a per-identity setting
// at the operators (`private_enabled`, default false), and while it is false
// anyone who knows the Spark address can read the balance, the full transfer
// history, pending transfers, deposit addresses and UTXOs with NO
// authentication — `SparkReadonlyClient.createPublic()` in the SDK, or
// Sparkscan. An agent hands its address to every counterparty it deals with
// (every invoice with `includeSparkAddress`, every merchant, every "send me
// sats"), so with the default setting each of them — and anyone scraping the
// explorer — can see how much the agent holds and everything it has done.
//
// With the setting on, the operators answer those queries only to a session
// authenticated as the owner (or the one viewer key, see below) and hand
// everyone else an EMPTY answer — not an error, so a counterparty can't tell
// "hidden" from "empty". Verified in the operator source (public mirror,
// 2026-08-24): the gate is `HasReadAccessToWallet` on query_balance,
// query_nodes, every transfer query, unused deposit addresses, UTXOs and the
// event subscription. What it does NOT cover, as of that mirror: BTKN token
// balances/transactions and Spark invoices stay public regardless; static
// deposit addresses are gated only behind a rollout knob that is currently
// off. The SSP itself is exempt (it must see leaves to serve the wallet).
//
// This module is SDK-free (it takes any object with the two wallet methods) so
// the policy is unit-testable and reusable. The runtime calls
// ensureWalletPrivacy at setup and again on every SparkAgent boot: the
// setting persists at the operators, so the boot call is a self-heal, not a
// requirement. Opt out with SPARK_PRIVACY=off (same spelling family as the
// other runtime toggles).

const OPT_OUT_VALUES = ["off", "false", "0", "no"];

// The keys ensureWalletPrivacy understands. A misspelled option must THROW,
// not silently mean "default": `{ enable: false }` would otherwise turn the
// wallet private while the caller believed they'd opted out (the same
// silent-drop class fee-guards.js rejects).
const KNOWN_OPTIONS = ["enabled"];

// True unless SPARK_PRIVACY is one of the opt-out spellings. An unset or
// unrecognised value means ON — a typo must not silently expose the wallet.
export function privacyPreferenceFromEnv(env = process.env) {
  const flag = String(env.SPARK_PRIVACY ?? "").trim().toLowerCase();
  return !OPT_OUT_VALUES.includes(flag);
}

// Read the wallet's setting and flip it if it disagrees with `enabled`.
// Idempotent: a wallet already in the requested state makes ONE read and no
// write. Returns { changed, settings } where settings is the SDK's
// WalletSettings ({ ownerIdentityPublicKey, privateEnabled, ... }) after the
// call. A wallet with no settings row yet (getWalletSettings() → undefined)
// is at the operators' default — public — and is written.
export async function ensureWalletPrivacy(wallet, options = {}) {
  for (const key of Object.keys(options)) {
    if (!KNOWN_OPTIONS.includes(key)) {
      throw new Error(
        `ensureWalletPrivacy: unknown option "${key}" — a misspelled flag would be silently ignored ` +
          `and the wallet left in the wrong state. Known options: ${KNOWN_OPTIONS.join(", ")}.`,
      );
    }
  }
  const { enabled = true } = options;
  if (typeof enabled !== "boolean") {
    throw new Error(`ensureWalletPrivacy: "enabled" must be a boolean, got ${typeof enabled}`);
  }
  if (typeof wallet?.getWalletSettings !== "function" || typeof wallet?.setPrivacyEnabled !== "function") {
    throw new Error(
      "ensureWalletPrivacy: wallet has no getWalletSettings/setPrivacyEnabled — " +
        "these need @buildonspark/spark-sdk >= 0.11 (an older SDK leaves the wallet publicly readable).",
    );
  }
  const current = await wallet.getWalletSettings();
  if (current?.privateEnabled === enabled) {
    return { changed: false, settings: current };
  }
  const settings = await wallet.setPrivacyEnabled(enabled);
  // The SDK returns the operators' view of the setting after the write. A
  // response that does not carry the requested state is a failed write that
  // did not throw — surface it rather than report a privacy the wallet lacks.
  if (settings?.privateEnabled !== enabled) {
    throw new Error(
      `ensureWalletPrivacy: setPrivacyEnabled(${enabled}) returned privateEnabled=` +
        `${settings?.privateEnabled} — the operators did not record the change.`,
    );
  }
  return { changed: true, settings };
}
