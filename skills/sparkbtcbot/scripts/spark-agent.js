import "dotenv/config";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { loadMnemonicFromEnv } from "../../../lib/encrypted-seed.js";
import {
  loadRecipientsAllowlist,
  assertRecipientAllowed,
} from "../../../lib/recipients-allowlist.js";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

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
  async payLightningInvoice(bolt11, { maxFeeSats = 10, amountSats, dryRun = false } = {}) {
    if (dryRun) {
      const feeEst = await this.#wallet.getLightningSendFeeEstimate({
        encodedInvoice: bolt11,
        amountSats,
      });
      return {
        dryRun: true,
        operation: "lightning_pay",
        from: await this.#wallet.getSparkAddress(),
        invoice: bolt11,
        amount: amountSats !== undefined ? String(amountSats) : "<from invoice>",
        unit: "sats",
        estimatedFee: String(feeEst?.fee ?? feeEst ?? "unknown"),
        maxFeeSats: String(maxFeeSats),
        network: "lightning",
      };
    }
    return await this.#wallet.payLightningInvoice({
      invoice: bolt11,
      maxFeeSats,
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

  // --- Withdrawal ---

  async getWithdrawalFeeQuote(amountSats, onchainAddress) {
    return await this.#wallet.getWithdrawalFeeQuote({
      amountSats,
      withdrawalAddress: onchainAddress,
    });
  }

  // Cooperative exit back to L1 Bitcoin. Allowlist applies to `to` (L1 BTC
  // address). dryRun returns the fee quote without broadcasting.
  async withdraw({ to, amount, speed = "MEDIUM", dryRun = false }) {
    await this.#assertAllowed(to);
    const quote = await this.#wallet.getWithdrawalFeeQuote({
      amountSats: amount,
      withdrawalAddress: to,
    });
    if (dryRun) {
      // The SDK's quote shape varies by SDK version (sometimes a single
      // number, sometimes per-speed tiers). Surface the whole thing so the
      // caller can inspect; keep estimatedFee a best-effort scalar.
      const estimatedFee =
        quote?.[speed.toLowerCase()] ?? quote?.fee ?? quote ?? "unknown";
      return {
        dryRun: true,
        operation: "l1_withdraw",
        from: await this.#wallet.getSparkAddress(),
        to,
        amount: String(amount),
        unit: "sats",
        estimatedFee: String(estimatedFee),
        speed,
        network: "bitcoin",
        quote, // raw SDK quote, in case caller needs per-speed breakdown
      };
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
    this.#wallet.cleanupConnections();
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

// Run main() only when executed directly (node script.js), not when this
// file is imported as a module (e.g. `import { SparkAgent } from ...`).
// realpathSync handles symlinked invocations (e.g. via ~/.claude/skills).
const isMainModule =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isMainModule) {
  main().catch((err) => {
    console.error("Error:", err.message);
    process.exit(1);
  });
}
