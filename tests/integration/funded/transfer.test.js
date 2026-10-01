import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic } from "../../helpers/wallet.js";
import { getOrCreateIssuerToken, mintTo, cleanupAllIssuers } from "../../helpers/issuer.js";
import { waitForSats, returnSats, waitForClaimed } from "../../helpers/agent.js";

const fundedMnemonic = getFundedMnemonic();
const itFunded = fundedMnemonic ? it : it.skip;

describe("funded transfer (REGTEST)", () => {
  let sender;
  let receiver;
  let issuerWallet;
  let tokenId;

  beforeAll(async () => {
    if (!fundedMnemonic) return;
    ({ wallet: sender } = await createTestWallet({ mnemonic: fundedMnemonic }));
    ({ wallet: receiver } = await createTestWallet());

    // The funded mnemonic also acts as the token issuer. First run creates
    // the token; later runs reuse it. Either way, mint a small amount before
    // the token-transfer test so the issuer wallet has spendable supply.
    ({ wallet: issuerWallet, tokenId } = await getOrCreateIssuerToken({
      mnemonic: fundedMnemonic,
      tokenName: "SkillTest",
      tokenTicker: "SKILL",
    }));
    await mintTo(issuerWallet, 1_000n);
  }, 120_000);

  afterAll(async () => {
    if (sender) {
      const readAvailable = async () => (await sender.getBalance()).satsBalance.available;
      const before = await readAvailable();
      await waitForClaimed(readAvailable, before + (await returnSats(receiver, await sender.getSparkAddress())));
    }
    await cleanupAllWallets();
    await cleanupAllIssuers();
  }, 90_000);

  itFunded("sender wallet has a non-zero sats balance", async () => {
    const { satsBalance } = await sender.getBalance();
    expect(satsBalance.available).toBeGreaterThan(0n);
  });

  itFunded("transfers 100 sats sender → receiver", async () => {
    const receiverAddr = await receiver.getSparkAddress();
    const transfer = await sender.transfer({
      receiverSparkAddress: receiverAddr,
      amountSats: 100,
    });
    expect(transfer).toBeDefined();
    expect(transfer.id).toBeDefined();

    const b = await waitForSats(receiver, 100n);
    expect(b.available + b.incoming).toBe(100n); // a fresh wallet: exactly what was sent
  });

  itFunded("issuer wallet holds the minted token", async () => {
    const { tokenBalances } = await issuerWallet.getBalance();
    expect(tokenBalances.size).toBeGreaterThan(0);
    const entry = tokenBalances.get(tokenId);
    expect(entry).toBeDefined();
    expect(entry.ownedBalance).toBeGreaterThan(0n);
  });

  itFunded("transfers tokens issuer → receiver via transferTokens", async () => {
    const receiverAddr = await receiver.getSparkAddress();
    const transferAmount = 100n;

    const before = await issuerWallet.getBalance();
    const beforeAmount = before.tokenBalances.get(tokenId)?.ownedBalance ?? 0n;
    expect(beforeAmount).toBeGreaterThanOrEqual(transferAmount);

    const txId = await issuerWallet.transferTokens({
      tokenIdentifier: tokenId,
      tokenAmount: transferAmount,
      receiverSparkAddress: receiverAddr,
    });
    expect(txId).toBeDefined();

    // poll rather than sleep a fixed 5s: token outputs can take longer to show
    let recvEntry;
    for (let i = 0; i < 30 && !(recvEntry?.ownedBalance >= transferAmount); i++) {
      await new Promise((r) => setTimeout(r, 1500));
      recvEntry = (await receiver.getBalance()).tokenBalances.get(tokenId);
    }
    expect(recvEntry, `receiver should hold token ${tokenId}`).toBeDefined();
    expect(recvEntry.ownedBalance).toBeGreaterThanOrEqual(transferAmount);
  });
});
