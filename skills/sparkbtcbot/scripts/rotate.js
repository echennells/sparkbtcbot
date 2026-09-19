#!/usr/bin/env node
// Retire the current seed and move everything to a fresh one — the ceremony
// SKILL.md prescribes ("the only revocation is sweeping to a new wallet") and
// the one to run when seed.enc, a backup of it, or the words may have leaked.
// (Passphrase leaked, file intact? That is `sparkbtcbot rekey`.)
//
// What it does, in order — the order is the crash-safety story:
//   1. decrypt the current seed; boot BOTH wallets (old, and a freshly
//      generated one) in this process;
//   2. plan: balances, unclaimed L1 deposits (refuses while any wait — a
//      claim in flight during a sweep is stranded), the new address;
//   3. dry run stops here. With --execute:
//   4. write the NEW seed to seed.enc.next and the OLD seed to
//      ~/.spark/retired/<date>-<pubkey>/seed.enc BEFORE moving a sat — an
//      interruption after this point leaves both seeds on disk, never a
//      balance whose mnemonic lives only in memory;
//   5. privacy on for the new wallet (before it receives anything, or its
//      history is public from the first transfer), then sweep sats and every
//      token — Spark-to-Spark, instant, zero fee — and wait for the new wallet
//      to claim them;
//   6. rename seed.enc.next → seed.enc, file the old leaf-vault beside the
//      retired seed, snapshot a fresh vault for the new wallet, reset the
//      signed ledger if a budget is sealed (new mnemonic = new HMAC key; the
//      sealed policy itself carries over unchanged);
//   7. print the checklist of what just went stale.
//
// The retired seed is an ordinary seed.enc under the same passphrase: every
// existing tool works on it via SPARK_SEED_PATH (late arrivals: the old static
// L1 deposit address can't be revoked, and anyone holding an old invoice can
// still pay it). In the compromise case keeping it doesn't PROTECT late funds
// — the attacker has the seed too — it lets you race for them and exit.
//
// TTY-gated on both ends like the other ceremonies; run it from a machine you
// trust. Running rotate FROM a compromised process hands the attacker the new
// seed.
import "dotenv/config";
import { stdin, stdout, stderr, exit, env } from "node:process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { mkdir, rename, access, copyFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SparkWallet } from "@buildonspark/spark-sdk";
import {
  loadSeedPayload,
  saveEncryptedMnemonic,
  deriveLedgerHmacKey,
  DEFAULT_SEED_PATH,
  MIN_PASSPHRASE_CHARS,
} from "../../../lib/encrypted-seed.js";
import { initSignedLedger, DEFAULT_SPEND_LEDGER_PATH } from "../../../lib/spend-ledger.js";
import { atomicWriteFile } from "../../../lib/atomic-file.js";
import { ensureWalletPrivacy, privacyPreferenceFromEnv } from "../../../lib/wallet-privacy.js";
import { snapshotLeafVault, defaultVaultPath } from "./leaf-vault.js";
import { promptStderr } from "./prompt.js";

const USAGE =
  "Usage: sparkbtcbot rotate [--execute]\n\n" +
  "Retire the current seed and move every sat and token to a freshly generated one.\n" +
  "Without --execute this is a DRY RUN: it decrypts the seed (passphrase typed, never\n" +
  "read from .env), boots the wallet, and prints balances, unclaimed deposits, and the\n" +
  "plan — nothing moves. With --execute it writes the new seed to seed.enc.next and the\n" +
  "old seed to ~/.spark/retired/<date>-<pubkey>/ BEFORE sweeping (an interrupted run\n" +
  "leaves both seeds on disk), enables privacy on the new wallet, sweeps, then swaps\n" +
  "seed.enc atomically. The sealed policy carries over; a sealed budget gets a fresh\n" +
  "signed ledger; a fresh leaf-vault is snapshotted. Refuses while an unclaimed L1\n" +
  "deposit is waiting (claim it first). Use it when seed.enc, a backup, or the words\n" +
  "may have leaked — for a leaked PASSPHRASE with the file intact, use `rekey`.\n" +
  "Refuses to run without a real interactive terminal.\n\n" +
  "Env: SPARK_NETWORK, SPARK_SEED_PATH, SPARK_SPEND_LEDGER_PATH, SPARK_LEAF_VAULT_PATH, SPARK_PRIVACY.\n";

