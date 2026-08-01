// SparkAgent.create(undefined) used to silently mint a fresh MAINNET wallet:
// the SDK generates a new mnemonic when mnemonicOrSeed is undefined, so a
// typo'd env var or failed seed decrypt booted an agent on an empty wallet
// whose seed nobody backed up — and inbound deposits landed there. create()
// must throw before the SDK is ever reached.
import { describe, it, expect } from "vitest";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

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
