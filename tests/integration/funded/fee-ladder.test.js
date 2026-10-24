// The SDK's refund fee ladder (default on since 0.13), end to end through the leaf-vault. The same
// 5,000 sats go to two fresh wallets: one opened the way this package opens
// every wallet (sparkWalletOptions: ladders off), one on the SDK defaults
// (ladders on). Each takes a real backup, and verifyVault and the snapshot must
// pass the first and name the anchorless leaves in the second; SparkAgent must
// warn about the second wallet only. The contrast is what makes
// the pass meaningful: it shows the check sees the difference on live
// operators, not only on the saved fixtures (tests/unit/leaf-vault-anchorless).
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic, waitForSettled, returnSats, waitForClaimed } from "../../helpers/wallet.js";
import { snapshotLeafVault, verifyVault } from "../../../skills/sparkbtcbot/scripts/leaf-vault.js";
import { SparkAgent } from "../../../skills/sparkbtcbot/scripts/spark-agent.js";

const fundedMnemonic = getFundedMnemonic();
const describeFunded = fundedMnemonic ? describe : describe.skip;
const AMOUNT = 5_000;

describeFunded("SDK refund fee ladder vs the leaf-vault (REGTEST)", () => {
  let payer;
  let payerAddress;
  let ladderOn; // SDK defaults: not created through the helper, cleaned up here
  let dir;
  const received = [];

  const receiveAndVerify = async (wallet, name) => {
    await payer.transfer({ receiverSparkAddress: await wallet.getSparkAddress(), amountSats: AMOUNT });
    received.push(wallet);
    expect(await waitForSettled(wallet, BigInt(AMOUNT), { timeoutMs: 60_000 })).toEqual({ available: BigInt(AMOUNT), incoming: 0n });
    const path = join(dir, `${name}.json`);
    const snap = await snapshotLeafVault(wallet, { path });
    expect(snap.skipped).toBeUndefined();
    const leaves = JSON.parse(await readFile(path, "utf8")).leaves.map((l) => ({ id: l.id, sats: Number(l.valueSats) }));
    return { leaves, snap, verdict: await verifyVault(path) };
  };

  // Reads the wallet's real SDK config, which a mock can't vouch for.
  const agentWarnsAboutLadders = (wallet) => {
    const orig = process.env.SPARK_LEAF_VAULT;
    process.env.SPARK_LEAF_VAULT = "off";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      new SparkAgent(wallet, "REGTEST");
      return warn.mock.calls.some(([m]) => /fee ladders ON/.test(m));
    } finally {
      warn.mockRestore();
      if (orig === undefined) delete process.env.SPARK_LEAF_VAULT;
      else process.env.SPARK_LEAF_VAULT = orig;
    }
  };

  beforeAll(async () => {
    ({ wallet: payer } = await createTestWallet({ mnemonic: fundedMnemonic }));
    payerAddress = await payer.getSparkAddress();
    dir = await mkdtemp(join(tmpdir(), "fee-ladder-"));
  }, 90_000);

  afterAll(async () => {
    const readAvailable = async () => (await payer.getBalance()).satsBalance.available;
    const before = await readAvailable();
    let returned = 0n;
    for (const w of received) returned += await returnSats(w, payerAddress);
    if (returned > 0n) await waitForClaimed(readAvailable, before + returned);
    try { await ladderOn?.cleanup(); } catch {}
    await cleanupAllWallets();
    if (dir) await rm(dir, { recursive: true, force: true });
  }, 120_000);

  it("ladders off (this package): every refund keeps its anchor, and verify passes", async () => {
    const { wallet } = await createTestWallet();
    const { leaves, snap, verdict } = await receiveAndVerify(wallet, "off");
    expect(leaves.some((l) => l.sats >= 1024), `no leaf of 1,024+ sats to test: ${JSON.stringify(leaves)}`).toBe(true);
    expect(verdict).toMatchObject({ ok: true, failed: [], anchorless: [] });
    expect(snap.anchorless).toEqual([]);
    expect(agentWarnsAboutLadders(wallet)).toBe(false);
  }, 120_000);

  it("SDK defaults (ladder on): the 1,024+ sat leaves come back anchorless, and verify fails naming them", async () => {
    ({ wallet: ladderOn } = await SparkWallet.initialize({ options: { network: "REGTEST", optimizationOptions: { auto: false } } }));
    const { leaves, snap, verdict } = await receiveAndVerify(ladderOn, "on");
    const big = leaves.filter((l) => l.sats >= 1024).map((l) => l.id).sort();
    expect(big.length).toBeGreaterThan(0);
    expect(verdict.ok).toBe(false);
    expect(verdict.failed).toEqual([]); // still rebuilds to a root; the anchor is what's missing
    expect([...verdict.anchorless].sort()).toEqual(big); // and the leaves under 1,024 sats keep theirs
    expect([...snap.anchorless].sort()).toEqual(big); // the continuous backup sees it too
    expect(agentWarnsAboutLadders(ladderOn)).toBe(true);
  }, 120_000);
});
