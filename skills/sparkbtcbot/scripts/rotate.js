#!/usr/bin/env node
// `sparkbtcbot rotate`: retire this wallet's seed and move every sat and token
// to a freshly generated one. The only real revocation there is: a seed that
// may have leaked (shown in a chat transcript, copied off the machine) keeps
// spending authority until the money is somewhere it can't reach.
//
// Made for the chat-only case, like `limits`: a hosted agent runs it when the
// user asks, with no terminal and no typed passphrase (it reads
// SPARK_PASSPHRASE like the runtime does). The skill's rule is that it runs
// only on the user's own request, dry run first, `--execute` on their yes.
//
//   rotate                 the plan: balances, what blocks it, the new address. Nothing moves.
//   rotate --execute       do it (the order below is the crash-safety story)
//   rotate --resume        finish a rotation that was interrupted
//   rotate --check-old     look at retired wallets for anything that arrived since
//   rotate --check-old --sweep   claim their deposits and move what they hold to this wallet
//
// --execute, in order:
//   1. both seeds to disk BEFORE a sat moves: the new one to seed.enc.next, the
//      old one to ~/.spark/retired/<date>-<key>/seed.enc (same passphrase, same
//      sealed policy). Interrupted after this, both seeds are complete on disk;
//   2. privacy on for the new wallet before it receives anything;
//   3. sweep every sat and token Spark-to-Spark (instant, free) and wait until
//      the new wallet has claimed it;
//   4. seed.enc.next -> seed.enc (atomic), the old backup filed beside the
//      retired seed, a sealed ledger re-signed under the new key with its
//      window kept, a fresh backup for the new wallet, a manifest.
//
// The sweep goes around the daily budget, the user's spending limits and the
// allowlist, by construction rather than by a flag: its destination is the
// address of the wallet this process just generated (or, for --check-old,
// the one in seed.enc), never a value from input. It moves the user's money
// between the user's own wallets. Spending limits are a file, not the wallet,
// so the new wallet keeps them.
//
// Not revocation of everything: the old static deposit address and old
// invoices still pay the OLD wallet. That is why its seed is kept, and why
// --check-old exists. A rotation that happens because the seed leaked is a
// race against whoever has it; this moves first.
import "dotenv/config";
import { stdout, stderr, exit, env } from "node:process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { mkdir, rename, access, copyFile, unlink, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { loadSeedPayload, saveEncryptedMnemonic, deriveLedgerHmacKey, DEFAULT_SEED_PATH } from "../../../lib/encrypted-seed.js";
import { createSpendLedger, initSignedLedger, DEFAULT_SPEND_LEDGER_PATH } from "../../../lib/spend-ledger.js";
import { atomicWriteFile } from "../../../lib/atomic-file.js";
import { ensureWalletPrivacy, privacyPreferenceFromEnv } from "../../../lib/wallet-privacy.js";
import { sparkWalletOptions } from "../../../lib/wallet-options.js";
import { createL402HoldStore } from "../../../lib/l402-holds.js";
import { snapshotLeafVault, defaultVaultPath } from "./leaf-vault.js";

const USAGE =
  "Usage: sparkbtcbot rotate [--execute | --resume | --check-old [--sweep]]\n\n" +
  "Retire this wallet's seed and move every sat and token to a freshly generated\n" +
  "wallet: the fix when the recovery words may have leaked (shown in a chat, copied\n" +
  "somewhere). With no flag it is a DRY RUN: it prints the plan and moves nothing.\n" +
  "  --execute     do it: both seeds go to disk before anything moves, then the sweep\n" +
  "  --resume      finish a rotation that was interrupted (seed.enc.next exists)\n" +
  "  --check-old   look at retired wallets for anything that arrived since\n" +
  "  --sweep       with --check-old: claim their deposits, move it all to this wallet\n\n" +
  "Run --execute ONLY because the user asked, in their own message, after seeing\n" +
  "the dry run. Afterwards the recovery words are new: the old ones no longer hold\n" +
  "the money. Reads SPARK_PASSPHRASE like the wallet does.\n\n" +
  "Env: SPARK_PASSPHRASE, SPARK_NETWORK, SPARK_SEED_PATH, SPARK_LEAF_VAULT_PATH,\n" +
  "SPARK_SPEND_LEDGER_PATH, SPARK_L402_HOLDS_PATH, SPARK_PRIVACY.\n";

