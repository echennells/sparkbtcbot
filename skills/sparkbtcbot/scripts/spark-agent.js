import "dotenv/config";
import { pathToFileURL } from "node:url";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { loadMnemonicFromEnv } from "../../../lib/encrypted-seed.js";
import {
  loadRecipientsAllowlist,
  assertRecipientAllowed,
} from "../../../lib/recipients-allowlist.js";
import { decode as decodeBolt11 } from "light-bolt11-decoder";
import {
  lightningEstimateSats,
  lightningFeeCap,
  checkFeeAgainstCap,
  checkL402Amount,
  withdrawalTotalFee,
} from "../../../lib/fee-guards.js";

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

export class SparkAgent {
  #wallet;
  #network;

  constructor(wallet, network) {
    this.#wallet = wallet;
    this.#network = network;
  }

  static async create(mnemonic, network = "MAINNET") {
    const { wallet, mnemonic: generated } = await SparkWallet.initialize({
      mnemonicOrSeed: mnemonic,
      options: { network },
    });
    return { agent: new SparkAgent(wallet, network), mnemonic: generated };
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

  async transfer({ to, amount, dryRun = false }) {
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
  async payLightningInvoice(bolt11, { maxFeeSats, amountSats, maxAmountSats = 10_000, dryRun = false } = {}) {
    const est = await this.#wallet.getLightningSendFeeEstimate({
      encodedInvoice: bolt11,
      amountSats,
    });
    const estimatedFee = lightningEstimateSats(est);
    const amt = amountSats ?? invoiceAmountSats(bolt11);
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
    return await this.#wallet.payLightningInvoice({
      invoice: bolt11,
      maxFeeSats: cap,
      preferSpark: true,
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

  async transferTokens({ tokenIdentifier, amount, to, dryRun = false }) {
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
  async claimDeposit({ txid, vout = 0, maxFeeSats = 5000, dryRun = false }) {
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
  async withdraw({ to, amount, speed = "MEDIUM", maxFeeSats, maxFeePct = 10, dryRun = false }) {
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
    const check = checkFeeAgainstCap(fee, cap);
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
      const pct = ((check.fee / Number(amount)) * 100).toFixed(1);
      throw new Error(`Withdrawal blocked: ${check.reason} (${pct}% of the ${amount}-sat exit). Raise maxFeeSats/maxFeePct to override.`);
    }
    return await this.#wallet.withdraw({
      onchainAddress: to,
      exitSpeed: speed,
      amountSats: amount,
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

  // --- Events ---

  onTransferReceived(callback) {
    this.#wallet.on("transfer:claimed", callback);
  }

  onDepositConfirmed(callback) {
    this.#wallet.on("deposit:confirmed", callback);
  }

  // --- Lifecycle ---

  cleanup() {
    this.#wallet.cleanup();
  }
}

// --- Demo ---

async function main() {
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

  if (tokens.size > 0) {
    for (const [id, info] of tokens) {
      console.log(`${info.tokenMetadata.tokenTicker}: ${info.balance.toString()}`);
    }
  }

  const depositAddr = await agent.getDepositAddress();
  console.log("\n=== Deposit ===");
  console.log("Send BTC to:", depositAddr);

  console.log("\n=== Lightning Invoice ===");
  const bolt11 = await agent.createLightningInvoice(1000, "SparkAgent test");
  console.log("BOLT11:", bolt11);

  agent.cleanup();
}

// Run the demo only when executed directly (`node spark-agent.js`), so the
// SparkAgent class can be imported by other code without side effects.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
