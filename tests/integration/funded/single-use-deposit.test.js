// A single-use deposit address, end to end on hosted REGTEST, with real L1
// coins: a funded wallet withdraws to a fresh wallet's single-use deposit
// address. What it pins:
//   - SparkAgent.listPendingDeposits() reports the deposit, typed
//     "single-use" (a funded single-use address stays on the operators'
//     unused list until it is claimed, and the per-address lookup sees it);
//   - the claim step is switched off by the operators: the SDK's
//     claimDeposit(txid) fails in finalize_deposit_tree_creation with
//     UNAVAILABLE "the method is currently unavailable". The same method
//     answers UNAVAILABLE to an empty request on MAINNET (2026-10-26). If this
//     assertion starts failing because the claim WORKS, the operators turned
//     it back on: update references/wallet.md and SparkAgent's single-use
//     paths.
// Each run strands its few REGTEST sats at the unclaimable address.
//
// Slow (L1 confirmations, a few minutes): runs only with SPARK_L1_TESTS=1 on
// top of the funded mnemonic.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getElectrsUrl } from "@buildonspark/spark-sdk";
import { SparkAgent } from "../../../skills/sparkbtcbot/scripts/spark-agent.js";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic, waitForSettled, returnSats, waitForClaimed } from "../../helpers/wallet.js";

const fundedMnemonic = getFundedMnemonic();
const describeL1 = fundedMnemonic && process.env.SPARK_L1_TESTS === "1" ? describe : describe.skip;
const FUNDING = 6_000;
const AMOUNT = 5_000;
const MAX_FEE_PCT = 60; // the REGTEST SSP's flat ~2,200-sat exit fee (see silent-payment-withdraw.test.js)
const WATCH_MS = 20 * 60_000;

const confirmations = async (txid) => {
  const base = getElectrsUrl("REGTEST");
  const tx = await (await fetch(`${base}/tx/${txid}`)).json().catch(() => null);
  if (!tx?.status?.confirmed) return 0;
  const tip = Number(await (await fetch(`${base}/blocks/tip/height`)).text());
  return tip - tx.status.block_height + 1;
};

describeL1("single-use deposit address (REGTEST, real L1)", () => {
  const origVault = process.env.SPARK_LEAF_VAULT;
  let payer, payerAddress, funder, receiver;

  beforeAll(async () => {
    process.env.SPARK_LEAF_VAULT = "off";
    ({ wallet: payer } = await createTestWallet({ mnemonic: fundedMnemonic }));
    payerAddress = await payer.getSparkAddress();
    ({ wallet: funder } = await createTestWallet());
    ({ wallet: receiver } = await createTestWallet());
    await payer.transfer({ receiverSparkAddress: await funder.getSparkAddress(), amountSats: FUNDING });
    expect(await waitForSettled(funder, BigInt(FUNDING), { timeoutMs: 60_000 })).toEqual({ available: BigInt(FUNDING), incoming: 0n });
  }, 120_000);

  afterAll(async () => {
    if (origVault === undefined) delete process.env.SPARK_LEAF_VAULT;
    else process.env.SPARK_LEAF_VAULT = origVault;
    const readAvailable = async () => (await payer.getBalance()).satsBalance.available;
    const before = await readAvailable();
    let returned = 0n;
    for (const w of [funder, receiver]) if (w) returned += await returnSats(w, payerAddress);
    if (returned > 0n) await waitForClaimed(readAvailable, before + returned);
    await cleanupAllWallets();
  }, 180_000);

  it("listPendingDeposits reports it as single-use; the operators refuse the claim", async () => {
    const agent = new SparkAgent(receiver, "REGTEST");
    const address = await agent.getSingleUseDepositAddress();
    const exit = await new SparkAgent(funder, "REGTEST").withdraw({ to: address, amount: AMOUNT, maxFeePct: MAX_FEE_PCT });
    const txid = exit.coopExitTxid;
    expect(txid).toMatch(/^[0-9a-f]{64}$/);

    const t0 = Date.now();
    let pending = [];
    while (Date.now() - t0 < WATCH_MS) {
      pending = await agent.listPendingDeposits();
      if (pending.length && (await confirmations(txid)) >= 3) break;
      await new Promise((r) => setTimeout(r, 15_000));
    }
    console.log("pending:", JSON.stringify(pending), "after", Math.round((Date.now() - t0) / 1000), "s");
    expect(pending).toEqual([{ address, txid, vout: expect.any(Number), type: "single-use" }]);

    const claim = await receiver.claimDeposit(txid).then(() => "claimed", (e) => e);
    console.log("claimDeposit(txid):", claim === "claimed" ? claim : String(claim?.message).slice(0, 300));
    expect(claim, "the operators accept single-use claims again — see the header").not.toBe("claimed");
    expect(String(claim?.message)).toMatch(/finalize_deposit_tree_creation UNAVAILABLE/);
  }, WATCH_MS + 240_000);
});