const exists = (p) => access(p).then(() => true, () => false);
const retiredRoot = (seedPath) => join(dirname(seedPath), "retired");
const statePath = (seedPath) => `${seedPath}.rotation.json`;

class Refusal extends Error {} // a planned stop: the message is the answer

// One-shot wallets: fee ladders off (sparkWalletOptions), no leaf optimizer.
export const defaultDeps = {
  openWallet: async (mnemonic, network) =>
    (await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, options: sparkWalletOptions(network, { optimizationOptions: { auto: false } }) })).wallet,
  generateWallet: async (network) => {
    const { wallet, mnemonic } = await SparkWallet.initialize({ options: sparkWalletOptions(network, { optimizationOptions: { auto: false } }) });
    return { wallet, mnemonic };
  },
};

// --- What a wallet holds, and what would be left behind.
export async function readHoldings(wallet, { depositAddress: wantDepositAddress = false } = {}) {
  const [address, identityPublicKey, balance] = await Promise.all([
    wallet.getSparkAddress(),
    wallet.getIdentityPublicKey(),
    wallet.getBalance(),
  ]);
  const sb = balance.satsBalance ?? {};
  const available = BigInt(sb.available ?? 0n);
  const owned = BigInt(sb.owned ?? available);
  const tokens = [];
  for (const [tokenIdentifier, info] of balance.tokenBalances?.entries?.() ?? []) {
    const amount = BigInt(info.availableToSendBalance ?? info.ownedBalance ?? 0n);
    if (amount > 0n) tokens.push({ tokenIdentifier, amount, ticker: info.tokenMetadata?.tokenTicker ?? "?" });
  }
  const pendingDeposits = [];
  try {
    for (const addr of await wallet.queryStaticDepositAddresses()) {
      for (const u of await wallet.getUtxosForDepositAddress(addr, 100, 0, true)) {
        pendingDeposits.push({ address: addr, txid: u.txid, vout: u.vout });
      }
    }
  } catch { /* none readable now: reported as none, the check can be run again */ }
  // Only for the wallet being retired: asking a wallet for it can create one.
  const depositAddress = wantDepositAddress ? await wallet.getStaticDepositAddress?.().catch(() => null) ?? null : null;
  return {
    address, identityPublicKey, depositAddress, sats: available,
    lockedSats: owned > available ? owned - available : 0n,
    incomingSats: BigInt(sb.incoming ?? 0n),
    tokens, pendingDeposits,
  };
}

// One token's whole balance, in as many transfers as the SDK needs. A transfer
// carries at most 500 of the token's outputs, and for a larger amount the SDK
// refuses locally ("Insufficient token amount") before anything is sent, so
// only that refusal halves the amount and tries again. Any other error stops
// this token. Returns what moved, and the error if any is left.
const TOKEN_TRANSFERS_MAX = 64;
async function sendTokenBalance(from, toAddress, t) {
  let remaining = t.amount;
  let moved = 0n;
  const ids = [];
  try {
    while (remaining > 0n && ids.length < TOKEN_TRANSFERS_MAX) {
      let amount = remaining;
      for (;;) {
        try {
          const r = await from.transferTokens({ tokenIdentifier: t.tokenIdentifier, tokenAmount: amount, receiverSparkAddress: toAddress });
          ids.push(typeof r === "string" ? r : r?.id ?? null);
          break;
        } catch (err) {
          if (!/insufficient token amount/i.test(String(err?.message ?? "")) || amount <= 1n) throw err;
          amount /= 2n;
        }
      }
      moved += amount;
      remaining -= amount;
    }
    return { moved, ids, error: remaining > 0n ? new Error(`still ${remaining} left after ${TOKEN_TRANSFERS_MAX} transfers`) : null };
  } catch (err) {
    return { moved, ids, error: err };
  }
}

