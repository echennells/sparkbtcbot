// `sparkbtcbot rotate` — the three stages with mock wallets, in the order
// that makes an interrupted run safe: both seeds on disk BEFORE any sweep,
// the sweep verified on the receiving wallet, then the atomic swap. Plus the
// same arg/TTY gates as every ceremony.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { planRotation, sweepToWallet, stageSeeds, commitRotation } from "../../skills/sparkbtcbot/scripts/rotate.js";
import { saveEncryptedMnemonic, loadSeedPayload, deriveLedgerHmacKey } from "../../lib/encrypted-seed.js";
import { createSpendLedger, initSignedLedger } from "../../lib/spend-ledger.js";

const run = promisify(execFile);
const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "../../skills/sparkbtcbot/scripts");
const exec = (args, env = {}) =>
  run("node", [join(SCRIPTS, "rotate.js"), ...args], { env: { ...process.env, ...env } }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }),
  );

const OLD_M = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const NEW_M = "zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo zoo wrong";
const PASS = "correct horse battery staple";
const POLICY = { dailyBudgetSats: 5000, allowedOps: ["spark_transfer"] };

const mkWallet = ({ address, pubkey, sats = 0n, tokens = [], pending = [] }) => {
  const calls = { transfers: [], tokenTransfers: [], privacy: 0 };
  const tokenBalances = new Map(tokens.map((t) => [t.id, { ownedBalance: t.amount, tokenMetadata: { tokenTicker: t.ticker } }]));
  const w = {
    calls,
    balance: { sats, tokenBalances },
    getSparkAddress: async () => address,
    getIdentityPublicKey: async () => pubkey,
    getStaticDepositAddress: async () => `bc1q-${address}`,
    getBalance: async () => ({ satsBalance: { available: w.balance.sats }, tokenBalances: w.balance.tokenBalances }),
    queryStaticDepositAddresses: async () => [`bc1q-${address}`],
    getUtxosForDepositAddress: async () => pending,
    transfer: async (args) => { calls.transfers.push(args); return { id: "t1" }; },
    transferTokens: async (args) => { calls.tokenTransfers.push(args); return "k1"; },
    setPrivacyEnabled: async () => { calls.privacy++; },
  };
  return w;
};

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "rotate-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("planRotation", () => {
  it("reports balances, tokens, the static deposit address, and unclaimed deposits", async () => {
    const w = mkWallet({ address: "sp1old", pubkey: "02aa", sats: 4200n, tokens: [{ id: "btkn1x", amount: 7n, ticker: "TST" }], pending: [{ txid: "ab".repeat(32), vout: 1 }] });
    const plan = await planRotation(w);
    expect(plan).toMatchObject({ address: "sp1old", identityPublicKey: "02aa", depositAddress: "bc1q-sp1old", sats: 4200n });
    expect(plan.tokens).toEqual([{ tokenIdentifier: "btkn1x", amount: 7n, ticker: "TST" }]);
    expect(plan.pendingDeposits).toEqual([{ address: "bc1q-sp1old", txid: "ab".repeat(32), vout: 1 }]);
  });
});

