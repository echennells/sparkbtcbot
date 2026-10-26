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

// claimDeposit used to trust a `type` the caller passed. Called without one on
// a single-use deposit, its dry run showed the SSP's quote (1,703 sats credit
// on a 2,000-sat mainnet single-use deposit, 2026-10-26) and the claim then
// failed with "Static deposit address … not found". It now asks the operators
// where the deposit sits, and only a static deposit reaches the quote.
describe("claimDeposit looks the deposit up itself", () => {
  const TX = "d4".repeat(32);
  const mk = ({ statics = ["bc1pSTATIC"], singles = [], utxos = {} } = {}) => {
    const calls = { quotes: 0, claim: null, asked: [] };
    const wallet = {
      queryStaticDepositAddresses: async () => statics,
      getUnusedDepositAddresses: async () => singles,
      getUtxosForDepositAddress: async (addr, limit, offset, excludeClaimed) => {
        calls.asked.push({ addr, offset, excludeClaimed });
        return (utxos[addr] ?? []).slice(offset, offset + limit);
      },
      getClaimStaticDepositQuote: async () => { calls.quotes++; return { creditAmountSats: 9_000 }; },
      claimStaticDepositWithMaxFee: async (p) => { calls.claim = p; return { claimed: true }; },
    };
    return { agent: new SparkAgent(wallet, "MAINNET"), calls };
  };

  it("claims a deposit the operators list at the static address", async () => {
    const { agent, calls } = mk({ utxos: { bc1pSTATIC: [{ txid: TX, vout: 2 }] } });
    await agent.claimDeposit({ txid: TX, vout: 2 });
    expect(calls.claim).toEqual({ transactionId: TX, maxFee: 900, outputIndex: 2 });
    expect(calls.asked.every((c) => c.excludeClaimed === true)).toBe(true);
  });

  it("refuses a single-use deposit, dry run included, before any quote", async () => {
    const { agent, calls } = mk({ singles: ["bc1pONCE"], utxos: { bc1pONCE: [{ txid: TX, vout: 0 }] } });
    for (const dryRun of [true, false]) {
      await expect(agent.claimDeposit({ txid: TX, vout: 0, dryRun }))
        .rejects.toMatchObject({ code: "SINGLE_USE_DEPOSITS_UNAVAILABLE", message: expect.stringMatching(/recovery words/) });
    }
    expect(calls.quotes).toBe(0);
    expect(calls.claim).toBeNull();
  });

  it("refuses a deposit it can't find (another vout, claimed, unconfirmed, elsewhere), before any quote", async () => {
    const { agent, calls } = mk({ utxos: { bc1pSTATIC: [{ txid: TX, vout: 0 }] } });
    for (const args of [{ txid: TX, vout: 1 }, { txid: "e5".repeat(32) }, { txid: "e5".repeat(32), dryRun: true }]) {
      await expect(agent.claimDeposit(args)).rejects.toMatchObject({ code: "DEPOSIT_NOT_FOUND" });
    }
    expect(calls.quotes).toBe(0);
  });

  it("pages through a busy static address", async () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ txid: "f6".repeat(32), vout: i }));
    const { agent, calls } = mk({ utxos: { bc1pSTATIC: many } });
    await agent.claimDeposit({ txid: "f6".repeat(32), vout: 120, maxFeeSats: 500 });
    expect(calls.claim).toMatchObject({ outputIndex: 120 });
    expect(calls.asked.map((c) => c.offset)).toEqual([0, 100]);
  });

  // ToB review of 375e6fb..HEAD: both address lists were fetched together, so a
  // failing single-use query failed static claims too; and a server ignoring
  // the offset kept the lookup paging forever.
  it("a static claim doesn't depend on the single-use address query", async () => {
    const broken = new SparkAgent({
      queryStaticDepositAddresses: async () => ["bc1pSTATIC"],
      getUnusedDepositAddresses: async () => { throw new Error("UNAVAILABLE"); },
      getUtxosForDepositAddress: async () => [{ txid: TX, vout: 0 }],
      getClaimStaticDepositQuote: async () => ({ creditAmountSats: 9_000 }),
      claimStaticDepositWithMaxFee: async (p) => p,
    }, "MAINNET");
    await expect(broken.claimDeposit({ txid: TX, maxFeeSats: 500 })).resolves.toMatchObject({ transactionId: TX });
  });

  it("stops paging when the server returns the same page again", async () => {
    let asked = 0;
    const page = Array.from({ length: 100 }, (_, i) => ({ txid: "a7".repeat(32), vout: i }));
    const agent = new SparkAgent({
      queryStaticDepositAddresses: async () => ["bc1pSTATIC"],
      getUnusedDepositAddresses: async () => [],
      getUtxosForDepositAddress: async () => { asked++; return page; }, // ignores offset
    }, "MAINNET");
    await expect(agent.claimDeposit({ txid: TX, maxFeeSats: 500 })).rejects.toMatchObject({ code: "DEPOSIT_NOT_FOUND" });
    expect(asked).toBe(2);
  });

  it("matches a txid in any case", async () => {
    const { agent, calls } = mk({ utxos: { bc1pSTATIC: [{ txid: TX, vout: 0 }] } });
    await agent.claimDeposit({ txid: TX.toUpperCase(), maxFeeSats: 500 });
    expect(calls.claim).not.toBeNull();
  });

  it("checks txid and vout before asking anyone, and no longer takes a `type`", async () => {
    const { agent, calls } = mk();
    await expect(agent.claimDeposit({ txid: "t9" })).rejects.toThrow(/64-character hex/);
    await expect(agent.claimDeposit({ txid: TX, vout: -1 })).rejects.toThrow(/vout must be a non-negative integer/);
    await expect(agent.claimDeposit({ txid: TX, type: "static" })).rejects.toThrow(/unknown option.*type/i);
    expect(calls.asked).toEqual([]);
  });
});

describe("getSingleUseDepositAddress", () => {
  it("refuses: the operators currently refuse single-use claims, so the address would trap coins", async () => {
    let asked = false;
    const agent = new SparkAgent({ getSingleUseDepositAddress: async () => { asked = true; return "bc1pX"; } }, "MAINNET");
    await expect(agent.getSingleUseDepositAddress()).rejects.toMatchObject({ code: "SINGLE_USE_DEPOSITS_UNAVAILABLE", message: expect.stringMatching(/getDepositAddress\(\).*Lightning invoice/s) });
    expect(asked).toBe(false);
  });
});
