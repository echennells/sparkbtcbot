// Withdrawal to a BIP-352 silent payment address (spark-sdk >= 0.14), through
// SparkAgent, end to end. A fresh wallet gets FUNDING sats, withdraws AMOUNT to
// an `sprt1q…` address made from our own scan/spend keys, and the broadcast
// coop exit is then scanned with an independent receiver (helpers/
// silent-payment.js, checked against the BIP-352 vectors in the unit suite):
// the output must be one only those keys can spend, carrying what the quote
// said. The SDK verifies the SSP's proof before signing; this checks the
// result from the receiving end.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { getElectrsUrl } from "@buildonspark/spark-sdk";
import { schnorr } from "@noble/curves/secp256k1";
import { SparkAgent } from "../../../skills/sparkbtcbot/scripts/spark-agent.js";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic, waitForSettled, returnSats, waitForClaimed } from "../../helpers/wallet.js";
import { createSilentPaymentReceiver, silentPaymentAddress, scanTransaction } from "../../helpers/silent-payment.js";

const fundedMnemonic = getFundedMnemonic();
const describeFunded = fundedMnemonic ? describe : describe.skip;
const FUNDING = 6_000;
const AMOUNT = 5_000;
// The REGTEST SSP charges a flat fee of ~2,200 sats per exit, far above the
// default 10% ceiling on a 5,000-sat exit. Raise the ceiling for this test
// only; the default refusing it is asserted below.
const MAX_FEE_PCT = 60;

async function fetchTx(txid, { timeoutMs = 120_000, everyMs = 3_000 } = {}) {
  const url = `${getElectrsUrl("REGTEST")}/tx/${txid}`;
  const end = Date.now() + timeoutMs;
  for (;;) {
    const res = await fetch(url);
    if (res.ok) return await res.json();
    if (Date.now() > end) throw new Error(`coop exit ${txid} not on the REGTEST explorer after ${timeoutMs} ms (HTTP ${res.status})`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

describeFunded("withdraw to a silent payment address (REGTEST)", () => {
  const origVault = process.env.SPARK_LEAF_VAULT;
  let payer;
  let payerAddress;
  let wallet;
  let agent;

  beforeAll(async () => {
    process.env.SPARK_LEAF_VAULT = "off"; // no backup files from this test
    ({ wallet: payer } = await createTestWallet({ mnemonic: fundedMnemonic }));
    payerAddress = await payer.getSparkAddress();
    ({ wallet } = await createTestWallet());
    await payer.transfer({ receiverSparkAddress: await wallet.getSparkAddress(), amountSats: FUNDING });
    expect(await waitForSettled(wallet, BigInt(FUNDING), { timeoutMs: 60_000 })).toEqual({ available: BigInt(FUNDING), incoming: 0n });
    agent = new SparkAgent(wallet, "REGTEST");
  }, 120_000);

  afterAll(async () => {
    if (origVault === undefined) delete process.env.SPARK_LEAF_VAULT;
    else process.env.SPARK_LEAF_VAULT = origVault;
    const readAvailable = async () => (await payer.getBalance()).satsBalance.available;
    const before = await readAvailable();
    const returned = wallet ? await returnSats(wallet, payerAddress) : 0n;
    if (returned > 0n) await waitForClaimed(readAvailable, before + returned);
    await agent?.cleanup?.().catch(() => {});
    await cleanupAllWallets();
  }, 120_000);

  it("refuses a mainnet silent payment address before any leaf moves", async () => {
    const mainnet = createSilentPaymentReceiver("MAINNET").address;
    expect(mainnet.startsWith("sp1q")).toBe(true);
    await expect(agent.withdraw({ to: mainnet, amount: AMOUNT, maxFeePct: MAX_FEE_PCT })).rejects.toThrow(/different network/i);
    expect(await waitForSettled(wallet, BigInt(FUNDING), { timeoutMs: 10_000 })).toEqual({ available: BigInt(FUNDING), incoming: 0n });
  }, 60_000);

  it("refuses one as a Spark transfer destination before anything moves", async () => {
    // Same sp1/sprt1 prefix as a legacy Spark address; it is an L1 destination.
    const { address } = createSilentPaymentReceiver("REGTEST");
    await expect(agent.transfer({ to: address, amount: 1_000 })).rejects.toThrow();
    expect(await waitForSettled(wallet, BigInt(FUNDING), { timeoutMs: 10_000 })).toEqual({ available: BigInt(FUNDING), incoming: 0n });
  }, 60_000);

  it("quotes it in a dry run, and the default fee ceiling still applies", async () => {
    const { address } = createSilentPaymentReceiver("REGTEST");
    const dry = await agent.withdraw({ to: address, amount: AMOUNT, dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, operation: "l1_withdraw", to: address, amount: String(AMOUNT), maxFeeSats: String(AMOUNT / 10) });
    const fee = Number(dry.estimatedFee);
    expect(fee).toBeGreaterThan(0);
    expect(dry.withinCap).toBe(fee <= AMOUNT / 10);
    if (!dry.withinCap) {
      await expect(agent.withdraw({ to: address, amount: AMOUNT })).rejects.toThrow(/Withdrawal blocked/);
    }
    expect(await waitForSettled(wallet, BigInt(FUNDING), { timeoutMs: 10_000 })).toEqual({ available: BigInt(FUNDING), incoming: 0n });
  }, 60_000);

  it("pays an output only the receiver's keys can spend, for the amount less the quoted fee", async () => {
    const receiver = createSilentPaymentReceiver("REGTEST");
    expect(receiver.address.startsWith("sprt1q")).toBe(true);
    const dry = await agent.withdraw({ to: receiver.address, amount: AMOUNT, maxFeePct: MAX_FEE_PCT, dryRun: true });
    expect(dry.withinCap).toBe(true);

    const exit = await agent.withdraw({ to: receiver.address, amount: AMOUNT, maxFeePct: MAX_FEE_PCT });
    expect(exit?.coopExitTxid).toMatch(/^[0-9a-f]{64}$/);

    // The wallet pays AMOUNT in total: the SDK deducts the fee from it.
    expect(await waitForSettled(wallet, BigInt(FUNDING - AMOUNT), { timeoutMs: 60_000 })).toEqual({
      available: BigInt(FUNDING - AMOUNT),
      incoming: 0n,
    });

    const tx = await fetchTx(exit.coopExitTxid);
    const found = scanTransaction(tx, receiver);
    expect(found, "no output in the coop exit pays the receiver's keys").not.toBeNull();
    expect(found.vout).toBe(0);
    // SparkAgent binds the exit to the fee it vetted in the quote.
    expect(found.value).toBe(AMOUNT - Number(dry.estimatedFee));
    // Spendable: the tweaked spend key's x-only public key IS the output key.
    const privateKey = found.privateKey.toString(16).padStart(64, "0");
    expect(Buffer.from(schnorr.getPublicKey(privateKey)).toString("hex")).toBe(found.outputKey);

    // Negative control: the same transaction holds nothing for another
    // receiver, or for our spend key under someone else's scan key.
    expect(scanTransaction(tx, createSilentPaymentReceiver("REGTEST"))).toBeNull();
    const otherScan = createSilentPaymentReceiver("REGTEST").scanKey;
    expect(scanTransaction(tx, { scanKey: otherScan, spendKey: receiver.spendKey })).toBeNull();
    expect(silentPaymentAddress("REGTEST", receiver.scanKey, receiver.spendKey)).toBe(receiver.address);
  }, 240_000);
});
