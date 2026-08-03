# Complete SparkAgent Class

Load when building an agent that wraps `SparkWallet` with a higher-level API for identity, balance, transfers, Lightning, Spark invoices, tokens, withdrawal, message signing, L402 paywalls, and event listeners. Drop-in implementation.

```javascript
import { SparkWallet } from "@buildonspark/spark-sdk";
import {
  loadRecipientsAllowlist,
  assertRecipientAllowed,
} from "./lib/recipients-allowlist.js";

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

  // Outbound allowlist gate. Reads ~/.spark/recipients.allow on every send.
  // Missing/empty file = not enforced. Present = `to` must match an entry
  // exactly. Bypass = edit the file. Guardrail against agent surprise, not
  // a defense against a compromised agent.
  async #assertAllowed(address) {
    const allowlist = await loadRecipientsAllowlist();
    assertRecipientAllowed(address, allowlist);
  }

  async getIdentity() {
    return {
      address: await this.#wallet.getSparkAddress(),
      publicKey: await this.#wallet.getIdentityPublicKey(),
    };
  }

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

  async getDepositAddress() {
    return await this.#wallet.getStaticDepositAddress();
  }

  // `dryRun: true` returns a structured preview without signing. Use it to
  // confirm the destination/amount with the operator before spending:
  //   await agent.transfer({ to, amount, dryRun: true })
  //     → { dryRun, operation, from, to, amount, estimatedFee: "0", network }
  // Allowlist enforcement applies in BOTH modes so dry-runs can't be used
  // to "test" a send to a disallowed address.
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

  async createLightningInvoice(amountSats, memo) {
    const request = await this.#wallet.createLightningInvoice({
      amountSats,
      memo,
      expirySeconds: 3600,
      includeSparkAddress: true,
    });
    return request.invoice.encodedInvoice;
  }

  // Lightning recipients are node pubkeys inside the BOLT11; the address
  // allowlist (Spark/L1 addresses) does not apply. `dryRun: true` returns
  // an estimated routing fee without paying.
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

  async createSparkInvoice(amountSats, memo) {
    return await this.#wallet.createSatsInvoice({
      amount: amountSats,
      memo,
    });
  }

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
        estimatedFee: "0",
        network: this.#network,
      };
    }
    return await this.#wallet.transferTokens({
      tokenIdentifier,
      tokenAmount: amount,
      receiverSparkAddress: to,
    });
  }

  // L1 exit. Allowlist applies to the L1 BTC `to` address. `dryRun` returns
  // the fee quote without broadcasting.
  async withdraw({ to, amount, speed = "MEDIUM", dryRun = false }) {
    await this.#assertAllowed(to);
    const quote = await this.#wallet.getWithdrawalFeeQuote({
      amountSats: amount,
      withdrawalAddress: to,
    });
    if (dryRun) {
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
        quote,
      };
    }
    return await this.#wallet.withdraw({
      onchainAddress: to,
      exitSpeed: speed,
      amountSats: amount,
    });
  }

  async signMessage(text) {
    return await this.#wallet.signMessageWithIdentityKey(text);
  }

  // Validates a signature against THIS agent's own identity key. For
  // verifying a signature from another party, use secp256k1.verify directly.
  async verifyOwnSignature(text, signature) {
    return await this.#wallet.validateMessageWithIdentityKey(text, signature);
  }

  // L402 paywall payments are deliberately not part of this class. See
  // scripts/l402-paywalls.js for the runnable fetchWithL402/previewL402
  // implementation (pass your wallet as the first argument) and
  // references/l402.md for the protocol details.

  onTransferReceived(callback) {
    this.#wallet.on("transfer:claimed", callback);
  }

  onDepositConfirmed(callback) {
    this.#wallet.on("deposit:confirmed", callback);
  }

  cleanup() {
    this.#wallet.cleanupConnections();
  }
}

// Usage
import { loadMnemonicFromEnv } from "./lib/encrypted-seed.js";

const mnemonic = await loadMnemonicFromEnv(); // reads SPARK_PASSPHRASE
const { agent } = await SparkAgent.create(mnemonic);

const identity = await agent.getIdentity();
console.log("Address:", identity.address);

const { sats } = await agent.getBalance();
console.log("Balance:", sats.toString(), "sats");

agent.cleanup();
```

A working file lives at `skills/sparkbtcbot/scripts/spark-agent.js` — runnable via `npm run example:agent`.
