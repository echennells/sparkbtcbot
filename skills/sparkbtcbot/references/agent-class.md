# Complete SparkAgent Class

Load when building an agent that wraps `SparkWallet` with a higher-level API for identity, balance, transfers, Lightning, Spark invoices, tokens, withdrawal, message signing, L402 paywalls, and event listeners. Drop-in implementation.

## Methods at a glance

The `SparkAgent` class exposes these (all `async` unless noted); full signatures and bodies are in the code below.

- **Identity & balance** — `getIdentity()`, `getBalance()`
- **Deposits** — `getDepositAddress()`, `getSingleUseDepositAddress()`, `claimDeposit(...)`
- **Send** — `transfer(...)`, `transferTokens(...)`, `batchTransferTokens(transfers)`, `withdraw(...)` (L1 cooperative exit), `getWithdrawalFeeQuote(amountSats, address)`, `getTransfers(limit, offset)`
- **Lightning** — `createLightningInvoice(amountSats, memo, options)`, `payLightningInvoice(bolt11, ...)`, `estimateLightningFee(bolt11, amountSats)`
- **Spark invoices** — `createSatsInvoice(amountSats, memo)`, `createTokenInvoice(tokenIdentifier, amount, memo)`, `fulfillInvoice(invoices)`
- **L402 paywalls** — `fetchL402(url, options)`, `previewL402(url)`
- **Message signing** — `signMessage(text)`, `verifyOwnSignature(text, signature)`
- **Events & lifecycle** — `onTransferReceived(cb)` (sync), `onDepositConfirmed(cb)` (sync), `vaultHealth()` (sync), `await cleanup()`
- **Static factory** — `SparkAgent.create(mnemonic, network)` → `{ agent, mnemonic }`

