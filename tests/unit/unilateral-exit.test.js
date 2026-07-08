// Regression tests for the unilateral-exit review fixes that are unit-testable
// without a live bitcoind. (H-1's confirmation-height logic needs a real mempool /
// signet run — regtest confirms instantly and cannot reproduce it.)
import { describe, it, expect } from "vitest";
import { loadConfig } from "../../skills/sparkbtcbot/scripts/unilateral-exit.js";

const base = { SPARK_BITCOIN_RPC_URL: "http://127.0.0.1:8332" };

describe("loadConfig regtest-mine network guard (M-3)", () => {
  it("REFUSES SPARK_EXIT_REGTEST_MINE on MAINNET (would send real BTC to a throwaway key)", () => {
    expect(() => loadConfig({ ...base, SPARK_EXIT_REGTEST_MINE: "true", SPARK_NETWORK: "MAINNET" }, [])).toThrow(/regtest-only/i);
  });
  it("allows it on REGTEST and LOCAL", () => {
    expect(() => loadConfig({ ...base, SPARK_EXIT_REGTEST_MINE: "true", SPARK_NETWORK: "REGTEST" }, [])).not.toThrow();
    expect(() => loadConfig({ ...base, SPARK_EXIT_REGTEST_MINE: "true", SPARK_NETWORK: "LOCAL" }, [])).not.toThrow();
  });
  it("does not affect the normal (no-flag) MAINNET path", () => {
    const cfg = loadConfig({ ...base, SPARK_NETWORK: "MAINNET" }, []);
    expect(cfg.network).toBe("MAINNET");
    expect(cfg.regtestMine).toBe(false);
  });
});
