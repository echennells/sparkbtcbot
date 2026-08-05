// SparkAgent.create(undefined) used to silently mint a fresh MAINNET wallet:
// the SDK generates a new mnemonic when mnemonicOrSeed is undefined, so a
// typo'd env var or failed seed decrypt booted an agent on an empty wallet
// whose seed nobody backed up — and inbound deposits landed there. create()
// must throw before the SDK is ever reached.
import { describe, it, expect, vi, afterEach } from "vitest";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";
import { SparkWallet } from "@buildonspark/spark-sdk";

describe("SparkAgent.create missing-mnemonic guard", () => {
  // No SDK mock needed: the throw must happen before SparkWallet.initialize,
  // so a network call (which would hang/fail the test) is itself the regression.
  for (const bad of [undefined, null, "", "   ", 0, new Uint8Array(0)]) {
    it(`throws on ${bad instanceof Uint8Array ? "empty Uint8Array" : JSON.stringify(bad)} instead of generating a wallet`, async () => {
      await expect(SparkAgent.create(bad, "MAINNET")).rejects.toThrow(/refusing to silently generate/i);
    });
  }

  it("points the operator at the deliberate setup path", async () => {
    await expect(SparkAgent.create(undefined)).rejects.toThrow(/npm run setup/);
  });
});

// A one-shot script that moves value then cleanup()s races the SDK's detached
// leaf optimizer ("...interrupted due to cleanup"). The escape hatch is to init
// with optimizationOptions.auto=false so there's nothing to interrupt. Pin that
// create()'s optimizeLeaves flag actually reaches the SDK — a silent drop of
// this plumbing would re-expose every one-shot value-mover to the race.
describe("SparkAgent.create leaf-optimization plumbing", () => {
  const origVault = process.env.SPARK_LEAF_VAULT;
  afterEach(() => {
    vi.restoreAllMocks();
    if (origVault === undefined) delete process.env.SPARK_LEAF_VAULT;
    else process.env.SPARK_LEAF_VAULT = origVault;
  });

  const initOptions = async (createArgs) => {
    process.env.SPARK_LEAF_VAULT = "off"; // skip vault so a bare fake wallet suffices
    const spy = vi.spyOn(SparkWallet, "initialize").mockResolvedValue({ wallet: {}, mnemonic: undefined });
    await SparkAgent.create(...createArgs);
    return spy.mock.calls[0][0].options;
  };

  it("defaults to auto-optimization ON (long-running agents want it)", async () => {
    const options = await initOptions(["word ".repeat(12).trim(), "REGTEST"]);
    expect(options.optimizationOptions).toEqual({ auto: true });
  });

  it("disables auto-optimization when { optimizeLeaves: false } (one-shot escape hatch)", async () => {
    const options = await initOptions(["word ".repeat(12).trim(), "REGTEST", { optimizeLeaves: false }]);
    expect(options.optimizationOptions).toEqual({ auto: false });
    expect(options.network).toBe("REGTEST");
  });
});