// --- Move everything `from` holds to `to`'s own address, then wait until `to`
// has claimed it. Raw SDK calls on purpose: see the header.
// Each token is tried on its own. A token that can't move (more outputs than
// transfers allow, a freeze) used to throw out of the whole sweep after the
// sats had moved: every --resume failed the same way, seed.enc stayed on the
// leaked wallet, and the tokens listed after it never moved (review
// 2026-11-09, ROT-1). It is now left behind, reported, and retried by
// --check-old --sweep; only the sats and the tokens that moved are checked.
export async function sweep(from, to, holdings, { log = () => {}, pollMs = 2_000, timeoutMs = 120_000 } = {}) {
  const toAddress = await to.getSparkAddress();
  const before = BigInt((await to.getBalance()).satsBalance?.available ?? 0n);
  const sent = { sats: null, tokens: [], leftBehind: [] };
  if (holdings.sats > 0n) {
    sent.sats = await from.transfer({ receiverSparkAddress: toAddress, amountSats: Number(holdings.sats) });
    log(`sent ${holdings.sats} sats to ${toAddress}`);
  }
  for (const t of holdings.tokens) {
    const { moved, ids, error } = await sendTokenBalance(from, toAddress, t);
    if (moved > 0n) {
      sent.tokens.push({ ...t, amount: moved, ids });
      log(`sent ${moved} ${t.ticker} to ${toAddress}${ids.length > 1 ? ` in ${ids.length} transfers` : ""}`);
    }
    if (error) {
      sent.leftBehind.push({ ...t, amount: t.amount - moved, reason: String(error?.message ?? error).slice(0, 200) });
      log(`couldn't send ${t.amount - moved} ${t.ticker} (${String(error?.message ?? error).slice(0, 120)}); it stays with the old wallet for --check-old --sweep`);
    }
  }
  const want = before + holdings.sats;
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    const b = await to.getBalance();
    const got = BigInt(b.satsBalance?.available ?? 0n);
    const tokensOk = sent.tokens.every((t) => BigInt(b.tokenBalances?.get?.(t.tokenIdentifier)?.ownedBalance ?? 0n) >= t.amount);
    last = { got, tokensOk };
    if (got >= want && tokensOk) return { toAddress, sent, verified: true, balanceSats: got };
    if (Date.now() >= deadline) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const e = new Error(`the sweep was sent, but the receiving wallet hasn't claimed it yet (it holds ${last.got} sats, expected at least ${want}; tokens ${last.tokensOk ? "in" : "pending"})`);
  e.code = "ROTATE_UNVERIFIED";
  throw e;
}

