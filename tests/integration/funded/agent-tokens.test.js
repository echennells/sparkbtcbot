// Sealed tokenLimits against a REAL token on REGTEST, through a real sealed
// seed: the limits are token amounts, and the only place the token's decimals
// come from is the wallet's own token metadata at send time. The unit tests
// mock that metadata; this is the test that it is really there and really
// used. The funded wallet is also the issuer of the SKILL test token (6
// decimals), so here "0.005" is 5,000 base units.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic } from "../../helpers/wallet.js";
import { getOrCreateIssuerToken, mintTo, cleanupAllIssuers } from "../../helpers/issuer.js";
import { createTestAgent, cleanupAllAgents } from "../../helpers/agent.js";

const fundedMnemonic = getFundedMnemonic();
const describeFunded = fundedMnemonic ? describe : describe.skip;

const tokenBalance = async (wallet, tokenId) => (await wallet.getBalance()).tokenBalances.get(tokenId)?.ownedBalance ?? 0n;
const waitForToken = async (wallet, tokenId, want) => {
  let have = 0n;
  for (let i = 0; i < 30 && have < want; i++) {
    have = await tokenBalance(wallet, tokenId);
    if (have < want) await new Promise((r) => setTimeout(r, 1_500));
  }
  return have;
};

describeFunded("sealed tokenLimits with a real token (REGTEST)", () => {
  let tokenId;
  let agent;
  let receiver;
  let to;

  beforeAll(async () => {
    const { wallet: issuer, tokenId: id } = await getOrCreateIssuerToken({ mnemonic: fundedMnemonic, tokenName: "SkillTest", tokenTicker: "SKILL" });
    tokenId = id;
    await mintTo(issuer, 20_000n); // supply for this run; the issuer is the funded wallet
    await cleanupAllIssuers(); // one SDK instance of the funded wallet at a time
    ({ agent } = await createTestAgent({
      mnemonic: fundedMnemonic,
      sealedPolicy: { tokenLimits: { [tokenId]: { maxPerTx: "0.005", dailyBudget: "0.008" } } },
    }));
    ({ wallet: receiver } = await createTestWallet());
    to = await receiver.getSparkAddress();
  }, 180_000);

  afterAll(async () => {
    await cleanupAllAgents();
    await cleanupAllWallets();
    await cleanupAllIssuers();
  });

  it("policy() reports the sealed limits as written", async () => {
    const p = await agent.policy();
    expect(p.sealed.tokenLimits).toEqual({ [tokenId]: { maxPerTx: "0.005", dailyBudget: "0.008" } });
    expect(p.tokens).toEqual({ limited: true });
  });

  it("the cap uses the token's real decimals: 5,001 base units is over \"0.005\", and nothing is sent", async () => {
    await expect(agent.transferTokens({ tokenIdentifier: tokenId, amount: 5_001n, to }))
      .rejects.toMatchObject({ code: "POLICY_DENIED", rule: "tokenLimits", reason: expect.stringMatching(/^0\.005001 of btknrt1\S+ exceeds its 0\.005 per-transaction cap/) });
    await new Promise((r) => setTimeout(r, 2_000));
    expect(await tokenBalance(receiver, tokenId)).toBe(0n);
  });

  it("a batch is capped by the token's total (dry run: nothing moves either way)", async () => {
    const entry = (amount) => ({ tokenIdentifier: tokenId, tokenAmount: amount, receiverSparkAddress: to });
    await expect(agent.batchTransferTokens([entry(3_000n), entry(3_000n)], { dryRun: true }))
      .rejects.toMatchObject({ rule: "tokenLimits", reason: expect.stringMatching(/^0\.006 of/) });
    const preview = await agent.batchTransferTokens([entry(2_000n), entry(3_000n)], { dryRun: true });
    expect(preview.totals).toEqual([{ tokenIdentifier: tokenId, amount: "5000" }]);
  });

  it("at the cap it sends; the receiver holds exactly those base units; spendStatus reads in token amounts", async () => {
    await agent.transferTokens({ tokenIdentifier: tokenId, amount: 5_000n, to });
    expect(await waitForToken(receiver, tokenId, 5_000n)).toBe(5_000n);
    expect((await agent.spendStatus()).tokens[tokenId]).toEqual({
      decimals: 6, spent: "0.005", spentBaseUnits: "5000", budget: "0.008", remaining: "0.003",
    });
  });

  it("the daily budget stops the next send, in token amounts; exactly the remainder still fits", async () => {
    await expect(agent.transferTokens({ tokenIdentifier: tokenId, amount: 3_001n, to }))
      .rejects.toMatchObject({ code: "SPEND_BUDGET_EXCEEDED", message: expect.stringMatching(/spending 0\.003001 of \S+ would exceed its 0\.008 budget \(0\.005 already spent/) });
    await agent.transferTokens({ tokenIdentifier: tokenId, amount: 3_000n, to });
    expect(await waitForToken(receiver, tokenId, 8_000n)).toBe(8_000n);
    expect((await agent.spendStatus()).tokens[tokenId]).toMatchObject({ spent: "0.008", remaining: "0" });
  });

  it("a limit more precise than the token (7 places for a 6-decimal token) refuses rather than rounds", async () => {
    const { agent: precise } = await createTestAgent({
      mnemonic: fundedMnemonic,
      sealedPolicy: { tokenLimits: { [tokenId]: { maxPerTx: "0.0050001" } } },
    });
    await expect(precise.transferTokens({ tokenIdentifier: tokenId, amount: 1n, to }))
      .rejects.toMatchObject({ rule: "tokenLimits", reason: expect.stringMatching(/more decimal places than the token \(6\)/) });
  });
});
