// `sparkbtcbot rotate` on an in-memory network of fake wallets, with real
// encrypted seed files in a temp dir. The pins: a dry run moves and writes
// nothing; both seeds are on disk before a sat moves; the sweep can only go
// to the new wallet and skips the budget, limits and allowlist; an
// interrupted sweep resumes; a sealed ledger keeps its window under the new
// key; L402 holds block it; --check-old finds and sweeps late arrivals.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, readdir, readFile, access, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { saveEncryptedMnemonic, loadSeedPayload, deriveLedgerHmacKey } from "../../lib/encrypted-seed.js";
import { initSignedLedger, createSpendLedger } from "../../lib/spend-ledger.js";
import { writeLimits } from "../../lib/spending-limits.js";
import { createL402HoldStore } from "../../lib/l402-holds.js";
import { runRotate, runResume, runCheckOld } from "../../skills/sparkbtcbot/scripts/rotate.js";

const PASS = "correct horse battery staple";
const exists = (p) => access(p).then(() => true, () => false);

function fakeNet() {
  const byMnemonic = new Map();
  const byAddress = new Map();
  let n = 0;
  const make = (mnemonic, { sats = 0n, tokens = {} } = {}) => {
    const id = ++n;
    const address = `spark1fake${id}`;
    const w = {
      id, address, sats, tokens: new Map(Object.entries(tokens)), deposits: [], failTransfer: null,
      getSparkAddress: async () => address,
      getIdentityPublicKey: async () => `02${String(id).padStart(64, "0")}`,
      getBalance: async () => ({
        satsBalance: { available: w.sats, owned: w.sats, incoming: 0n },
        tokenBalances: new Map([...w.tokens].map(([t, amt]) => [t, { availableToSendBalance: amt, ownedBalance: amt, tokenMetadata: { tokenTicker: "TKN" } }])),
      }),
      queryStaticDepositAddresses: async () => (w.deposits.length ? ["bc1pdeposit"] : []),
      getUtxosForDepositAddress: async () => w.deposits,
      getStaticDepositAddress: async () => `bc1pstatic${id}`,
      transfer: vi.fn(async ({ receiverSparkAddress, amountSats }) => {
        if (w.failTransfer) throw w.failTransfer;
        const to = byAddress.get(receiverSparkAddress);
        w.sats -= BigInt(amountSats);
        to.sats += BigInt(amountSats);
        return { id: `t${id}` };
      }),
      transferTokens: vi.fn(async ({ tokenIdentifier, tokenAmount, receiverSparkAddress }) => {
        const to = byAddress.get(receiverSparkAddress);
        w.tokens.set(tokenIdentifier, w.tokens.get(tokenIdentifier) - tokenAmount);
        to.tokens.set(tokenIdentifier, (to.tokens.get(tokenIdentifier) ?? 0n) + tokenAmount);
        return "txhash";
      }),
      cleanup: async () => {},
    };
    byMnemonic.set(mnemonic, w);
    byAddress.set(address, w);
    return w;
  };
  const generateWallet = vi.fn(async () => {
    const mnemonic = generateMnemonic(wordlist);
    return { wallet: make(mnemonic), mnemonic };
  });
  return { make, byMnemonic, deps: { openWallet: async (m) => byMnemonic.get(m) ?? make(m), generateWallet } };
}

