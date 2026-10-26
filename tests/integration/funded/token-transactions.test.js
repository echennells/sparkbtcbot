// SparkAgent.getTokenTransactions / getTokenTransaction on hosted REGTEST, with
// real token sends of the funded wallet's test token. What it pins: entries
// come back newest first (the operators page oldest-first; the first version
// returned the wallet's OLDEST transactions, where an agent checking a send it
// just made would not find it), the hash a send returns finds the transaction,
// and each output reads as recipient address, mine or not, token and amount.
// Token sends cost no sats; the throwaway wallet sends its units back.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { SparkAgent } from "../../../skills/sparkbtcbot/scripts/spark-agent.js";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic } from "../../helpers/wallet.js";

const fundedMnemonic = getFundedMnemonic();
const describeFunded = fundedMnemonic ? describe : describe.skip;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The newest entry, once the operators have it with the wanted status.
const newestWith = async (agent, hash, { tokenIdentifier, status = "finalized", timeoutMs = 45_000 } = {}) => {
  const end = Date.now() + timeoutMs;
  let list = [];
  while (Date.now() < end) {
    list = await agent.getTokenTransactions({ tokenIdentifier, limit: 5 });
    if (list[0]?.hash === hash && list[0].status === status) return list;
    await sleep(1_500);
  }
  return list;
};

describeFunded("getTokenTransactions (REGTEST, real token sends)", () => {
  const origVault = process.env.SPARK_LEAF_VAULT;
  let payer, payerAddress, receiver, receiverAddress, tokenId;

  beforeAll(async () => {
    process.env.SPARK_LEAF_VAULT = "off";
    const { wallet: pw } = await createTestWallet({ mnemonic: fundedMnemonic });
    const { wallet: rw } = await createTestWallet();
    payer = new SparkAgent(pw, "REGTEST");
    receiver = new SparkAgent(rw, "REGTEST");
    payerAddress = await pw.getSparkAddress();
    receiverAddress = await rw.getSparkAddress();
    const { tokens } = await payer.getBalance();
    tokenId = Object.entries(tokens).find(([, t]) => BigInt(t.balance) >= 10n)?.[0];
    expect(tokenId, "the funded wallet holds no test token").toBeTruthy();
  }, 90_000);

  afterAll(async () => {
    if (origVault === undefined) delete process.env.SPARK_LEAF_VAULT;
    else process.env.SPARK_LEAF_VAULT = origVault;
    await cleanupAllWallets();
  }, 60_000);

  it("a send is the newest entry, found by its hash, with the recipient's output and the change", async () => {
    const hash = await payer.transferTokens({ tokenIdentifier: tokenId, amount: 1n, to: receiverAddress });
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    const list = await newestWith(payer, hash);
    expect(list[0]).toMatchObject({ hash, status: "finalized", statusCode: "TOKEN_TRANSACTION_FINALIZED", type: "transfer" });
    expect(list[0].createdAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(list[0].outputs).toContainEqual({ to: receiverAddress, mine: false, tokenIdentifier: tokenId, amount: "1" });
    expect(list[0].outputs.some((o) => o.mine && o.to === payerAddress && o.tokenIdentifier === tokenId)).toBe(true);
    expect(await payer.getTokenTransaction(hash)).toEqual(list[0]);

    // The receiver sees the same transaction, its own output marked mine.
    const theirs = await newestWith(receiver, hash);
    expect(theirs[0].outputs).toContainEqual({ to: receiverAddress, mine: true, tokenIdentifier: tokenId, amount: "1" });
  }, 120_000);

  it("newest first across sends, with and without the token filter", async () => {
    const first = await payer.transferTokens({ tokenIdentifier: tokenId, amount: 1n, to: receiverAddress });
    const second = await payer.transferTokens({ tokenIdentifier: tokenId, amount: 1n, to: receiverAddress });
    const list = await newestWith(payer, second, { tokenIdentifier: tokenId });
    expect(list.slice(0, 2).map((t) => t.hash)).toEqual([second, first]);
    const all = await payer.getTokenTransactions({ limit: 2 });
    expect(all.map((t) => t.hash)).toEqual([second, first]);
    // Not by createdAt: that is the sending client's clock, and two sends a few
    // ms apart came back stamped out of order (2026-10-26). The operators'
    // order is the real one.
  }, 120_000);

  it("the units go back: the payer's newest entry is the incoming one, marked mine", async () => {
    const back = await receiver.transferTokens({ tokenIdentifier: tokenId, amount: 3n, to: payerAddress });
    const list = await newestWith(payer, back);
    expect(list[0].outputs).toContainEqual({ to: payerAddress, mine: true, tokenIdentifier: tokenId, amount: "3" });
    expect(await payer.getTokenTransaction("00".repeat(32))).toBeNull();
  }, 120_000);
});
