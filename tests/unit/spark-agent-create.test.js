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
    // A fixed phrase, not a random one: a random phrase starting with a word
    // like "create" matched the stack trace's "SparkAgent.create" and failed
    // the no-echo check now and then.
    for (const bad of ["zebra apple not real words at all here ok fine done", "my-passphrase-by-mistake", "deadbeef", "legal winner thank year wave sausage worth useful legal winner thank zoo zoo"]) {
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

// ToB review 2026-10-28 (F24): initialize() starts the wallet's stream before
// its first sync and stops nothing when that sync fails, so each retry of a
// flapping open left one more live wallet claiming in the background.
// OUT-2 (review 2026-11-09): the constructor's refusal left the opened wallet running.
describe("SparkAgent.create closes the wallet when the agent can't be built on it", () => {
  it("a constructor refusal (BAD_CONFIG) closes the opened wallet and is thrown as is", async () => {
    const init = spyInitialize();
    const { wallet } = await init.getMockImplementation()();
    const cleanup = vi.spyOn(wallet, "cleanup");
    const saved = process.env.SPARK_DAILY_BUDGET_SATS;
    process.env.SPARK_DAILY_BUDGET_SATS = "lots";
    try {
      await expect(SparkAgent.create(generateMnemonic(wordlist), "REGTEST")).rejects.toMatchObject({ code: "BAD_CONFIG" });
    } finally {
      if (saved === undefined) delete process.env.SPARK_DAILY_BUDGET_SATS; else process.env.SPARK_DAILY_BUDGET_SATS = saved;
    }
    expect(cleanup).toHaveBeenCalledTimes(1);
  });
});

describe("SparkAgent.create closes a wallet whose open failed half-way", () => {
  it("the half-built wallet is cleaned up, and the failure is SPARK_UNAVAILABLE 'yes'", async () => {
    process.env.SPARK_LEAF_VAULT = "off";
    const built = [];
    const closed = vi.spyOn(SparkWallet.prototype, "cleanup").mockImplementation(async function () { closed.instances.push(this); });
    closed.instances = [];
    vi.spyOn(SparkWallet, "initialize").mockImplementation(async function ({ options }) {
      built.push(new this(options)); // as the SDK does: `new this(...)`, then the sync
      throw Object.assign(new Error("14 UNAVAILABLE: No connection established"), { code: 14, details: "No connection established" });
    });
    const err = await SparkAgent.create(generateMnemonic(wordlist), "REGTEST", { optimizeLeaves: false }).catch((e) => e);
    expect(err).toMatchObject({ code: "SPARK_UNAVAILABLE", retryable: "yes" });
    expect(built).toHaveLength(1);
    expect(closed.instances).toEqual(built);
  });

  it("a failure before anything was built has nothing to close", async () => {
    process.env.SPARK_LEAF_VAULT = "off";
    const closed = vi.spyOn(SparkWallet.prototype, "cleanup").mockResolvedValue(undefined);
    vi.spyOn(SparkWallet, "initialize").mockRejectedValue(Object.assign(new Error("14 UNAVAILABLE"), { code: 14, details: "No connection established" }));
    await expect(SparkAgent.create(generateMnemonic(wordlist), "REGTEST")).rejects.toMatchObject({ code: "SPARK_UNAVAILABLE" });
    expect(closed).not.toHaveBeenCalled();
  });
});
