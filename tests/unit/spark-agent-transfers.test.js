// agent.getTransfers takes the raw SDK's arguments, time window included: the
// window used to be dropped, so "what did I receive this month" needed the raw
// SDK (full eval run, 2026-10-27, eval 38). The SDK takes one bound, not both.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { SparkAgent } from "../../skills/sparkbtcbot/scripts/spark-agent.js";

const orig = process.env.SPARK_LEAF_VAULT;
beforeEach(() => { process.env.SPARK_LEAF_VAULT = "off"; });
afterEach(() => { if (orig === undefined) delete process.env.SPARK_LEAF_VAULT; else process.env.SPARK_LEAF_VAULT = orig; });

const mk = () => {
  const calls = [];
  const agent = new SparkAgent({ getTransfers: async (...a) => { calls.push(a); return { transfers: [], offset: 0 }; } }, "MAINNET");
  return { agent, calls };
};

describe("getTransfers", () => {
  it("passes limit, offset and one time bound through", async () => {
    const { agent, calls } = mk();
    const since = new Date("2026-10-01T04:00:00Z");
    await agent.getTransfers();
    await agent.getTransfers(50, 10, since);
    await agent.getTransfers(50, 0, undefined, since);
    expect(calls).toEqual([[10, 0, undefined, undefined], [50, 10, since, undefined], [50, 0, undefined, since]]);
  });

  it("refuses a bound that isn't a valid Date, and both bounds together", async () => {
    const { agent, calls } = mk();
    await expect(agent.getTransfers(10, 0, "2026-10-01")).rejects.toThrow(/createdAfter must be a Date/);
    await expect(agent.getTransfers(10, 0, new Date("nope"))).rejects.toThrow(/createdAfter must be a Date/);
    await expect(agent.getTransfers(10, 0, new Date(), new Date())).rejects.toThrow(/not both/);
    expect(calls).toEqual([]);
  });
});