// --- Stage 1 (before anything moves): both seeds on disk.
export async function stageSeeds({ seedPath, passphrase, oldPayload, newMnemonic, oldKey, newHoldings, now = new Date() }) {
  const nextPath = `${seedPath}.next`;
  const retiredDir = join(retiredRoot(seedPath), `${now.toISOString().slice(0, 10)}-${String(oldKey).slice(0, 12)}`);
  await mkdir(retiredDir, { recursive: true, mode: 0o700 });
  // Both exclusive: never overwrite an earlier retirement or a staged seed.
  await saveEncryptedMnemonic({ mnemonic: oldPayload.mnemonic, passphrase, path: join(retiredDir, "seed.enc"), policy: oldPayload.policy });
  await saveEncryptedMnemonic({ mnemonic: newMnemonic, passphrase, path: nextPath, policy: oldPayload.policy });
  const state = {
    schema: "sparkbtcbot.rotation.v1", state: "staged", startedAt: now.toISOString(), retiredDir, nextPath,
    old: { identityPublicKey: oldKey }, new: { identityPublicKey: newHoldings.identityPublicKey, sparkAddress: newHoldings.address },
  };
  await atomicWriteFile(statePath(seedPath), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  return state;
}

// --- Stage 2 (after a verified sweep): the new seed in place, the old wallet's
// files beside its retired seed, the ledger under the new key.
// A sealed ledger is signed with a key from the mnemonic. Read its window
// BEFORE anything moves (a ledger that fails verification stops the rotation
// there), so the commit can sign the same spends again under the new key: the
// budget doesn't restart because the seed did. null when nothing is sealed.
export async function readSealedWindow(oldPayload, ledgerPath) {
  if (oldPayload.policy?.dailyBudgetSats == null) return null;
  const { entries } = await createSpendLedger({
    path: ledgerPath, budgetSats: oldPayload.policy.dailyBudgetSats, hmacKey: deriveLedgerHmacKey(oldPayload.mnemonic), bound: true,
  }).status();
  return entries;
}

export async function commitRotation({ seedPath, ledgerPath, vaultPath, state, sealedEntries, newMnemonic, oldHoldings, swept, now = new Date() }) {
  if (sealedEntries) await initSignedLedger({ path: ledgerPath, hmacKey: deriveLedgerHmacKey(newMnemonic), entries: sealedEntries });
  await rename(state.nextPath, seedPath); // atomic: seed.enc is old or new, never partial
  if (await exists(vaultPath)) {
    const dest = join(state.retiredDir, "leaf-vault.json");
    try { await rename(vaultPath, dest); } catch { await copyFile(vaultPath, dest); await unlink(vaultPath); }
  }
  const manifest = {
    schema: "sparkbtcbot.retired-seed.v1",
    retiredAt: now.toISOString(),
    identityPublicKey: oldHoldings.identityPublicKey,
    sparkAddress: oldHoldings.address,
    staticDepositAddress: oldHoldings.depositAddress,
    sweptSats: String(swept.sats),
    sweptTokens: swept.tokens.map((t) => ({ tokenIdentifier: t.tokenIdentifier, amount: String(t.amount), ticker: t.ticker })),
    tokensLeftBehind: (swept.leftBehind ?? []).map((t) => ({ tokenIdentifier: t.tokenIdentifier, amount: String(t.amount), ticker: t.ticker, reason: t.reason })),
    successor: state.new,
  };
  await atomicWriteFile(join(state.retiredDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  await unlink(statePath(seedPath)).catch(() => {});
  return manifest;
}

const fmt = (h) => [
  `  address        ${h.address}`,
  `  sats           ${h.sats} spendable${h.lockedSats > 0n ? `, ${h.lockedSats} locked` : ""}${h.incomingSats > 0n ? `, ${h.incomingSats} incoming` : ""}`,
  ...h.tokens.map((t) => `  token          ${t.amount} ${t.ticker} (${t.tokenIdentifier.slice(0, 24)}…)`),
  ...h.pendingDeposits.map((d) => `  L1 deposit     ${d.txid.slice(0, 16)}…:${d.vout} waiting to be claimed`),
].join("\n");

function leftBehind(h) {
  const notes = [];
  if (h.lockedSats > 0n || h.incomingSats > 0n) notes.push(`${h.lockedSats + h.incomingSats} sats locked or incoming stay with the old wallet until they settle`);
  if (h.pendingDeposits.length) notes.push(`${h.pendingDeposits.length} L1 deposit(s) waiting to be claimed stay at the old deposit address`);
  return notes;
}

const AFTER =
  "What changed:\n" +
  "  - The recovery words are NEW. The old words no longer hold the money: tell the user.\n" +
  "    If they can only reach you through this chat, don't offer the new words as their\n" +
  "    backup: anything you show stays in the chat, where the old ones leaked. Keep this\n" +
  "    wallet small, and move what they want to keep to a wallet they hold (its words on\n" +
  "    paper, never in the chat). With a terminal, they back up the new words with\n" +
  "    reveal-mnemonic as at setup.\n" +
  "  - The old Spark address, deposit address and unpaid invoices still pay the OLD wallet.\n" +
  "    Its seed is kept for that: `sparkbtcbot rotate --check-old` looks for anything that\n" +
  "    arrives there, and `--check-old --sweep` moves it here. Run it when the user asks,\n" +
  "    or now and then while old addresses may still be used.\n" +
  "  - The spending limits are unchanged. A running agent process still holds the old\n" +
  "    wallet: restart it.\n";

// --- The three runs. Each returns an exit code and writes its own report.
export async function runRotate({ execute = false, deps = defaultDeps, out = (s) => stdout.write(s), log = (s) => stderr.write(`  ${s}\n`), environment = env } = {}) {
  const network = environment.SPARK_NETWORK || "MAINNET";
  const seedPath = environment.SPARK_SEED_PATH || DEFAULT_SEED_PATH;
  if (await exists(`${seedPath}.next`)) {
    throw new Refusal(`A rotation was interrupted: ${seedPath}.next (the new wallet) is on disk. Run \`sparkbtcbot rotate --resume\` to finish it. Nothing changed.`);
  }
  const passphrase = takePassphrase(environment);
  const oldPayload = await loadSeedPayload({ passphrase, path: seedPath });
  const holds = (await createL402HoldStore().list()).length;
  if (holds) {
    throw new Refusal(
      `${holds} unfinished L402 purchase(s) belong to this wallet (status().l402.held). Finish each with fetchL402, ` +
        "or lift it with forgetL402 on the user's say-so, then rotate. Their payments can't be settled from a new wallet. Nothing changed.",
    );
  }
  const ledgerPath = environment.SPARK_SPEND_LEDGER_PATH || DEFAULT_SPEND_LEDGER_PATH;
  const sealedEntries = await readSealedWindow(oldPayload, ledgerPath);
  const oldWallet = await deps.openWallet(oldPayload.mnemonic, network);
  let fresh = null;
  try {
    const old = await readHoldings(oldWallet, { depositAddress: true });
    out(`Rotation plan (${network}):\nThis wallet, to be retired:\n${fmt(old)}\nEverything spendable moves to a freshly generated wallet.\n`);
    for (const n of leftBehind(old)) out(`Left behind: ${n}; \`rotate --check-old\` picks them up later.\n`);
    if (!execute) {
      out("\nDry run: nothing moved, nothing written. Show the user this plan; run `sparkbtcbot rotate --execute` only on their yes.\n");
      return 0;
    }
    fresh = await deps.generateWallet(network);
    const neu = await readHoldings(fresh.wallet);
    log(`new wallet ${neu.address}`);
    const state = await stageSeeds({ seedPath, passphrase, oldPayload, newMnemonic: fresh.mnemonic, oldKey: old.identityPublicKey, newHoldings: neu });
    log(`old seed kept at ${join(state.retiredDir, "seed.enc")}; new seed staged at ${state.nextPath}`);
    return await finish({ seedPath, network, environment, state, sealedEntries, newMnemonic: fresh.mnemonic, oldWallet, newWallet: fresh.wallet, old, out, log });
  } finally {
    await oldWallet.cleanup?.().catch?.(() => {});
    await fresh?.wallet.cleanup?.().catch?.(() => {});
  }
}

async function finish({ seedPath, network, environment, state, sealedEntries, newMnemonic, oldWallet, newWallet, old, out, log }) {
  if (privacyPreferenceFromEnv(environment)) {
    try { await ensureWalletPrivacy(newWallet); log("privacy on for the new wallet"); }
    catch (err) { log(`privacy could not be turned on for the new wallet yet (${err?.message ?? err}); its next boot retries`); }
  }
  let swept;
  try {
    swept = await sweep(oldWallet, newWallet, old, { log });
  } catch (err) {
    out(
      `\nThe sweep didn't finish: ${err?.message ?? err}\n` +
        "Both seeds are on disk and complete. Run `sparkbtcbot rotate --resume` to finish: it moves whatever is still in the " +
        "old wallet and waits for the new one to claim it. Nothing is lost, and nothing can be sent anywhere but the new wallet.\n",
    );
    return 1;
  }
  const vaultPath = environment.SPARK_LEAF_VAULT_PATH || defaultVaultPath();
  await commitRotation({
    seedPath, ledgerPath: environment.SPARK_SPEND_LEDGER_PATH || DEFAULT_SPEND_LEDGER_PATH, vaultPath,
    state, sealedEntries, newMnemonic, oldHoldings: old, swept: { sats: old.sats, tokens: swept.sent.tokens, leftBehind: swept.sent.leftBehind },
  });
  if (environment.SPARK_LEAF_VAULT !== "off") {
    try {
      const snap = await snapshotLeafVault(newWallet, { path: vaultPath, networkLabel: network });
      log(snap?.leafCount ? `backup written for the new wallet (${snap.leafCount} leaves)` : "the new wallet holds nothing to back up yet");
    } catch (err) {
      log(`the new wallet's backup failed (${err?.message ?? err}); the next SparkAgent boot writes it`);
    }
  }
  const behind = swept.sent.leftBehind.map((t) => `Left behind in the old wallet: ${t.amount} ${t.ticker} (${t.tokenIdentifier.slice(0, 24)}…): ${t.reason}. \`rotate --check-old --sweep\` tries again.\n`).join("");
  out(`\nRotated. ${seedPath} is now the new wallet: ${swept.toAddress}, holding ${swept.balanceSats} sats.\nThe old seed is kept at ${join(state.retiredDir, "seed.enc")}.\n${behind}\n${AFTER}`);
  return 0;
}

export async function runResume({ deps = defaultDeps, out = (s) => stdout.write(s), log = (s) => stderr.write(`  ${s}\n`), environment = env } = {}) {
  const network = environment.SPARK_NETWORK || "MAINNET";
  const seedPath = environment.SPARK_SEED_PATH || DEFAULT_SEED_PATH;
  let state;
  try {
    state = JSON.parse(await readFile(statePath(seedPath), "utf8"));
  } catch {
    throw new Refusal(`No interrupted rotation to finish (${statePath(seedPath)} isn't there). Nothing changed.`);
  }
  if (!(await exists(state.nextPath))) throw new Refusal(`${state.nextPath} is missing, so this rotation can't be finished from here. Nothing changed; tell the user.`);
  const passphrase = takePassphrase(environment);
  const oldPayload = await loadSeedPayload({ passphrase, path: seedPath });
  const newPayload = await loadSeedPayload({ passphrase, path: state.nextPath });
  const sealedEntries = await readSealedWindow(oldPayload, environment.SPARK_SPEND_LEDGER_PATH || DEFAULT_SPEND_LEDGER_PATH);
  const oldWallet = await deps.openWallet(oldPayload.mnemonic, network);
  const newWallet = await deps.openWallet(newPayload.mnemonic, network);
  try {
    const old = await readHoldings(oldWallet, { depositAddress: true });
    out(`Finishing the rotation (${network}). Still in the old wallet:\n${fmt(old)}\n`);
    return await finish({ seedPath, network, environment, state, sealedEntries, newMnemonic: newPayload.mnemonic, oldWallet, newWallet, old, out, log });
  } finally {
    await oldWallet.cleanup?.().catch?.(() => {});
    await newWallet.cleanup?.().catch?.(() => {});
  }
}

// The retired wallets: open each, report what it holds, and with `sweep`
// claim its deposits and move it all to the wallet in seed.enc.
export async function runCheckOld({ sweepNow = false, deps = defaultDeps, out = (s) => stdout.write(s), log = (s) => stderr.write(`  ${s}\n`), environment = env, makeAgent } = {}) {
  const network = environment.SPARK_NETWORK || "MAINNET";
  const seedPath = environment.SPARK_SEED_PATH || DEFAULT_SEED_PATH;
  const dirs = [];
  for (const name of await readdir(retiredRoot(seedPath)).catch(() => [])) {
    const dir = join(retiredRoot(seedPath), name);
    if (await exists(join(dir, "manifest.json")) && await exists(join(dir, "seed.enc"))) dirs.push(dir);
  }
  if (!dirs.length) { out("No retired wallets to check.\n"); return 0; }
  const passphrase = takePassphrase(environment);
  let current = null;
  let anything = false;
  try {
    if (sweepNow) {
      const cur = await loadSeedPayload({ passphrase, path: seedPath });
      current = await deps.openWallet(cur.mnemonic, network);
    }
    for (const dir of dirs) {
      const payload = await loadSeedPayload({ passphrase, path: join(dir, "seed.enc") });
      const wallet = await deps.openWallet(payload.mnemonic, network); // opening it claims transfers that arrived
      try {
        let h = await readHoldings(wallet);
        const has = h.sats > 0n || h.tokens.length || h.pendingDeposits.length || h.lockedSats > 0n || h.incomingSats > 0n;
        out(`Retired wallet ${dir}:\n${fmt(h)}\n`);
        if (!has) continue;
        anything = true;
        if (!sweepNow) continue;
        if (h.pendingDeposits.length) {
          // The claim goes through SparkAgent for its fee caps (the user's limits
          // apply too). Its backup is off here: it would overwrite this wallet's.
          const agent = await (makeAgent ?? defaultMakeAgent)(wallet, network, environment);
          for (const d of h.pendingDeposits) {
            try { await agent.claimDeposit({ txid: d.txid, vout: d.vout }); log(`claimed ${d.txid.slice(0, 16)}…:${d.vout}`); }
            catch (err) { out(`  Couldn't claim ${d.txid.slice(0, 16)}…:${d.vout} now (${err?.code ?? err?.message ?? err}); it stays there, check again later.\n`); }
          }
          h = await readHoldings(wallet);
        }
        if (h.sats > 0n || h.tokens.length) {
          try {
            const s = await sweep(wallet, current, h, { log });
            out(`  Moved ${h.sats} sats${s.sent.tokens.length ? ` and ${s.sent.tokens.length} token balance(s)` : ""} to this wallet (${s.toAddress}).\n`);
            for (const t of s.sent.leftBehind) out(`  Still in the old wallet: ${t.amount} ${t.ticker}: ${t.reason}.\n`);
          } catch (err) {
            out(`  The move didn't finish (${err?.message ?? err}); run --check-old --sweep again. It can only send to this wallet.\n`);
          }
        }
      } finally {
        await wallet.cleanup?.().catch?.(() => {});
      }
    }
  } finally {
    await current?.cleanup?.().catch?.(() => {});
  }
  if (!anything) out("Nothing has arrived at the retired wallets.\n");
  else if (!sweepNow) out("\nTell the user what arrived; `sparkbtcbot rotate --check-old --sweep` moves it to this wallet, on their say-so.\n");
  return 0;
}

async function defaultMakeAgent(wallet, network, environment) {
  environment.SPARK_LEAF_VAULT = "off"; // this process only: the retired wallet's backup must not replace this one's
  const { SparkAgent } = await import("./spark-agent.js");
  return new SparkAgent(wallet, network);
}

function takePassphrase(environment) {
  const passphrase = environment.SPARK_PASSPHRASE;
  if (!passphrase) {
    throw new Refusal("SPARK_PASSPHRASE isn't set: run from the directory whose .env holds it (dotenv reads the current directory's .env). Nothing changed.");
  }
  return passphrase;
}

export async function main(args = process.argv.slice(2)) {
  if (args.includes("--help") || args.includes("-h")) { stdout.write(USAGE); return exit(0); }
  const known = new Set(["--execute", "--resume", "--check-old", "--sweep"]);
  const bad = args.filter((a) => !known.has(a));
  const modes = ["--execute", "--resume", "--check-old"].filter((m) => args.includes(m));
  if (bad.length || modes.length > 1 || (args.includes("--sweep") && !args.includes("--check-old")) || new Set(args).size !== args.length) {
    stderr.write(`rotate: ${bad.length ? `unknown argument(s): ${bad.join(" ")}` : "pick one of --execute, --resume, --check-old (--sweep goes with --check-old)"}\n\n${USAGE}`);
    return exit(2);
  }
  try {
    let code;
    if (args.includes("--resume")) code = await runResume();
    else if (args.includes("--check-old")) code = await runCheckOld({ sweepNow: args.includes("--sweep") });
    else code = await runRotate({ execute: args.includes("--execute") });
    return exit(code);
  } catch (err) {
    stderr.write(`rotate: ${err?.message ?? err}\n`);
    return exit(1);
  }
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
