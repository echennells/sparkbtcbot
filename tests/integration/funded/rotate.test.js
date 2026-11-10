// `sparkbtcbot rotate` end to end on REGTEST, with real wallets and real
// encrypted seed files in a temp dir: a funded wallet is rotated, the new seed
// holds the balance, the old seed is kept and empty; a late payment to the old
// address is found and swept by --check-old --sweep. The sats go back to the
// funded wallet at the end.
import { appendFileSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, readdir, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveEncryptedMnemonic, loadSeedPayload } from "../../../lib/encrypted-seed.js";
import { runRotate, runCheckOld } from "../../../skills/sparkbtcbot/scripts/rotate.js";
import { createTestWallet, cleanupAllWallets, getFundedMnemonic, waitForSettled, returnSats, waitForClaimed } from "../../helpers/wallet.js";

const fundedMnemonic = getFundedMnemonic();
const describeFunded = fundedMnemonic ? describe : describe.skip;
const PASS = "rotate regtest passphrase";
const AMOUNT = 2_000n;
const LATE = 500n;
const exists = (p) => access(p).then(() => true, () => false);
const available = async (w) => BigInt((await w.getBalance()).satsBalance.available);

describeFunded("sparkbtcbot rotate (REGTEST, real wallets)", () => {
  let dir;
  let environment;
  let payer;
  let payerAddress;
  let oldWords;
  let oldAddress;
  const out = [];

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "rotate-regtest-"));
    environment = {
      SPARK_PASSPHRASE: PASS, SPARK_NETWORK: "REGTEST", SPARK_SEED_PATH: join(dir, "seed.enc"),
      SPARK_LEAF_VAULT_PATH: join(dir, "leaf-vault", "current.json"), SPARK_SPEND_LEDGER_PATH: join(dir, "ledger.json"),
    };
    ({ wallet: payer } = await createTestWallet({ mnemonic: fundedMnemonic }));
    payerAddress = await payer.getSparkAddress();
    const { wallet, mnemonic } = await createTestWallet();
    oldWords = mnemonic;
    oldAddress = await wallet.getSparkAddress();
    await saveEncryptedMnemonic({ mnemonic, passphrase: PASS, path: environment.SPARK_SEED_PATH });
    await payer.transfer({ receiverSparkAddress: oldAddress, amountSats: Number(AMOUNT) });
    expect(await waitForSettled(wallet, AMOUNT, { timeoutMs: 60_000 })).toEqual({ available: AMOUNT, incoming: 0n });
    await wallet.cleanup(); // rotate opens its own
  }, 180_000);

  afterAll(async () => {
    // Everything back to the funded wallet, from whichever seed holds it.
    try {
      const before = await available(payer);
      let returned = 0n;
      for (const path of [environment.SPARK_SEED_PATH, ...(await readdir(join(dir, "retired")).catch(() => [])).map((d) => join(dir, "retired", d, "seed.enc"))]) {
        if (!(await exists(path))) continue;
        const { mnemonic } = await loadSeedPayload({ passphrase: PASS, path });
        const { wallet } = await createTestWallet({ mnemonic });
        returned += await returnSats(wallet, payerAddress);
      }
      if (returned > 0n) await waitForClaimed(() => available(payer), before + returned);
    } finally {
      await cleanupAllWallets();
      await rm(dir, { recursive: true, force: true });
    }
  }, 240_000);

  it("--execute moves the balance to a new seed and keeps the old one, empty", async () => {
    const code = await runRotate({ execute: true, environment, out: (s) => out.push(s), log: (s) => out.push(`${s}\n`) });
    expect(code, out.join("")).toBe(0);
    const fresh = await loadSeedPayload({ passphrase: PASS, path: environment.SPARK_SEED_PATH });
    expect(fresh.mnemonic).not.toBe(oldWords);
    const { wallet: neu } = await createTestWallet({ mnemonic: fresh.mnemonic });
    expect(await waitForSettled(neu, AMOUNT, { timeoutMs: 60_000 })).toEqual({ available: AMOUNT, incoming: 0n });

    const [retired] = (await readdir(join(dir, "retired"))).map((d) => join(dir, "retired", d));
    expect((await loadSeedPayload({ passphrase: PASS, path: join(retired, "seed.enc") })).mnemonic).toBe(oldWords);
    expect(JSON.parse(await readFile(join(retired, "manifest.json"), "utf8"))).toMatchObject({ sparkAddress: oldAddress, sweptSats: String(AMOUNT) });
    const { wallet: old } = await createTestWallet({ mnemonic: oldWords });
    expect(await available(old)).toBe(0n);
    expect(await exists(environment.SPARK_LEAF_VAULT_PATH)).toBe(true); // the new wallet's backup
    expect(out.join("")).toMatch(/The recovery words are NEW/);
  }, 240_000);

  it("--check-old finds a late payment to the old address, and --sweep moves it to the new wallet", async () => {
    await payer.transfer({ receiverSparkAddress: oldAddress, amountSats: Number(LATE) });
    out.length = 0;
    const check = async (sweepNow) => runCheckOld({ sweepNow, environment, out: (s) => out.push(s), log: (s) => out.push(`${s}\n`) });
    // Opening the retired wallet claims the transfer; give it a few tries.
    for (let i = 0; i < 10 && !/sats\s+500 spendable/.test(out.join("")); i++) {
      out.length = 0;
      expect(await check(false)).toBe(0);
      if (!/sats\s+500 spendable/.test(out.join(""))) await new Promise((r) => setTimeout(r, 3_000));
    }
    expect(out.join("")).toMatch(/sats\s+500 spendable/);
    // A leaf the SDK is renewing as the retired wallet opens can be locked for
    // a moment (2026-11-10: "244 spendable, 256 locked"). The sweep waits for
    // it; if it outlasts the wait, the report must say what stayed, and the
    // next run moves it. Never a partial move reported as the whole.
    let moved = 0n;
    for (let i = 0; i < 4 && moved < LATE; i++) {
      out.length = 0;
      expect(await check(true), out.join("")).toBe(0);
      const report = out.join("");
      const m = report.match(/Moved (\d+) sats to this wallet/);
      if (m) moved += BigInt(m[1]);
      // On record whether this run met the lock at all: vitest shows a passing
      // test's console output only on request, so SPARK_TEST_SWEEP_LOG names a file.
      const line = `rotate --check-old --sweep, run ${i + 1}: ${report.match(/sats\s+.*/)?.[0] ?? "?"} -> moved ${m?.[1] ?? 0}${/Still in the old wallet/.test(report) ? ", some left and reported" : ""}`;
      console.log(line);
      if (process.env.SPARK_TEST_SWEEP_LOG) appendFileSync(process.env.SPARK_TEST_SWEEP_LOG, `${new Date().toISOString()} ${line}\n`);
      if (moved < LATE) expect(report, report.slice(-700)).toMatch(/Still in the old wallet: \d+ sats \(/);
      else expect(report.slice(-700)).not.toMatch(/Still in the old wallet/);
    }
    expect(moved).toBe(LATE);
    // And the retired wallet, opened fresh, really is empty.
    const { wallet: oldAgain } = await createTestWallet({ mnemonic: oldWords });
    expect(await waitForSettled(oldAgain, 0n, { timeoutMs: 30_000 })).toEqual({ available: 0n, incoming: 0n });
    expect((await oldAgain.getBalance()).satsBalance.owned).toBe(0n);
    const fresh = await loadSeedPayload({ passphrase: PASS, path: environment.SPARK_SEED_PATH });
    const { wallet: neu } = await createTestWallet({ mnemonic: fresh.mnemonic });
    expect(await waitForSettled(neu, AMOUNT + LATE, { timeoutMs: 60_000 })).toEqual({ available: AMOUNT + LATE, incoming: 0n });
  }, 300_000);
});