let dir;
let environment;
let out;
const report = () => out.join("");
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rotate-"));
  environment = {
    SPARK_PASSPHRASE: PASS, SPARK_NETWORK: "REGTEST", SPARK_SEED_PATH: join(dir, "seed.enc"),
    SPARK_LEAF_VAULT: "off", SPARK_LEAF_VAULT_PATH: join(dir, "vault.json"), SPARK_SPEND_LEDGER_PATH: join(dir, "ledger.json"),
    SPARK_PRIVACY: "off",
  };
  out = [];
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const opts = (net, extra = {}) => ({ deps: net.deps, out: (s) => out.push(s), log: () => {}, environment, ...extra });
async function walletOnDisk(net, { sats = 0n, tokens, policy } = {}) {
  const mnemonic = generateMnemonic(wordlist);
  await saveEncryptedMnemonic({ mnemonic, passphrase: PASS, path: environment.SPARK_SEED_PATH, policy });
  return { mnemonic, wallet: net.make(mnemonic, { sats, tokens }) };
}
const retiredDirs = async () => (await readdir(join(dir, "retired")).catch(() => [])).map((d) => join(dir, "retired", d));

describe("sparkbtcbot rotate", () => {
  it("a dry run reports and moves, generates and writes nothing", async () => {
    const net = fakeNet();
    const { wallet } = await walletOnDisk(net, { sats: 5_000n });
    expect(await runRotate(opts(net))).toBe(0);
    expect(report()).toMatch(/sats\s+5000 spendable/);
    expect(report()).toMatch(/Dry run: nothing moved, nothing written\. Show the user this plan; run `sparkbtcbot rotate --execute` only on their yes\./);
    expect(net.deps.generateWallet).not.toHaveBeenCalled();
    expect(wallet.transfer).not.toHaveBeenCalled();
    expect(await exists(`${environment.SPARK_SEED_PATH}.next`)).toBe(false);
    expect(await retiredDirs()).toEqual([]);
  });

  it("--execute: both seeds kept, everything swept to the new wallet only, seed.enc is the new one", async () => {
    const net = fakeNet();
    const { mnemonic: oldWords, wallet: old } = await walletOnDisk(net, { sats: 5_000n, tokens: { btkn1abc: 7n } });
    expect(await runRotate(opts(net, { execute: true }))).toBe(0);

    const newWords = (await loadSeedPayload({ passphrase: PASS, path: environment.SPARK_SEED_PATH })).mnemonic;
    expect(newWords).not.toBe(oldWords);
    const fresh = net.byMnemonic.get(newWords);
    expect(old.transfer.mock.calls.map((c) => c[0].receiverSparkAddress)).toEqual([fresh.address]);
    expect(old.transferTokens.mock.calls.map((c) => c[0].receiverSparkAddress)).toEqual([fresh.address]);
    expect({ old: old.sats, fresh: fresh.sats, token: fresh.tokens.get("btkn1abc") }).toEqual({ old: 0n, fresh: 5_000n, token: 7n });

    const [retired] = await retiredDirs();
    expect((await loadSeedPayload({ passphrase: PASS, path: join(retired, "seed.enc") })).mnemonic).toBe(oldWords);
    expect(JSON.parse(await readFile(join(retired, "manifest.json"), "utf8"))).toMatchObject({
      sparkAddress: old.address, staticDepositAddress: `bc1pstatic${old.id}`, sweptSats: "5000", successor: { sparkAddress: fresh.address },
    });
    expect(await exists(`${environment.SPARK_SEED_PATH}.next`)).toBe(false);
    expect(await exists(`${environment.SPARK_SEED_PATH}.rotation.json`)).toBe(false);
    expect(report()).toMatch(/The recovery words are NEW\. The old words no longer hold the money/);
    // A chat-only user's backup would go through the chat the old words leaked in.
    expect(report()).toMatch(/If they can only reach you through this chat, don't offer the new words as their\s+backup/);
    expect(report()).toMatch(/rotate --check-old/);
  });

  it("the sweep goes around the user's limits, the allowlist file and the budget (it only moves their own money)", async () => {
    const net = fakeNet();
    await walletOnDisk(net, { sats: 50_000n });
    await writeLimits({ allowedOps: ["lightning_pay"], maxPaymentSats: 1, dailyBudgetSats: 10 });
    environment.SPARK_DAILY_BUDGET_SATS = "10";
    expect(await runRotate(opts(net, { execute: true }))).toBe(0);
    const fresh = net.byMnemonic.get((await loadSeedPayload({ passphrase: PASS, path: environment.SPARK_SEED_PATH })).mnemonic);
    expect(fresh.sats).toBe(50_000n);
    expect(await exists(environment.SPARK_SPEND_LEDGER_PATH)).toBe(false); // nothing was counted
    // The limits are a file, not the wallet: the new wallet keeps them.
    expect(JSON.parse(await readFile(process.env.SPARK_LIMITS_PATH, "utf8"))).toMatchObject({ maxPaymentSats: 1 });
  });

  it("refuses while an L402 purchase is held (its payment can't be settled from a new wallet)", async () => {
    const net = fakeNet();
    await walletOnDisk(net, { sats: 5_000n });
    await createL402HoldStore().put("GET https://api.example/x", { method: "GET", host: "api.example", path: "/x", state: "held", invoice: "lnbc1", macaroon: "m" });
    await expect(runRotate(opts(net, { execute: true }))).rejects.toThrow(/1 unfinished L402 purchase\(s\).*forgetL402 on the user's say-so.*Nothing changed/);
    expect(await retiredDirs()).toEqual([]);
  });

  it("an interrupted sweep leaves both seeds on disk, and --resume finishes it", async () => {
    const net = fakeNet();
    const { mnemonic: oldWords, wallet: old } = await walletOnDisk(net, { sats: 5_000n });
    old.failTransfer = new Error("deadline exceeded");
    expect(await runRotate(opts(net, { execute: true }))).toBe(1);
    expect(report()).toMatch(/Both seeds are on disk and complete\. Run `sparkbtcbot rotate --resume`/);
    expect((await loadSeedPayload({ passphrase: PASS, path: environment.SPARK_SEED_PATH })).mnemonic).toBe(oldWords);
    expect(await exists(`${environment.SPARK_SEED_PATH}.next`)).toBe(true);
    await expect(runRotate(opts(net))).rejects.toThrow(/A rotation was interrupted.*rotate --resume/);

    old.failTransfer = null;
    out = [];
    expect(await runResume(opts(net))).toBe(0);
    const newWords = (await loadSeedPayload({ passphrase: PASS, path: environment.SPARK_SEED_PATH })).mnemonic;
    expect(newWords).not.toBe(oldWords);
    expect(net.byMnemonic.get(newWords).sats).toBe(5_000n);
    expect(old.sats).toBe(0n);
    expect(await exists(`${environment.SPARK_SEED_PATH}.next`)).toBe(false);
  });

  it("a sealed budget carries over: same policy in the new seed, the window's spends signed under the new key", async () => {
    const net = fakeNet();
    const policy = { dailyBudgetSats: 5_000 };
    const { mnemonic: oldWords } = await walletOnDisk(net, { sats: 9_000n, policy });
    const spend = { id: "aaaaaaaaaaaaaaaa", ts: Date.now() - 60_000, sats: 1_200, operation: "lightning_pay" };
    await initSignedLedger({ path: environment.SPARK_SPEND_LEDGER_PATH, hmacKey: deriveLedgerHmacKey(oldWords), entries: [spend] });
    expect(await runRotate(opts(net, { execute: true }))).toBe(0);
    const fresh = await loadSeedPayload({ passphrase: PASS, path: environment.SPARK_SEED_PATH });
    expect(fresh.policy).toEqual(policy);
    const status = await createSpendLedger({
      path: environment.SPARK_SPEND_LEDGER_PATH, budgetSats: 5_000, hmacKey: deriveLedgerHmacKey(fresh.mnemonic), bound: true,
    }).status();
    expect(status).toMatchObject({ spentSats: 1_200, remainingSats: 3_800 });
  });

  it("a sealed ledger that fails verification stops it before anything moves", async () => {
    const net = fakeNet();
    const { wallet: old } = await walletOnDisk(net, { sats: 9_000n, policy: { dailyBudgetSats: 5_000 } });
    await writeFile(environment.SPARK_SPEND_LEDGER_PATH, JSON.stringify({ version: 2, entries: [], hmac: "00" }));
    await expect(runRotate(opts(net, { execute: true }))).rejects.toMatchObject({ code: "SPEND_LEDGER_BAD_SIGNATURE" });
    expect(old.transfer).not.toHaveBeenCalled();
    expect(await exists(`${environment.SPARK_SEED_PATH}.next`)).toBe(false);
  });
});

describe("sparkbtcbot rotate --check-old", () => {
  it("reports what arrived at a retired wallet; --sweep claims its deposits and moves it all to this wallet", async () => {
    const net = fakeNet();
    const { wallet: old } = await walletOnDisk(net, { sats: 5_000n });
    expect(await runRotate(opts(net, { execute: true }))).toBe(0);
    const current = net.byMnemonic.get((await loadSeedPayload({ passphrase: PASS, path: environment.SPARK_SEED_PATH })).mnemonic);

    out = [];
    expect(await runCheckOld(opts(net))).toBe(0);
    expect(report()).toMatch(/Nothing has arrived at the retired wallets\./);

    old.sats = 700n; // a late payment to the old address
    old.deposits = [{ txid: "cd".repeat(32), vout: 1 }];
    out = [];
    expect(await runCheckOld(opts(net))).toBe(0);
    expect(report()).toMatch(/sats\s+700 spendable/);
    expect(report()).toMatch(/L1 deposit\s+cdcdcdcdcdcdcdcd…:1 waiting to be claimed/);
    expect(report()).toMatch(/--check-old --sweep` moves it to this wallet, on their say-so/);
    expect(current.sats).toBe(5_000n);

    const claimDeposit = vi.fn(async () => { old.deposits = []; old.sats += 300n; });
    out = [];
    expect(await runCheckOld(opts(net, { sweepNow: true, makeAgent: async () => ({ claimDeposit }) }))).toBe(0);
    expect(claimDeposit).toHaveBeenCalledWith({ txid: "cd".repeat(32), vout: 1 });
    expect({ old: old.sats, current: current.sats }).toEqual({ old: 0n, current: 6_000n });
    expect(old.transfer.mock.calls.at(-1)[0].receiverSparkAddress).toBe(current.address);
  });

  it("with nothing retired, says so", async () => {
    const net = fakeNet();
    await walletOnDisk(net);
    expect(await runCheckOld(opts(net))).toBe(0);
    expect(report()).toBe("No retired wallets to check.\n");
  });
});

describe("rotate's argument gate", () => {
  const CLI = join(dirname(fileURLToPath(import.meta.url)), "../../skills/sparkbtcbot/scripts/cli.js");
  const run = (...args) => promisify(execFile)("node", [CLI, "rotate", ...args], { env: { ...process.env, SPARK_SEED_PATH: join(dir, "none.enc"), SPARK_PASSPHRASE: "" } })
    .then((r) => ({ code: 0, ...r }), (e) => ({ code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }));

  it("refuses unknown or conflicting flags with usage (exit 2), and --help changes nothing", async () => {
    for (const args of [["--bogus"], ["--sweep"], ["--execute", "--resume"], ["--execute", "--execute"]]) {
      const r = await run(...args);
      expect(r.code, args.join(" ")).toBe(2);
      expect(r.stderr).toMatch(/Usage: sparkbtcbot rotate/);
    }
    const help = await run("--help");
    expect(help.code).toBe(0);
    expect(help.stdout).toMatch(/Run --execute ONLY because the user asked, in their own message, after seeing\nthe dry run\./);
  });

  it("without SPARK_PASSPHRASE it stops before opening anything (exit 1)", async () => {
    const r = await run();
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/SPARK_PASSPHRASE isn't set.*Nothing changed/);
  });
});