```javascript
// (the runnable scripts/spark-agent.js also does `import "dotenv/config"` here)
import { SparkWallet } from "@buildonspark/spark-sdk";
import {
  loadRecipientsAllowlist,
  assertRecipientAllowed,
} from "./lib/recipients-allowlist.js";
import { decode as decodeBolt11 } from "light-bolt11-decoder";
import {
  lightningEstimateSats,
  lightningFeeCap,
  checkFeeAgainstCap,
  checkL402Amount,
  withdrawalTotalFee,
} from "./lib/fee-guards.js";
import { enableLeafVault } from "./leaf-vault.js";

// Best-effort BOLT11 amount in sats (undefined for amountless invoices or on a
// decode error) — used to size the amount-aware Lightning fee cap.
function invoiceAmountSats(bolt11) {
  try {
    const section = decodeBolt11(bolt11)?.sections?.find((s) => s.name === "amount");
    if (!section?.value) return undefined;
    const sats = Number(section.value) / 1000; // section.value is millisats
    return Number.isFinite(sats) && sats > 0 ? Math.round(sats) : undefined;
  } catch {
    return undefined;
  }
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

export class SparkAgent {
  #wallet;
  #network;
  #vault = null;

  constructor(wallet, network) {
    this.#wallet = wallet;
    this.#network = network;
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
    return await this.#wallet.transfer({
      receiverSparkAddress: to,
      amountSats: amount,
    });
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
    const invoiceAmt = invoiceAmountSats(bolt11); // embedded amount; undefined for amountless/undecodable
    const est = await this.#wallet.getLightningSendFeeEstimate({
      encodedInvoice: bolt11,
      amountSats,
    });
    const estimatedFee = lightningEstimateSats(est);
    const amt = amountSats ?? invoiceAmt;
    // Fee cap: amount-aware (0.5% of amount, min 10 sats) — replaces the old flat
    // 10 that silently rejected sends over ~4,000 sats. Explicit maxFeeSats wins.
    const cap = maxFeeSats ?? lightningFeeCap({ amountSats: amt, estimatedFeeSats: estimatedFee });
    const feeCheck = checkFeeAgainstCap(estimatedFee, cap);
    // Amount ceiling: the fee cap alone CANNOT stop an induced full-balance send
    // (routing ~0.25% always fits a 0.5% fee cap), so bound the AMOUNT too — the
    // same guard the L402 path uses. Fails closed on an amountless/undecodable
    // invoice. Raise maxAmountSats for a genuinely larger send.
    const amtCheck = checkL402Amount({ amountSats: amt, maxAmountSats });
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
        maxAmountSats: String(maxAmountSats),
        withinCap: ok,
        capReason: ok ? "within caps" : reason,
        network: "lightning",
      };
    }
    if (!ok) {
      const hint = !amtCheck.ok ? "Raise maxAmountSats" : "Raise maxFeeSats";
      throw new Error(`Lightning send blocked: ${reason}. ${hint} to override.`);
    }
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
  }

  async estimateLightningFee(bolt11, amountSats) {
    return await this.#wallet.getLightningSendFeeEstimate({
      encodedInvoice: bolt11,
      amountSats,
    });
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

  async fulfillInvoice(invoices) {
    return await this.#wallet.fulfillSparkInvoice(invoices);
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
  // recipient blocks the whole batch — that's the safer default.
  async batchTransferTokens(transfers) {
    for (const t of transfers) {
      const to = t.receiverSparkAddress ?? t.to;
      if (to) await this.#assertAllowed(to);
    }
    return await this.#wallet.batchTransferTokens(transfers);
  }

  // --- Deposits (claim to Spark) ---

  // Claim a confirmed L1 deposit into Spark balance with a SERVER-ENFORCED fee
  // ceiling: the SDK's claimStaticDepositWithMaxFee rejects the claim if the SSP's
  // fee (its spread for sweeping the UTXO on-chain) exceeds maxFeeSats. This is the
  // SDK's own guardrail — no client-side gross-amount lookup needed (and none is
  // possible: getUtxosForDepositAddress returns only { txid, vout }). dryRun
  // previews the credited amount from the quote without claiming.
  async claimDeposit({ txid, vout = 0, maxFeeSats = 5000, dryRun = false, ...rest }) {
    rejectUnknownOptions("claimDeposit", rest);
    if (dryRun) {
      const quote = await this.#wallet.getClaimStaticDepositQuote(txid, vout);
      const credit = Number(quote?.creditAmountSats);
      return {
        dryRun: true,
        operation: "claim_deposit",
        txid,
        vout,
        creditSats: Number.isFinite(credit) ? String(credit) : "unknown",
        maxFeeSats: String(maxFeeSats),
        network: this.#network,
      };
    }
    return await this.#wallet.claimStaticDepositWithMaxFee({
      transactionId: txid,
      maxFee: maxFeeSats,
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
    await this.#assertAllowed(to);
    const quote = await this.#wallet.getWithdrawalFeeQuote({
      amountSats: amount,
      withdrawalAddress: to,
    });
    // Total exit fee = userFee + l1BroadcastFee for the chosen speed. Ceiling:
    // reject an exit whose fee exceeds maxFeePct (default 10%) of the amount or an
    // absolute maxFeeSats — which legibly refuses uneconomical small withdrawals,
    // consistent with "discourage sub-25k-sat exits". Unreadable quote => proceed
    // (defer to the SDK) rather than block a valid withdrawal.
    const fee = withdrawalTotalFee(quote, speed);
    const pctCap = Number.isFinite(Number(maxFeePct)) ? Math.ceil((Number(amount) * Number(maxFeePct)) / 100) : Infinity;
    const absCap = Number.isFinite(Number(maxFeeSats)) ? Number(maxFeeSats) : Infinity;
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
    // Bind the executed exit to the SAME quote we just vetted: the SDK derives
    // feeAmountSats + feeQuoteId from `feeQuote`, so the operator charges the quoted
    // fee we checked rather than re-pricing at broadcast (closes the TOCTOU gap).
    return await this.#wallet.withdraw({
      onchainAddress: to,
      exitSpeed: speed,
      amountSats: amount,
      feeQuote: quote,
    });
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
    const { method = "GET", headers = {}, body, maxFeeSats, maxAmountSats = 10_000 } = options;

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

    const challenge = await initialResponse.json();
    const invoice = challenge.invoice || challenge.payment_request || challenge.pr;
    const macaroon = challenge.macaroon || challenge.token;
    if (!invoice || !macaroon) throw new Error("Invalid L402 challenge");

    const decoded = decode(invoice);
    const amountSection = decoded.sections.find((s) => s.name === "amount");
    const amountSats = amountSection?.value ? Math.ceil(Number(amountSection.value) / 1000) : null;

    // Bound the invoice AMOUNT, not just the routing fee — a malicious/compromised
    // paywall can demand an arbitrarily large invoice, and fetchL402 re-fetches a
    // fresh 402 challenge (so previewL402's price is NOT authoritative). Also
    // refuses an amountless invoice. Raise maxAmountSats for pricier resources.
    const amtCheck = checkL402Amount({ amountSats, maxAmountSats });
    if (!amtCheck.ok) throw new Error(`L402 payment blocked: ${amtCheck.reason}. Raise maxAmountSats to override.`);

    // Route through the guarded wrapper so the payment also gets the amount-aware
    // routing-fee cap (maxFeeSats undefined => sized from the invoice amount).
    const payResult = await this.payLightningInvoice(invoice, { maxFeeSats, amountSats });
    let preimage = payResult.paymentPreimage;

    if (!preimage && payResult.id) {
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const status = await this.#wallet.getLightningSendRequest(payResult.id);
        if (status?.paymentPreimage) { preimage = status.paymentPreimage; break; }
        if (status?.status === "LIGHTNING_PAYMENT_FAILED") throw new Error("Payment failed");
      }
    }
    if (!preimage) throw new Error("No preimage received");

    const finalResponse = await fetch(url, {
      method,
      headers: { "Authorization": `L402 ${macaroon}:${preimage}`, ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });

    const ct = finalResponse.headers.get("content-type") || "";
    const data = ct.includes("json") ? await finalResponse.json() : await finalResponse.text();
    return { paid: true, amountSats, macaroon, preimage, data };
  }

  async previewL402(url) {
    const response = await fetch(url);
    if (response.status !== 402) return { requiresPayment: false };

    const { decode } = await import("light-bolt11-decoder");
    const challenge = await response.json();
    const invoice = challenge.invoice || challenge.payment_request;
    const decoded = decode(invoice);
    const amountSection = decoded.sections.find((s) => s.name === "amount");
    if (!amountSection?.value) throw new Error("L402 invoice has no amount");

    return {
      requiresPayment: true,
      amountSats: Math.ceil(Number(amountSection.value) / 1000),
      invoice,
      macaroon: challenge.macaroon,
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