const exists = (p) => access(p).then(() => true, () => false);

// The one recovery story for an interrupted --execute: both seeds are on disk
// and complete; the only thing left is the rename, which the operator does
// once they have SEEN the new wallet claim the sweep.
const finishByHand = (seedPath, retiredDir) =>
  "Both seeds are intact and complete:\n" +
  `  ${seedPath}       = the OLD wallet (retired copy${retiredDir ? ` at ${retiredDir}/seed.enc` : " under ~/.spark/retired/"})\n` +
  `  ${seedPath}.next  = the NEW wallet (holds whatever was swept)\n` +
  "Finish by hand: boot the new seed and confirm it has claimed the balance —\n" +
  `  SPARK_SEED_PATH=${seedPath}.next npm run example:balance\n` +
  `then move it into place:  mv ${seedPath}.next ${seedPath}\n` +
  "Do not delete either file until the balance is where you expect.\n";

// --- Plan: what the old wallet holds and whether it is safe to move it.
export async function planRotation(oldWallet, { depositLimit = 100 } = {}) {
  const [address, identityPublicKey, balance, depositAddress] = await Promise.all([
    oldWallet.getSparkAddress(),
    oldWallet.getIdentityPublicKey(),
    oldWallet.getBalance(),
    oldWallet.getStaticDepositAddress().catch(() => null),
  ]);
  const sats = BigInt(balance.satsBalance?.available ?? balance.satsBalance ?? 0n);
  const tokens = [];
  for (const [tokenIdentifier, info] of balance.tokenBalances?.entries?.() ?? []) {
    const amount = BigInt(info.ownedBalance ?? 0n);
    if (amount > 0n) tokens.push({ tokenIdentifier, amount, ticker: info.tokenMetadata?.tokenTicker ?? "?" });
  }
  const pendingDeposits = [];
  try {
    for (const addr of await oldWallet.queryStaticDepositAddresses()) {
      for (const u of await oldWallet.getUtxosForDepositAddress(addr, depositLimit, 0, true)) {
        pendingDeposits.push({ address: addr, txid: u.txid, vout: u.vout });
      }
    }
  } catch { /* SDK without static-deposit support — nothing to wait on */ }
  return { address, identityPublicKey, depositAddress, sats, tokens, pendingDeposits };
}

// --- Sweep: old → new, then wait until the new wallet has CLAIMED it. Both
// wallets run in this process, so the receiver's claim loop is live; a claim
// that never lands is reported, never assumed.
export async function sweepToWallet(oldWallet, newWallet, plan, { log = () => {}, pollMs = 2_000, timeoutMs = 120_000, privacy = true } = {}) {
  const to = await newWallet.getSparkAddress();
  if (privacy) {
    try { await ensureWalletPrivacy(newWallet); log(`privacy: enabled on ${to}`); }
    catch (err) { log(`⚠️  privacy NOT enabled on the new wallet (${err?.message ?? err}) — it self-heals on the next SparkAgent boot`); }
  }
  const results = { sats: null, tokens: [] };
  if (plan.sats > 0n) {
    results.sats = await oldWallet.transfer({ receiverSparkAddress: to, amountSats: Number(plan.sats) });
    log(`sent ${plan.sats} sats → ${to} (${results.sats?.id ?? "ok"})`);
  }
  for (const t of plan.tokens) {
    const r = await oldWallet.transferTokens({ tokenIdentifier: t.tokenIdentifier, tokenAmount: t.amount, receiverSparkAddress: to });
    results.tokens.push({ ...t, id: typeof r === "string" ? r : r?.id ?? null });
    log(`sent ${t.amount} ${t.ticker} → ${to}`);
  }
  // Verify arrival on the NEW wallet.
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const b = await newWallet.getBalance();
    const got = BigInt(b.satsBalance?.available ?? b.satsBalance ?? 0n);
    const tokensOk = plan.tokens.every((t) => BigInt(b.tokenBalances?.get?.(t.tokenIdentifier)?.ownedBalance ?? 0n) >= t.amount);
    last = { sats: got, tokensOk };
    if (got >= plan.sats && tokensOk) return { ...results, to, verified: true, newBalanceSats: got };
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const e = new Error(
    `sweep sent but the new wallet has not claimed it yet (has ${last?.sats ?? "?"} sats, expected ≥ ${plan.sats}; tokens ${last?.tokensOk ? "ok" : "pending"})`,
  );
  e.code = "ROTATE_UNVERIFIED";
  throw e;
}

