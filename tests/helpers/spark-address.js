// Well-formed Spark addresses for unit tests that never reach an operator. A
// dry run now decodes the recipient the way the SDK does at send time, so a
// placeholder like "sp1x" no longer passes.
import { encodeSparkAddress } from "@buildonspark/spark-sdk";

// The secp256k1 generator point: a valid key that names no real wallet.
export const TEST_IDENTITY_PUBKEY = "0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";

export const testSparkAddress = (network = "MAINNET", identityPublicKey = TEST_IDENTITY_PUBKEY) =>
  encodeSparkAddress({ identityPublicKey, network });

export const testSparkInvoice = (network = "MAINNET", { amount = 1000, identityPublicKey = TEST_IDENTITY_PUBKEY } = {}) =>
  encodeSparkAddress({
    identityPublicKey,
    network,
    sparkInvoiceFields: {
      version: 1,
      id: new Uint8Array(16).fill(9),
      paymentType: { $case: "satsPayment", satsPayment: { amount } },
    },
  });