describe("sweepToWallet", () => {
  it("sends sats and every token to the new address and verifies the new wallet claimed them", async () => {
    const oldW = mkWallet({ address: "sp1old", pubkey: "02aa", sats: 4200n, tokens: [{ id: "btkn1x", amount: 7n, ticker: "TST" }] });
    const newW = mkWallet({ address: "sp1new", pubkey: "02bb" });
    // the mock "claims" on the second poll
    let polls = 0;
    const origBalance = newW.getBalance;
    newW.getBalance = async () => { if (++polls >= 2) { newW.balance.sats = 4200n; newW.balance.tokenBalances.set("btkn1x", { ownedBalance: 7n }); } return origBalance(); };
    const plan = await planRotation(oldW);
    const r = await sweepToWallet(oldW, newW, plan, { pollMs: 5, timeoutMs: 2_000, privacy: false });
    expect(oldW.calls.transfers).toEqual([{ receiverSparkAddress: "sp1new", amountSats: 4200 }]);
    expect(oldW.calls.tokenTransfers).toEqual([{ tokenIdentifier: "btkn1x", tokenAmount: 7n, receiverSparkAddress: "sp1new" }]);
    expect(r).toMatchObject({ to: "sp1new", verified: true, newBalanceSats: 4200n, sats: { id: "t1" } });
    expect(r.tokens[0].id).toBe("k1");
  });

  it("an unclaimed sweep is reported as ROTATE_UNVERIFIED, never assumed", async () => {
    const oldW = mkWallet({ address: "sp1old", pubkey: "02aa", sats: 100n });
    const newW = mkWallet({ address: "sp1new", pubkey: "02bb" }); // never claims
    const plan = await planRotation(oldW);
    await expect(sweepToWallet(oldW, newW, plan, { pollMs: 5, timeoutMs: 40, privacy: false })).rejects.toMatchObject({ code: "ROTATE_UNVERIFIED" });
  });

  it("nothing to sweep → no transfers, verified immediately", async () => {
    const oldW = mkWallet({ address: "sp1old", pubkey: "02aa" });
    const newW = mkWallet({ address: "sp1new", pubkey: "02bb" });
    const r = await sweepToWallet(oldW, newW, await planRotation(oldW), { pollMs: 5, timeoutMs: 100, privacy: false });
    expect(oldW.calls.transfers).toEqual([]);
    expect(r.verified).toBe(true);
  });
});

