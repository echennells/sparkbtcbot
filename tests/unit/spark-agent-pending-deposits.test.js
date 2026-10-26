// getBalance() reflects only CLAIMED Spark balance, so a confirmed-but-unclaimed
// L1 deposit is invisible there — an agent asked "did my deposit arrive?" answers
// "no" for funds that confirmed an hour ago. listPendingDeposits() is the method
// that answers it: it lists the confirmed-unclaimed UTXOs across every deposit
// address, static and unclaimed single-use. These tests pin the flattening and — critically — that it
// requests UNCLAIMED only (excludeClaimed=true); dropping that would report
// already-claimed UTXOs as pending and drive the agent to re-claim them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

const origVault = process.env.SPARK_LEAF_VAULT;
beforeEach(() => { process.env.SPARK_LEAF_VAULT = "off"; });
afterEach(() => {
  if (origVault === undefined) delete process.env.SPARK_LEAF_VAULT;
  else process.env.SPARK_LEAF_VAULT = origVault;
});

describe("listPendingDeposits", () => {
  it("flattens unclaimed UTXOs across every deposit address, requesting UNCLAIMED only", async () => {
    const calls = [];
    const wallet = {
      queryStaticDepositAddresses: async () => ["bc1pAAA", "bc1pBBB"],
      getUnusedDepositAddresses: async () => [],
      getUtxosForDepositAddress: async (addr, limit, offset, excludeClaimed) => {
        calls.push({ addr, limit, offset, excludeClaimed });
        return addr === "bc1pAAA"
          ? [{ txid: "t1", vout: 0 }, { txid: "t2", vout: 1 }]
          : [{ txid: "t3", vout: 0 }];
      },
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    const pending = await agent.listPendingDeposits();
    expect(pending).toEqual([
      { address: "bc1pAAA", txid: "t1", vout: 0, type: "static" },
      { address: "bc1pAAA", txid: "t2", vout: 1, type: "static" },
      { address: "bc1pBBB", txid: "t3", vout: 0, type: "static" },
    ]);
    // excludeClaimed MUST be true — else already-claimed UTXOs show as pending
    // and the agent re-claims them.
    expect(calls.every((c) => c.excludeClaimed === true)).toBe(true);
    expect(calls.map((c) => c.addr)).toEqual(["bc1pAAA", "bc1pBBB"]);
  });

  it("returns [] when nothing is unclaimed (the honest 'not yet' answer)", async () => {
    const wallet = {
      queryStaticDepositAddresses: async () => ["bc1pAAA"],
      getUnusedDepositAddresses: async () => [],
      getUtxosForDepositAddress: async () => [],
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    expect(await agent.listPendingDeposits()).toEqual([]);
  });

  it("returns [] and never queries UTXOs when there are no deposit addresses", async () => {
    const wallet = {
      queryStaticDepositAddresses: async () => [],
      getUnusedDepositAddresses: async () => [],
      getUtxosForDepositAddress: async () => { throw new Error("should not be reached"); },
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    expect(await agent.listPendingDeposits()).toEqual([]);
  });

  it("includes unclaimed single-use addresses, typed, and asks about each address once", async () => {
    // A funded single-use address stays on the operators' unused list until it
    // is claimed (REGTEST, 2026-10-26); it used to be invisible here, so coins
    // sent to one read as "not arrived".
    const asked = [];
    const wallet = {
      queryStaticDepositAddresses: async () => ["bc1pSTATIC"],
      getUnusedDepositAddresses: async () => ["bc1pONCE", "bc1pSTATIC"],
      getUtxosForDepositAddress: async (addr) => {
        asked.push(addr);
        return addr === "bc1pONCE" ? [{ txid: "t9", vout: 1 }] : [];
      },
    };
    const agent = new SparkAgent(wallet, "MAINNET");
    expect(await agent.listPendingDeposits()).toEqual([{ address: "bc1pONCE", txid: "t9", vout: 1, type: "single-use" }]);
    expect(asked).toEqual(["bc1pSTATIC", "bc1pONCE"]);
  });
});