// --- Files, stage 1 (BEFORE the sweep): stash both seeds on disk.
export async function stageSeeds({ seedPath = DEFAULT_SEED_PATH, passphrase, oldPayload, newMnemonic, identityPublicKey, now = new Date() }) {
  const nextPath = `${seedPath}.next`;
  if (await exists(nextPath)) {
    const e = new Error(`${nextPath} already exists — a previous rotation was interrupted. Finish or resolve it first (both seeds are intact: seed.enc is the old wallet, seed.enc.next the new one).`);
    e.code = "ROTATE_IN_PROGRESS";
    throw e;
  }
  const stamp = now.toISOString().slice(0, 10);
  const retiredDir = join(dirname(seedPath), "retired", `${stamp}-${String(identityPublicKey).slice(0, 8)}`);
  await mkdir(retiredDir, { recursive: true, mode: 0o700 });
  // Old seed → retired copy (exclusive: never overwrite a previous retirement).
  await saveEncryptedMnemonic({ mnemonic: oldPayload.mnemonic, passphrase, path: join(retiredDir, "seed.enc"), policy: oldPayload.policy });
  // New seed → .next, same passphrase, same sealed policy (exclusive).
  await saveEncryptedMnemonic({ mnemonic: newMnemonic, passphrase, path: nextPath, policy: oldPayload.policy });
  return { nextPath, retiredDir };
}