describe("stageSeeds + commitRotation (the file story)", () => {
  it("stage 1 writes both seeds under the same passphrase with the policy carried; stage 2 swaps atomically, files the vault, resets the ledger", async () => {
    const seedPath = join(dir, "seed.enc");
    const ledgerPath = join(dir, "ledger.json");
    const vaultPath = join(dir, "leaf-vault", "current.json");
    await saveEncryptedMnemonic({ mnemonic: OLD_M, passphrase: PASS, path: seedPath, policy: POLICY });
    await initSignedLedger({ path: ledgerPath, hmacKey: deriveLedgerHmacKey(OLD_M) });
    await createSpendLedger({ path: ledgerPath, budgetSats: 5000, hmacKey: deriveLedgerHmacKey(OLD_M), bound: true }).record(900, "spark_transfer");
    await (await import("node:fs/promises")).mkdir(dirname(vaultPath), { recursive: true });
    await writeFile(vaultPath, '{"schema":"old-vault"}');
    const oldPayload = await loadSeedPayload({ passphrase: PASS, path: seedPath });
    const now = new Date("2026-09-19T12:00:00Z");

    // --- stage 1
    const { nextPath, retiredDir } = await stageSeeds({ seedPath, passphrase: PASS, oldPayload, newMnemonic: NEW_M, identityPublicKey: "02aabbccddeeff", now });
    expect(nextPath).toBe(seedPath + ".next");
    expect(retiredDir).toBe(join(dir, "retired", "2026-09-19-02aabbcc"));
    expect(await loadSeedPayload({ passphrase: PASS, path: join(retiredDir, "seed.enc") })).toEqual({ mnemonic: OLD_M, policy: POLICY, version: 2 });
    expect(await loadSeedPayload({ passphrase: PASS, path: nextPath })).toEqual({ mnemonic: NEW_M, policy: POLICY, version: 2 });
    expect((await loadSeedPayload({ passphrase: PASS, path: seedPath })).mnemonic).toBe(OLD_M); // live seed untouched until commit
    // a second stage while .next exists is refused
    await expect(stageSeeds({ seedPath, passphrase: PASS, oldPayload, newMnemonic: NEW_M, identityPublicKey: "02aabbccddeeff", now }))
      .rejects.toMatchObject({ code: "ROTATE_IN_PROGRESS" });

    // --- stage 2
    const plan = { address: "sp1old", identityPublicKey: "02aabbccddeeff", depositAddress: "bc1qold", sats: 4200n, tokens: [{ tokenIdentifier: "btkn1x", amount: 7n, ticker: "TST" }] };
    const sweep = { to: "sp1new", sats: { id: "t1" }, tokens: [{ id: "k1" }] };
    const manifest = await commitRotation({ seedPath, nextPath, retiredDir, ledgerPath, vaultPath, oldPayload, newMnemonic: NEW_M, plan, sweep, newIdentityPublicKey: "02bb", now });
    expect((await loadSeedPayload({ passphrase: PASS, path: seedPath })).mnemonic).toBe(NEW_M);
    await expect(access(nextPath)).rejects.toThrow();
    expect(await readFile(join(retiredDir, "leaf-vault.json"), "utf8")).toBe('{"schema":"old-vault"}');
    await expect(access(vaultPath)).rejects.toThrow(); // the new snapshot is taken by main() afterwards
    expect(manifest).toMatchObject({ schema: "sparkbtcbot.retired-seed.v1", sparkAddress: "sp1old", staticDepositAddress: "bc1qold", sweptSats: "4200", successor: { sparkAddress: "sp1new" } });
    expect(JSON.parse(await readFile(join(retiredDir, "manifest.json"), "utf8"))).toEqual(manifest);
    // the ledger was re-signed under the NEW mnemonic and is empty (new window)
    const ledger = createSpendLedger({ path: ledgerPath, budgetSats: 5000, hmacKey: deriveLedgerHmacKey(NEW_M), bound: true });
    expect((await ledger.status()).spentSats).toBe(0);
    expect((await readdir(retiredDir)).sort()).toEqual(["leaf-vault.json", "manifest.json", "seed.enc"]);
  });

  it("a v1 seed (no policy) rotates to a v1 seed and leaves the ledger alone", async () => {
    const seedPath = join(dir, "seed.enc");
    await saveEncryptedMnemonic({ mnemonic: OLD_M, passphrase: PASS, path: seedPath });
    const oldPayload = await loadSeedPayload({ passphrase: PASS, path: seedPath });
    const { nextPath, retiredDir } = await stageSeeds({ seedPath, passphrase: PASS, oldPayload, newMnemonic: NEW_M, identityPublicKey: "02cc" });
    await commitRotation({ seedPath, nextPath, retiredDir, ledgerPath: join(dir, "ledger.json"), vaultPath: join(dir, "none.json"), oldPayload, newMnemonic: NEW_M,
      plan: { address: "a", identityPublicKey: "02cc", depositAddress: null, sats: 0n, tokens: [] }, sweep: { to: "b", sats: null, tokens: [] }, newIdentityPublicKey: "02dd" });
    expect(await loadSeedPayload({ passphrase: PASS, path: seedPath })).toEqual({ mnemonic: NEW_M, policy: null, version: 1 });
    await expect(access(join(dir, "ledger.json"))).rejects.toThrow();
  });
});

describe("rotate CLI gates", () => {
  it("--help prints usage and exits 0 even piped", async () => {
    const r = await exec(["--help"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/Usage: sparkbtcbot rotate \[--execute\]/);
    expect(r.stdout).toMatch(/DRY RUN/);
  });
  it("an unknown argument exits 2 with usage", async () => {
    const r = await exec(["--force"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown argument.*--force/i);
  });
  it("without a TTY it refuses (exit 3) before any prompt, with or without --execute", async () => {
    for (const args of [[], ["--execute"]]) {
      const r = await exec(args, { SPARK_PASSPHRASE: PASS, SPARK_SEED_PATH: join(dir, "nope.enc") });
      expect(r.code).toBe(3);
      expect(r.stderr).toMatch(/refusing to run without a real interactive terminal/);
    }
  });
});
