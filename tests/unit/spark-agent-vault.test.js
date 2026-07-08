// Regression test for the SparkAgent leaf-vault opt-out normalization (L-3):
// off / false / 0 / no (any case, trimmed) must disable the vault. Only the
// disable path is exercised here — it takes no wallet and has no filesystem side
// effects (enabling would snapshot to ~/.spark).
import { describe, it, expect, afterEach } from "vitest";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

describe("SparkAgent SPARK_LEAF_VAULT opt-out normalization (L-3)", () => {
  const orig = process.env.SPARK_LEAF_VAULT;
  afterEach(() => { if (orig === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = orig; });

  for (const val of ["off", "OFF", "false", "0", "no", " off "]) {
    it(`treats SPARK_LEAF_VAULT=${JSON.stringify(val)} as disabled`, () => {
      process.env.SPARK_LEAF_VAULT = val;
      const agent = new SparkAgent({}, "LOCAL"); // wallet unused on the disabled path
      expect(agent.vaultHealth()).toEqual({ disabled: true });
    });
  }
});