// --- Files, stage 2 (AFTER a verified sweep): publish the new seed, file the
// old wallet's artefacts, reset the ledger under the new mnemonic.
export async function commitRotation({
  seedPath = DEFAULT_SEED_PATH, nextPath, retiredDir, ledgerPath = DEFAULT_SPEND_LEDGER_PATH, vaultPath = defaultVaultPath(),
  oldPayload, newMnemonic, plan, sweep, newIdentityPublicKey, now = new Date(),
}) {
  await rename(nextPath, seedPath); // atomic: seed.enc is old or new, never partial
  // The old vault matters only if late funds land in the retired wallet; keep
  // it beside the retired seed rather than let the new snapshot overwrite it.
  if (await exists(vaultPath)) {
    const dest = join(retiredDir, "leaf-vault.json");
    try { await rename(vaultPath, dest); } catch { await copyFile(vaultPath, dest); await unlink(vaultPath); }
  }
  if (oldPayload.policy?.dailyBudgetSats != null) {
    await initSignedLedger({ path: ledgerPath, hmacKey: deriveLedgerHmacKey(newMnemonic) });
  }
  const manifest = {
    schema: "sparkbtcbot.retired-seed.v1",
    retiredAt: now.toISOString(),
    identityPublicKey: plan.identityPublicKey,
    sparkAddress: plan.address,
    staticDepositAddress: plan.depositAddress,
    sweptSats: plan.sats.toString(),
    sweptTokens: plan.tokens.map((t) => ({ tokenIdentifier: t.tokenIdentifier, amount: t.amount.toString(), ticker: t.ticker })),
    sweepIds: { sats: sweep.sats?.id ?? null, tokens: sweep.tokens.map((t) => t.id) },
    successor: { identityPublicKey: newIdentityPublicKey, sparkAddress: sweep.to },
    howToUse: `SPARK_SEED_PATH=${join(retiredDir, "seed.enc")} works with every sparkbtcbot command (balance, reveal-mnemonic, leaf-vault).`,
  };
  await atomicWriteFile(join(retiredDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  return manifest;
}

export async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { stdout.write(USAGE); exit(0); }
  let execute = false;
  if (args.length === 1 && args[0] === "--execute") execute = true;
  else if (args.length) { stderr.write(`rotate: unknown argument(s): ${args.join(" ")}\n\n` + USAGE); exit(2); }

  if (!stdout.isTTY || !stdin.isTTY) {
    stderr.write(
      "rotate: refusing to run without a real interactive terminal on both stdin and stdout.\n" +
      "Retiring a seed is an operator ceremony — run it yourself, from a machine you trust; an agent must not.\n",
    );
    exit(3);
  }

  const network = env.SPARK_NETWORK || "MAINNET";
  const seedPath = env.SPARK_SEED_PATH || DEFAULT_SEED_PATH;
  const ledgerPath = env.SPARK_SPEND_LEDGER_PATH || DEFAULT_SPEND_LEDGER_PATH;
  const vaultPath = defaultVaultPath();
  const log = (m) => stderr.write(`  ${m}\n`);

  if (await exists(`${seedPath}.next`)) {
    stderr.write(`rotate: ${seedPath}.next exists — a previous rotation was interrupted; refusing to start another.\n` + finishByHand(seedPath, null));
    exit(1);
  }

  const passphrase = await promptStderr(`Passphrase for ${seedPath} (typed, not read from .env): `, { hidden: true });
  if (!passphrase || passphrase.length < MIN_PASSPHRASE_CHARS) {
    stderr.write(`rotate: passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters.\n`);
    exit(1);
  }
  const oldPayload = await loadSeedPayload({ passphrase, path: seedPath });

  stderr.write(`Booting the current wallet on ${network}…\n`);
  const { wallet: oldWallet } = await SparkWallet.initialize({ mnemonicOrSeed: oldPayload.mnemonic, options: { network } });
  let newWallet = null;
  let newMnemonic = null;
  // Everything below RETURNS an exit code instead of calling exit(): the
  // finally must run so both wallets' streams are torn down (otherwise a dry
  // run leaves the process hanging on the SDK's gRPC handles).
  const run = async () => {
    const plan = await planRotation(oldWallet);
    stderr.write("\n=== plan ===\n");
    log(`current wallet   ${plan.address}`);
    log(`identity key     ${plan.identityPublicKey}`);
    log(`sats             ${plan.sats}`);
    for (const t of plan.tokens) log(`token            ${t.amount} ${t.ticker} (${t.tokenIdentifier.slice(0, 20)}…)`);
    if (plan.depositAddress) log(`static L1 addr   ${plan.depositAddress}  ← stays valid forever; update wherever you published it`);
    if (plan.pendingDeposits.length) {
      stderr.write(`\nrotate: ${plan.pendingDeposits.length} unclaimed L1 deposit(s) are waiting (${plan.pendingDeposits.map((d) => `${d.txid.slice(0, 10)}…:${d.vout}`).join(", ")}). Claim them first (agent.claimDeposit), then re-run. Nothing changed.\n`);
      return 1;
    }
    if (plan.sats === 0n && plan.tokens.length === 0) log("nothing to sweep — rotation would only retire the seed");

    // A fresh wallet: the SDK generates the mnemonic; it exists only in this
    // process until stageSeeds writes it, which happens before any sweep.
    const fresh = await SparkWallet.initialize({ options: { network } });
    newWallet = fresh.wallet;
    newMnemonic = fresh.mnemonic;
    const newAddress = await newWallet.getSparkAddress();
    const newIdentityPublicKey = await newWallet.getIdentityPublicKey();
    log(`new wallet       ${newAddress}`);
    log(`sealed policy    ${oldPayload.policy ? "carried over unchanged" + (oldPayload.policy.dailyBudgetSats != null ? " (budget → fresh signed ledger)" : "") : "none (v1 seed)"}`);

    if (!execute) {
      stderr.write("\nDry run — nothing moved, nothing written. Re-run with --execute to rotate.\n");
      return 0;
    }
    const confirm = (await promptStderr(`\nAbout to retire ${plan.address} and sweep ${plan.sats} sats${plan.tokens.length ? ` + ${plan.tokens.length} token balance(s)` : ""} to ${newAddress}.\nType 'rotate' to proceed: `)).trim().toLowerCase();
    if (confirm !== "rotate") { stderr.write("Aborted — nothing changed.\n"); return 0; }

    stderr.write("\n=== stage 1: both seeds to disk ===\n");
    const { nextPath, retiredDir } = await stageSeeds({ seedPath, passphrase, oldPayload, newMnemonic, identityPublicKey: plan.identityPublicKey });
    log(`old seed → ${join(retiredDir, "seed.enc")}`);
    log(`new seed → ${nextPath}`);
    log("(if anything below fails, BOTH seeds are on disk — do not delete either)");

    stderr.write("\n=== stage 2: sweep ===\n");
    let sweep;
    try {
      sweep = await sweepToWallet(oldWallet, newWallet, plan, { log, privacy: privacyPreferenceFromEnv() });
    } catch (err) {
      if (err?.code !== "ROTATE_UNVERIFIED") throw err;
      stderr.write(`\nrotate: ${err.message}.\n` + finishByHand(seedPath, retiredDir));
      return 1;
    }
    log(`verified: new wallet holds ${sweep.newBalanceSats} sats`);

    stderr.write("\n=== stage 3: publish ===\n");
    await commitRotation({ seedPath, nextPath, retiredDir, ledgerPath, vaultPath, oldPayload, newMnemonic, plan, sweep, newIdentityPublicKey });
    log(`${seedPath} is now the new wallet`);
    try {
      const snap = await snapshotLeafVault(newWallet, { path: vaultPath, networkLabel: network });
      log(snap?.leafCount
        ? `leaf-vault snapshot → ${vaultPath} (${snap.leafCount} leaves)`
        : "leaf-vault: the new wallet holds no leaves yet — nothing to back up; it snapshots on the next SparkAgent boot");
    } catch (err) {
      log(`⚠️  leaf-vault snapshot failed (${err?.message ?? err}) — it refreshes on the next SparkAgent boot`);
    }

    stderr.write(
      "\n=== rotated — now update what went stale ===\n" +
      `  - anywhere you published the OLD deposit address ${plan.depositAddress ?? "(none)"} or Spark address ${plan.address}\n` +
      "  - any UNPAID Spark invoices you issued (they name the old identity; reissue them)\n" +
      "  - any place that pinned the old identity public key\n" +
      `  - the retired seed stays usable under the same passphrase for late arrivals:\n      SPARK_SEED_PATH=${join(retiredDir, "seed.enc")} npm exec --no -- sparkbtcbot <command>\n` +
      "  - if you rotated because the PASSPHRASE also leaked, run `sparkbtcbot rekey` now\n",
    );
    return 0;
  };
  let code = 1;
  try {
    code = await run();
  } finally {
    await oldWallet.cleanup?.().catch?.(() => {});
    await newWallet?.cleanup?.().catch?.(() => {});
  }
  exit(code);
}

const isMainModule = (() => {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return false;
  }
})();

if (isMainModule) {
  main().catch((e) => {
    stderr.write(`rotate: ${e?.message ?? e}\n`);
    exit(1);
  });
}
