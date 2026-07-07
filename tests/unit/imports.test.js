import { describe, it, expect } from "vitest";
import * as sdk from "@buildonspark/spark-sdk";
import * as issuerSdk from "@buildonspark/issuer-sdk";

describe("SDK imports", () => {
  it("exports SparkWallet with static initialize", () => {
    expect(sdk.SparkWallet).toBeDefined();
    expect(typeof sdk.SparkWallet.initialize).toBe("function");
  });

  it("exports the Network enum with REGTEST and MAINNET", () => {
    expect(sdk.Network).toBeDefined();
    expect(sdk.Network.MAINNET).toBeDefined();
    expect(sdk.Network.REGTEST).toBeDefined();
    expect(sdk.Network.TESTNET).toBeDefined();
    expect(sdk.Network.SIGNET).toBeDefined();
    expect(sdk.Network.LOCAL).toBeDefined();
  });

  it("exports SparkSdkError and the validation/auth/network subclasses", () => {
    expect(sdk.SparkSdkError).toBeDefined();
    expect(sdk.SparkValidationError).toBeDefined();
    expect(sdk.SparkAuthenticationError).toBeDefined();
    expect(sdk.NetworkError).toBeDefined();
  });

  it("exports the bech32m address helpers used in the skill examples", () => {
    expect(typeof sdk.encodeSparkAddress).toBe("function");
    expect(typeof sdk.decodeSparkAddress).toBe("function");
  });
});

describe("SparkWallet method surface", () => {
  const expectedMethods = [
    "getBalance",
    "getSparkAddress",
    "getIdentityPublicKey",
    "getStaticDepositAddress",
    "getSingleUseDepositAddress",
    "claimStaticDeposit",
    "claimStaticDepositWithMaxFee",
    "createSatsInvoice",
    "createTokensInvoice",
    "createLightningInvoice",
    "fulfillSparkInvoice",
    "transfer",
    "transferTokens",
    "batchTransferTokens",
    "payLightningInvoice",
    "getLightningSendFeeEstimate",
    "getLightningSendRequest",
    "getWithdrawalFeeQuote",
    "withdraw",
    "signMessageWithIdentityKey",
    "validateMessageWithIdentityKey",
    "getTransfers",
    "cleanup",
    "cleanupConnections",
    "on",
    "off",
  ];

  it.each(expectedMethods)("SparkWallet.prototype has %s", (name) => {
    let proto = sdk.SparkWallet.prototype;
    let found = false;
    while (proto && proto !== Object.prototype) {
      if (Object.prototype.hasOwnProperty.call(proto, name)) {
        found = true;
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }
    expect(found, `expected SparkWallet to expose ${name}() — examples and SKILL.md depend on it`).toBe(true);
  });
});

describe("IssuerSparkWallet method surface", () => {
  const expectedIssuerMethods = [
    "createToken",
    "mintTokens",
    "burnTokens",
    "freezeTokens",
    "unfreezeTokens",
    "getIssuerTokenIdentifier",
    "getIssuerTokenMetadata",
    "getIssuerTokenBalance",
    "transferTokens",
  ];

  it("exports IssuerSparkWallet with static initialize", () => {
    expect(issuerSdk.IssuerSparkWallet).toBeDefined();
    expect(typeof issuerSdk.IssuerSparkWallet.initialize).toBe("function");
  });

  it.each(expectedIssuerMethods)("IssuerSparkWallet.prototype has %s", (name) => {
    let proto = issuerSdk.IssuerSparkWallet.prototype;
    let found = false;
    while (proto && proto !== Object.prototype) {
      if (Object.prototype.hasOwnProperty.call(proto, name)) {
        found = true;
        break;
      }
      proto = Object.getPrototypeOf(proto);
    }
    expect(found, `expected IssuerSparkWallet to expose ${name}() — token-mint flows depend on it`).toBe(true);
  });
});
