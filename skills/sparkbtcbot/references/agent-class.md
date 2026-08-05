# Complete SparkAgent Class

Load when building an agent that wraps `SparkWallet` with a higher-level API for identity, balance, transfers, Lightning, Spark invoices, tokens, withdrawal, message signing, L402 paywalls, and event listeners. Drop-in implementation.

## Methods at a glance

The `SparkAgent` class exposes these (all `async` unless noted); full signatures and bodies are in the code below.

- **Identity & balance** — `getIdentity()`, `getBalance()`
- **Deposits** — `getDepositAddress()`, `getSingleUseDepositAddress()`, `listPendingDeposits()`, `claimDeposit(...)`
- **Send** — `transfer(...)`, `transferTokens(...)`, `batchTransferTokens(transfers)`, `withdraw(...)` (L1 cooperative exit), `getWithdrawalFeeQuote(amountSats, address)`, `getTransfers(limit, offset)`
- **Lightning** — `createLightningInvoice(amountSats, memo, options)`, `payLightningInvoice(bolt11, ...)`, `estimateLightningFee(bolt11, amountSats)`, `getLightningSendRequest(id)` (poll an initiated send for its preimage), `payAndSettle(bolt11, ...)` (pay + wait for the preimage; never retry-pay on its timeout)
- **Spark invoices** — `createSatsInvoice(amountSats, memo)`, `createTokenInvoice(tokenIdentifier, amount, memo)`, `fulfillInvoice(invoices, options)` (allowlist-gated on each invoice's decoded receiver; supports `dryRun`)
- **L402 paywalls** — `fetchL402(url, options)`, `previewL402(url)`
- **Message signing** — `signMessage(text)`, `verifyOwnSignature(text, signature)`
- **Events & lifecycle** — `onTransferReceived(cb)` (sync), `onDepositConfirmed(cb)` (sync), `vaultHealth()` (sync), `spendStatus()` (rolling-window budget state, `{ disabled: true }` when `SPARK_DAILY_BUDGET_SATS` is unset), `await cleanup()`
- **Static factory** — `SparkAgent.create(mnemonic, network)` → `{ agent, mnemonic }`; throws on a missing mnemonic instead of silently generating a fresh wallet (deliberate creation is `npm run setup`)

```javascript
// (the runnable scripts/spark-agent.js also does `import "dotenv/config"` here)
import {
  SparkWallet,
  decodeSparkAddress,
  encodeSparkAddress,
  getNetworkFromSparkAddress,
} from "@buildonspark/spark-sdk";
import { loadMnemonicFromEnv } from "./lib/encrypted-seed.js";
import {
  loadRecipientsAllowlist,
  assertRecipientAllowed,
  DEFAULT_ALLOWLIST_PATH,
} from "./lib/recipients-allowlist.js";
import { decodeInvoiceSats } from "./lib/bolt11.js";
import {
  lightningEstimateSats,
  lightningFeeCap,
  checkFeeAgainstCap,
  checkL402Amount,
  withdrawalTotalFee,
} from "./lib/fee-guards.js";
import { createSpendLedger } from "./lib/spend-ledger.js";
import { enableLeafVault } from "./leaf-vault.js";

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

// Terminal failure statuses from the SDK's LightningSendRequestStatus enum —
// every one means this payment will never settle. USER_SWAP_RETURNED is the
// subtle one: the payment failed and the funds were already returned.
// FUTURE_VALUE exists because the SDK warns new statuses can appear without
// notice, so match the _FAILED suffix rather than an exhaustive list.
export function isTerminalLightningFailure(status) {
  if (typeof status !== "string") return false;
  return status.endsWith("_FAILED") || status === "USER_SWAP_RETURNED";
}

// Cumulative-budget guardrail (lib/spend-ledger.js): every other guard is
// per-call, so none of them stops a LOOP of individually-valid sends. Active
// only when SPARK_DAILY_BUDGET_SATS is set (rolling 24h window; ledger at
// SPARK_SPEND_LEDGER_PATH, default ~/.spark/spend-ledger.json). A malformed
// budget THROWS instead of being ignored — a budget the operator thinks is
// set but isn't would be the silently-generated-wallet bug all over again.
function spendLedgerFromEnv() {
  const raw = process.env.SPARK_DAILY_BUDGET_SATS;
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

export class SparkAgent {
  #wallet;
  #network;
  #vault = null;
  #ledger = null;

  constructor(wallet, network) {
    this.#wallet = wallet;
    this.#network = network;
    this.#ledger = spendLedgerFromEnv();
    // Automatically mirror the unilateral-exit material to disk so funds stay
    // recoverable if the Spark operators go offline — snapshots on boot and on
    // every leaf change (send/receive/deposit) + a refresh safety timer. Opt out
    // with SPARK_LEAF_VAULT set to off/false/0/no. See references/unilateral-exit.md.
    const flag = String(process.env.SPARK_LEAF_VAULT ?? "").trim().toLowerCase();
    if (!["off", "false", "0", "no"].includes(flag)) {
      this.#vault = enableLeafVault(wallet, { networkLabel: network });
    }
  }

  static async create(mnemonic, network = "MAINNET") {
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
      options: { network },
    });
    const agent = new SparkAgent(wallet, network);
    // Surface a broken recovery backup LOUDLY at startup instead of the silent
    // console.error default — the wallet still works, but the operator is told.
    const vaultReady = await agent.#vault?.ready;
    if (vaultReady && !vaultReady.ok) {
      console.warn(
        `⚠️  leaf-vault backup is NOT active: ${vaultReady.error}\n` +
        `   The wallet works, but UNILATERAL EXIT may be impossible until this is fixed.\n` +
        `   Set SPARK_LEAF_VAULT=off to silence, or see references/unilateral-exit.md.`,
      );
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

  // Budget gate + PRE-commit record for a sats spend. Recording before the
  // SDK call is the safe direction: a crash mid-send overcounts (and rolls
  // off with the window) rather than undercounts. The returned undo() is the
  // best-effort refund for an SDK call that threw — almost always a
  // synchronous rejection where no money moved. (The pathological case, a
  // transport timeout AFTER the operator accepted the send, would undercount
  // by one payment; the ledger is a runaway-loop guardrail, not an
  // accounting system, so that trade is taken knowingly.)
  async #recordSpend(sats, operation) {
    if (!this.#ledger) return { undo: async () => {} };
    await this.#ledger.assertCanSpend(sats, operation);
    const entry = await this.#ledger.record(sats, operation);
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
    return { sats: satsBalance.available.toString(), tokens };
  }

  // --- Deposits ---

  async getDepositAddress() {
    return await this.#wallet.getStaticDepositAddress();
  }

  // Confirmed-but-UNCLAIMED L1 deposits. getBalance() shows only CLAIMED Spark
  // balance, so THIS is what answers "did my on-chain deposit arrive?" — an empty
  // array means nothing to claim yet; each entry feeds claimDeposit({ txid, vout }).
  async listPendingDeposits({ limit = 100 } = {}) {
    const addresses = await this.#wallet.queryStaticDepositAddresses();
    const deposits = [];
    for (const address of addresses) {
      const utxos = await this.#wallet.getUtxosForDepositAddress(address, limit, 0, true);
      for (const u of utxos) deposits.push({ address, txid: u.txid, vout: u.vout });
    }
    return deposits;
  }

  async getSingleUseDepositAddress() {
    return await this.#wallet.getSingleUseDepositAddress();
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
    if (dryRun) {
      return {
        dryRun: true,
        operation: "spark_transfer",
        from: await this.#wallet.getSparkAddress(),
        to,
        amount: String(amount),
        unit: "sats",
        estimatedFee: "0", // Spark-to-Spark transfers are free
        network: this.#network,
      };
    }
    const spend = await this.#recordSpend(Number(amount), "spark_transfer");
    try {
      return await this.#wallet.transfer({
        receiverSparkAddress: to,
        amountSats: amount,
      });
    } catch (err) {
      await spend.undo().catch(() => {});
      throw err;
    }
  }

  async getTransfers(limit = 10, offset = 0) {
    return await this.#wallet.getTransfers(limit, offset);
  }

  // --- Lightning ---

  async createLightningInvoice(amountSats, memo, options = {}) {
    const request = await this.#wallet.createLightningInvoice({
      amountSats,
      memo,
      expirySeconds: options.expirySeconds || 3600,
      includeSparkAddress: options.includeSparkAddress ?? true,
    });
    return request.invoice.encodedInvoice;
  }

  // `dryRun: true` returns a preview (incl. estimated routing fee) without
  // paying. Lightning recipients are node pubkeys embedded in the BOLT11,
  // so the allowlist (which targets Spark/L1 addresses) does not apply here
  // — confirm the invoice's amount and decoded payee with the operator
  // before paying when stakes warrant it.
  async payLightningInvoice(bolt11, { maxFeeSats, amountSats, maxAmountSats = 10_000, dryRun = false, ...rest } = {}) {
    rejectUnknownOptions("payLightningInvoice", rest);
    // Validate BEFORE any I/O: a garbage ceiling must throw here, not degrade
    // to "no cap set" inside the guards (see requireNumericOption).
    const maxFee = requireNumericOption("payLightningInvoice", "maxFeeSats", maxFeeSats);
    const maxAmt = requireNumericOption("payLightningInvoice", "maxAmountSats", maxAmountSats) ?? 10_000;
    const invoiceAmt = invoiceAmountSats(bolt11); // embedded amount; undefined for amountless/undecodable
    const est = await this.#wallet.getLightningSendFeeEstimate({
      encodedInvoice: bolt11,
      amountSats,
    });
    const estimatedFee = lightningEstimateSats(est);
    // The INVOICE wins over the caller's number. For an amount-bearing invoice
    // the SDK pays the embedded amount (it rejects amountSatsToSend for those,
    // see below), so checking a caller-supplied figure would guard a number
    // nobody pays: pass amountSats: 100 with a 20,000-sat invoice and the
    // ceiling validates 100 while 20,000 leaves the wallet — and the dry-run
    // preview would show the operator the wrong number too. Disagreement is a
    // bug or an injected parameter, so refuse rather than silently pick one.
    if (invoiceAmt !== undefined && amountSats !== undefined && Number(amountSats) !== invoiceAmt) {
      throw new Error(
        `SparkAgent.payLightningInvoice: amountSats (${amountSats}) disagrees with the invoice's ` +
        `embedded amount (${invoiceAmt} sats). The invoice amount is what gets paid — omit amountSats ` +
        `for amount-bearing invoices.`,
      );
    }
    const amt = invoiceAmt ?? amountSats;
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
      };
    }
    if (!ok) {
      const hint = !amtCheck.ok ? "Raise maxAmountSats" : "Raise maxFeeSats";
      throw new Error(`Lightning send blocked: ${reason}. ${hint} to override.`);
    }
    // Budget counts the AMOUNT; routing fees are bounded separately by the cap
    // above (≤0.5% + floor). An unreadable amount with a budget set fails
    // closed inside the ledger.
    const spend = await this.#recordSpend(amt, "lightning_pay");
    try {
      // The SDK REQUIRES amountSatsToSend for a zero-amount invoice and REJECTS it
      // for an invoice that carries one — forward the caller's amount only in the
      // amountless case. (Without this, amountless sends fail at payment time even
      // though the fee estimate above accepted the amount.)
      return await this.#wallet.payLightningInvoice({
        invoice: bolt11,
        maxFeeSats: cap,
        preferSpark: true,
        ...(invoiceAmt === undefined && amountSats !== undefined ? { amountSatsToSend: amountSats } : {}),
      });
    } catch (err) {
      await spend.undo().catch(() => {});
      throw err;
    }
  }

  async estimateLightningFee(bolt11, amountSats) {
    return await this.#wallet.getLightningSendFeeEstimate({
      encodedInvoice: bolt11,
      amountSats,
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
  // LIGHTNING_PAYMENT_FAILED. On poll exhaustion returns { settled: false }:
  // NEVER retry-pay after a timeout — the payment may still settle (hold
  // invoices legitimately stay pending for many minutes); check again later
  // with getLightningSendRequest(result.id) instead.
  async payAndSettle(bolt11, { pollMs = 2000, maxPolls = 30, ...payOptions } = {}) {
    const result = await this.payLightningInvoice(bolt11, payOptions);
    if (payOptions.dryRun) return result;
    let preimage = result.paymentPreimage ?? null;
    let lastStatus = result.status ?? null;
    for (let i = 0; !preimage && result.id && i < maxPolls; i++) {
      await new Promise((r) => setTimeout(r, pollMs));
      const status = await this.#wallet.getLightningSendRequest(result.id);
      lastStatus = status?.status ?? lastStatus;
      if (status?.paymentPreimage) preimage = status.paymentPreimage;
      else if (isTerminalLightningFailure(status?.status)) {
        // Distinguishing a DEFINITIVE failure from a slow settle is what makes
        // the never-retry-on-timeout rule safe: a failed-and-refunded payment
        // that merely timed out would otherwise look pending forever, and the
        // rule would forbid the retry that is actually correct.
        throw new Error(`Lightning payment failed (${status.status})`);
      }
    }
    return { ...result, paymentPreimage: preimage, settled: Boolean(preimage), lastStatus };
  }

  // --- Spark Invoices ---

  async createSatsInvoice(amountSats, memo) {
    return await this.#wallet.createSatsInvoice({
      amount: amountSats,
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
      // one and preview/budget a number nobody pays.
      const embeddedAmt = embedded?.amount == null ? null : Number(embedded.amount);
      const callerAmt = entry.amount == null ? null : Number(entry.amount);
      if (embeddedAmt !== null && callerAmt !== null && embeddedAmt !== callerAmt) {
        throw new Error(
          `SparkAgent.fulfillInvoice: entry amount (${callerAmt}) disagrees with the invoice's ` +
            `embedded amount (${embeddedAmt}). Omit the entry amount for amount-bearing invoices.`,
        );
      }
      return {
        invoice,
        to: receiver.address,
        amount: String(embeddedAmt ?? callerAmt ?? "unknown"),
        type: embedded?.type ?? "unknown",
      };
    });
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
    try {
      return await this.#wallet.fulfillSparkInvoice(invoices);
    } catch (err) {
      await spend.undo().catch(() => {});
      throw err;
    }
  }

  // --- Tokens ---

  async transferTokens({ tokenIdentifier, amount, to, dryRun = false, ...rest }) {
    rejectUnknownOptions("transferTokens", rest);
    await this.#assertAllowed(to);
    if (dryRun) {
      return {
        dryRun: true,
        operation: "token_transfer",
        from: await this.#wallet.getSparkAddress(),
        to,
        tokenIdentifier,
        amount: String(amount),
        unit: "tokens",
        estimatedFee: "0", // Spark token transfers are free
        network: this.#network,
      };
    }
    return await this.#wallet.transferTokens({
      tokenIdentifier,
      tokenAmount: amount,
      receiverSparkAddress: to,
    });
  }

  // Allowlist applies to every receiver in the batch. One disallowed
  // recipient blocks the whole batch — that's the safer default. An entry
  // whose receiver can't be read can't be checked: fail CLOSED like
  // fulfillInvoice, never skip the gate for that entry.
  async batchTransferTokens(transfers) {
    for (const t of transfers) {
      const to = t.receiverSparkAddress ?? t.to;
      if (!to) {
        throw new Error(
          "SparkAgent.batchTransferTokens: every entry needs a recipient (receiverSparkAddress) — " +
            "refusing to forward an entry whose receiver cannot be checked.",
        );
      }
      await this.#assertAllowed(to);
    }
    return await this.#wallet.batchTransferTokens(transfers);
  }

  // --- Deposits (claim to Spark) ---

  // Claim a confirmed L1 deposit into Spark balance with a SERVER-ENFORCED fee
  // ceiling: the SDK's claimStaticDepositWithMaxFee rejects the claim if the SSP's
  // fee (its spread for sweeping the UTXO on-chain) exceeds the ceiling.
  //
  // The default ceiling is SIZE-AWARE: maxFeePct (default 10%) of the quoted
  // credit — the same posture as withdraw(). The old flat 5,000-sat default
  // authorized the SSP to take 83% of a 6,000-sat deposit without a peep. An
  // explicit maxFeeSats still wins as an absolute cap; with neither a readable
  // quote nor an explicit cap the claim FAILS CLOSED rather than picking a
  // number for a deposit whose size it cannot see. dryRun previews the quoted
  // credit and the ceiling that would be enforced, without claiming.
  async claimDeposit({ txid, vout = 0, maxFeeSats, maxFeePct = 10, dryRun = false, ...rest }) {
    rejectUnknownOptions("claimDeposit", rest);
    // Garbage ceiling values throw here (requireNumericOption): a NaN maxFee
    // passed to the SDK never trips its `feeCharged > maxFee` check, which
    // would silently remove the ceiling entirely.
    const explicit = requireNumericOption("claimDeposit", "maxFeeSats", maxFeeSats) ?? null;
    const pct = requireNumericOption("claimDeposit", "maxFeePct", maxFeePct) ?? 10;
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
        cap = Math.ceil((credit * pct) / 100);
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
      amountSats,
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
    const abs = requireNumericOption("withdraw", "maxFeeSats", maxFeeSats);
    await this.#assertAllowed(to);
    const quote = await this.#wallet.getWithdrawalFeeQuote({
      amountSats: amount,
      withdrawalAddress: to,
    });
    // Total exit fee = userFee + l1BroadcastFee for the chosen speed. Ceiling:
    // reject an exit whose fee exceeds maxFeePct (default 10%) of the amount or an
    // absolute maxFeeSats — which legibly refuses uneconomical small withdrawals,
    // consistent with "discourage sub-25k-sat exits".
    const fee = withdrawalTotalFee(quote, speed);
    const pctCap = Number.isFinite(Number(amount)) ? Math.ceil((Number(amount) * pct) / 100) : Infinity;
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
        amount: String(amount),
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
        ? ` (${((check.fee / Number(amount)) * 100).toFixed(1)}% of the ${amount}-sat exit). Raise maxFeeSats/maxFeePct to override.`
        : `. Re-fetch the quote or check the SDK CoopExitFeeQuote shape.`;
      throw new Error(`Withdrawal blocked: ${check.reason}${detail}`);
    }
    // Budget counts amount + the vetted fee — both leave the wallet on an exit.
    const spend = await this.#recordSpend(Number(amount) + (check.fee ?? 0), "l1_withdraw");
    try {
      // Bind the executed exit to the SAME quote we just vetted, so the operator
      // charges the quoted fee we checked rather than re-pricing at broadcast
      // (closes the TOCTOU gap). feeQuoteId + feeAmountSats is the current SDK
      // API; the `feeQuote` object param does the same but is @deprecated — kept
      // only as the fallback when our reader couldn't extract a scalar fee.
      return await this.#wallet.withdraw({
        onchainAddress: to,
        exitSpeed: speed,
        amountSats: amount,
        ...(check.fee != null && quote?.id
          ? { feeQuoteId: quote.id, feeAmountSats: check.fee }
          : { feeQuote: quote }),
      });
    } catch (err) {
      await spend.undo().catch(() => {});
      throw err;
    }
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
    const { method = "GET", headers = {}, body, maxFeeSats, maxAmountSats = 10_000, ...rest } = options;
    // Same strictness as every other money-moving method: an ignored option
    // here is not cosmetic. `fetchL402(url, { dryRun: true })` used to PAY —
    // the exact phantom-dryRun failure the wrapper exists to prevent.
    rejectUnknownOptions("fetchL402", rest);
    assertHttpsUrl("fetchL402", url);
    // Garbage ceiling values throw BEFORE any network I/O (requireNumericOption).
    const maxFee = requireNumericOption("fetchL402", "maxFeeSats", maxFeeSats);
    const maxAmt = requireNumericOption("fetchL402", "maxAmountSats", maxAmountSats) ?? 10_000;

    const initialResponse = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (initialResponse.status !== 402) {
      const ct = initialResponse.headers.get("content-type") || "";
      const data = ct.includes("json") ? await initialResponse.json() : await initialResponse.text();
      return { paid: false, data };
    }

    // Header first (spec-compliant, incl. `token=`), body fallback — see parseL402Challenge.
    const { invoice, macaroon } = await parseL402Challenge(initialResponse);
    if (!invoice || !macaroon) throw new Error("Invalid L402 challenge");

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
    // retry that pays the invoice a second time.
    const payResult = await this.payAndSettle(invoice, { maxFeeSats: maxFee });
    const preimage = payResult.paymentPreimage;
    if (!preimage) {
      const err = new Error(
        `L402 invoice PAID but no preimage yet (status ${payResult.lastStatus ?? "unknown"}). ` +
        `DO NOT retry this request — that would pay again. Poll ` +
        `agent.getLightningSendRequest("${payResult.id}") for the preimage, then retry with it.`,
      );
      err.paid = true;
      err.sendId = payResult.id;
      err.macaroon = macaroon;
      throw err;
    }

    const finalResponse = await fetch(url, {
      method,
      // Authorization last: a caller-supplied header must not clobber the L402
      // proof we just paid for (that would pay and then not present the proof).
      headers: { ...headers, "Authorization": `L402 ${macaroon}:${preimage}` },
      body: body ? JSON.stringify(body) : undefined,
    });

    const ct = finalResponse.headers.get("content-type") || "";
    const data = ct.includes("json") ? await finalResponse.json() : await finalResponse.text();
    return { paid: true, amountSats, macaroon, preimage, data };
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

    return {
      requiresPayment: true,
      amountSats: Math.ceil(Number(amountSection.value) / 1000),
      invoice,
      macaroon,
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
  // lastError }, or { disabled: true } when opted out via SPARK_LEAF_VAULT.
  vaultHealth() {
    return this.#vault?.health?.() ?? { disabled: true };
  }

  // --- Lifecycle ---

  async cleanup() {
    await this.#vault?.dispose?.(); // first: the final flush needs the live wallet
    await this.#wallet.cleanup();
  }
}
```

## Usage

```javascript
import { loadMnemonicFromEnv } from "./lib/encrypted-seed.js";

const mnemonic = await loadMnemonicFromEnv(); // reads SPARK_PASSPHRASE
const { agent } = await SparkAgent.create(mnemonic);

const identity = await agent.getIdentity();
console.log("Address:", identity.address);

const { sats } = await agent.getBalance();
console.log("Balance:", sats, "sats");

await agent.cleanup(); // flushes a final recovery-bundle snapshot if needed
```

A working file lives at `skills/sparkbtcbot/scripts/spark-agent.js` — runnable via `npm run example:agent`.
