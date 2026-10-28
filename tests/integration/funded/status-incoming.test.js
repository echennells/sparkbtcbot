// A payment made while the wallet was closed, on hosted REGTEST with real
// sats. When the wallet reopens, the SDK shows that payment only as
// `incoming` until it claims it, about a second after boot. getBalance() used
// to leave `incoming` out, so the agent's first read could say 0 sats, i.e.
// "nothing arrived" (REGTEST, 2026-10-28: 3 of 8 reads by default, 8 of 8 with
// privacy off and optimizeLeaves false, the setup used here). This test pins
// that the first getBalance() and status() after SparkAgent.create show the
// payment as sats, incomingSats or, mid-claim, lockedSats, and never all zero.
// It moves 300 sats from the funded wallet to a throwaway one and returns them.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { SparkAgent } from "../../../skills/sparkbtcbot/scripts/spark-agent.js";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic, returnSats, waitForClaimed } from "../../helpers/wallet.js";

const fundedMnemonic = getFundedMnemonic();
const describeFunded = fundedMnemonic ? describe : describe.skip;
const AMOUNT = 300;
const ENV = ["SPARK_SEED_PATH", "SPARK_LEAF_VAULT", "SPARK_PRIVACY", "SPARK_DAILY_BUDGET_SATS", "SPARK_SPEND_LEDGER_PATH"];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const total = (b) => BigInt(b.sats) + BigInt(b.incomingSats) + BigInt(b.lockedSats);

describeFunded("a payment to a closed wallet, seen on reopen (REGTEST, real sats)", () => {
  const saved = {};
  let dir, sender, senderAddress, receiverMnemonic, receiverAddress, agent;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "status-incoming-"));
    for (const k of ENV) saved[k] = process.env[k];
    process.env.SPARK_SEED_PATH = join(dir, "no-seed.enc"); // the agent checks for a sealed seed: not the real one
    process.env.SPARK_LEAF_VAULT = "off"; // no backup files from this test
    process.env.SPARK_PRIVACY = "off";    // reopen and read as fast as possible
    delete process.env.SPARK_DAILY_BUDGET_SATS;
    delete process.env.SPARK_SPEND_LEDGER_PATH;
    ({ wallet: sender } = await createTestWallet({ mnemonic: fundedMnemonic }));
    senderAddress = await sender.getSparkAddress();
    // Open the receiver once for its address, then close it: the payment has
    // to arrive while it is closed.
    receiverMnemonic = generateMnemonic(wordlist);
    const { wallet: probe } = await createTestWallet({ mnemonic: receiverMnemonic });
    receiverAddress = await probe.getSparkAddress();
    await probe.cleanup();
  }, 90_000);

  afterAll(async () => {
    await agent?.cleanup().catch(() => {});
    // Return the sats with the SDK directly (SparkAgent.transfer would read the
    // user's recipient allowlist). A payment caught by the startup-claim race
    // stays incoming until the next boot, so reopen until it is claimed.
    if (sender && receiverMnemonic) {
      const readAvailable = async () => (await sender.getBalance()).satsBalance.available;
      const before = await readAvailable();
      let returned = 0n;
      for (let i = 0; i < 3 && returned === 0n; i++) {
        const { wallet } = await createTestWallet({ mnemonic: receiverMnemonic });
        returned = await returnSats(wallet, senderAddress);
        await wallet.cleanup().catch(() => {});
      }
      if (returned > 0n) await waitForClaimed(readAvailable, before + returned);
      else console.warn(`status-incoming: the ${AMOUNT} sats were not returned; they are on the throwaway wallet`);
    }
    await cleanupAllWallets();
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    await rm(dir, { recursive: true, force: true });
  }, 240_000);

  it("the first getBalance() and status() after SparkAgent.create show it, never all zero; then it lands as sats", async () => {
    await sender.transfer({ receiverSparkAddress: receiverAddress, amountSats: AMOUNT });
    // A transfer made less than about a second before boot can miss the SDK's
    // startup claim and stay incoming; this test is about seeing the payment,
    // so it reopens well after that window.
    await sleep(5_000);
    ({ agent } = await SparkAgent.create(receiverMnemonic, "REGTEST", { optimizeLeaves: false }));
    const first = await agent.getBalance();
    const s = await agent.status();
    const figures = (b) => `sats ${b.sats}, incomingSats ${b.incomingSats}, lockedSats ${b.lockedSats}`;
    console.log(`first read after reopen: ${figures(first)}; status(): ${figures(s.balance)}`);
    expect(total(first), "getBalance() read the payment as nothing").toBeGreaterThan(0n);
    expect(total(s.balance), "status() read the payment as nothing").toBeGreaterThan(0n);
    expect(s.usable).toBe(true);
    expect(s.problems).not.toContain("INCOMING_UNCLAIMED"); // seconds old, not a minute

    let b;
    for (let i = 0; i < 30; i++) {
      b = await agent.getBalance();
      if (b.incomingSats === "0" && b.sats === String(AMOUNT)) break;
      await sleep(1_000);
    }
    expect(b).toMatchObject({ sats: String(AMOUNT), incomingSats: "0", lockedSats: "0" });
  }, 120_000);
});
