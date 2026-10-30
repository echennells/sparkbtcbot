// SparkAgent.create and the recovery phrase it is handed. The SDK reads any
// string that isn't a mnemonic as a hex seed and fails locally; that came back
// as SPARK_REFUSED ("Spark refused the request") with characters of the input
// in the message (ToB review 2026-10-28, F39).
import { describe, it, expect, afterEach, vi } from "vitest";
import { inspect } from "node:util";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

const orig = process.env.SPARK_LEAF_VAULT;
afterEach(() => {
  vi.restoreAllMocks();
  if (orig === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = orig;
});
const spyInitialize = () => {
  process.env.SPARK_LEAF_VAULT = "off";
  const wallet = { getSparkAddress: async () => "sp1x", getWalletSettings: async () => ({ privateEnabled: true }), setPrivacyEnabled: async () => ({}), cleanup: async () => {} };
  return vi.spyOn(SparkWallet, "initialize").mockImplementation(async () => ({ wallet, mnemonic: undefined }));
};

describe("SparkAgent.create checks the recovery phrase before opening anything", () => {
  it("a string that isn't a BIP39 phrase is BAD_INPUT (mnemonic), never echoed, and the SDK is not called", async () => {
    const init = spyInitialize();
    for (const bad of ["zebra apple not real words at all here ok fine done", "my-passphrase-by-mistake", "deadbeef", generateMnemonic(wordlist).replace(/\w+$/, "zoo zoo")]) {
      const err = await SparkAgent.create(bad, "REGTEST").catch((e) => e);
      expect(err).toMatchObject({ code: "BAD_INPUT", field: "mnemonic", retryable: "no" });
      expect(err.message).toMatch(/not a valid BIP39 recovery phrase \(its words are not shown here\)/);
      expect(inspect(err)).not.toContain(bad.slice(0, 6));
    }
    expect(init).not.toHaveBeenCalled();
  });

  it("case, extra spaces and a trailing newline don't change the words: the same wallet opens", async () => {
    const init = spyInitialize();
    const words = generateMnemonic(wordlist);
    await SparkAgent.create(`  ${words.toUpperCase().split(" ").join("   ")}\n`, "REGTEST", { optimizeLeaves: false });
    expect(init.mock.calls[0][0].mnemonicOrSeed).toBe(words);
  });

  it("a seed as bytes passes through unchanged", async () => {
    const init = spyInitialize();
    const seed = new Uint8Array(64).fill(7);
    await SparkAgent.create(seed, "REGTEST", { optimizeLeaves: false });
    expect(init.mock.calls[0][0].mnemonicOrSeed).toBe(seed);
  });
});
