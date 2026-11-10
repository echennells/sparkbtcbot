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
import { validateMnemonic } from "@scure/bip39";
import { wordlist as englishWordlist } from "@scure/bip39/wordlists/english";
import { loadSeedPayload, saveEncryptedMnemonic, deriveLedgerHmacKey, normalizeMnemonic, DEFAULT_SEED_PATH } from "../../../lib/encrypted-seed.js";
import { createSpendLedger, rekeyLedger, DEFAULT_SPEND_LEDGER_PATH } from "../../../lib/spend-ledger.js";
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
const retiredDirFor = (seedPath, startedAt, key) => join(retiredRoot(seedPath), `${String(startedAt).slice(0, 10)}-${String(key).slice(0, 12)}`);

class Refusal extends Error {} // a planned stop: the message is the answer

// One-shot wallets: fee ladders off (sparkWalletOptions), no leaf optimizer.
// The words are normalized and checked as SparkAgent.create does them.
export const defaultDeps = {
  openWallet: async (mnemonic, network) => {
    const words = normalizeMnemonic(mnemonic);
    if (!validateMnemonic(words, englishWordlist)) throw new Refusal("A seed file holds words that aren't a valid recovery phrase (they are not shown). Nothing changed; tell the user.");
    return (await SparkWallet.initialize({ mnemonicOrSeed: words, options: sparkWalletOptions(network, { optimizationOptions: { auto: false } }) })).wallet;
  },
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
  const tokensPending = [];
  for (const [tokenIdentifier, info] of balance.tokenBalances?.entries?.() ?? []) {
    const amount = BigInt(info.availableToSendBalance ?? info.ownedBalance ?? 0n);
    const owned = BigInt(info.ownedBalance ?? amount);
    const ticker = info.tokenMetadata?.tokenTicker ?? "?";
    if (amount > 0n) tokens.push({ tokenIdentifier, amount, ticker });
    if (owned > amount) tokensPending.push({ tokenIdentifier, amount: owned - amount, ticker });
  }
  // Static and single-use deposit addresses, as SparkAgent.listPendingDeposits
  // reads them. A lookup that fails is reported as unknown, never as none: a
  // confident "nothing has arrived" hid a deposit the leaked words can claim
  // (review 2026-11-09, ROT-8).
  const pendingDeposits = [];
  let depositsUnknown = null;
  try {
    const seen = new Set();
    for (const [type, list] of [["static", await wallet.queryStaticDepositAddresses()], ["single-use", (await wallet.getUnusedDepositAddresses?.()) ?? []]]) {
      for (const addr of list) {
        if (seen.has(addr)) continue;
        seen.add(addr);
        for (const u of await wallet.getUtxosForDepositAddress(addr, 100, 0, true)) pendingDeposits.push({ address: addr, txid: u.txid, vout: u.vout, type });
      }
    }
  } catch (err) {
    depositsUnknown = String(err?.code ?? err?.message ?? err).slice(0, 120);
  }
  // Only for the wallet being retired: asking a wallet for it can create one.
  const depositAddress = wantDepositAddress ? await wallet.getStaticDepositAddress?.().catch(() => null) ?? null : null;
  return {
    address, identityPublicKey, depositAddress, sats: available,
    lockedSats: owned > available ? owned - available : 0n,
    incomingSats: BigInt(sb.incoming ?? 0n),
    tokens, tokensPending, pendingDeposits, depositsUnknown,
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

// Sweep, then keep going until the old wallet is empty. Sats it holds but
// can't send this instant (a leaf the SDK is renewing as the wallet opens, a
// claim still landing) free up within seconds, and more can arrive meanwhile.
// One sweep of one reading moved 244 of a retired wallet's 500 sats, with 256
// locked for a moment, and reported "Moved 244 sats" as if that were all of it
// (funded REGTEST, 2026-11-10). So: while anything is spendable, locked or
// incoming, sweep what can move, or wait; give up after SETTLE_WAITS waits in
// a row with nothing new to send. `left` is what still couldn't move.
// The sender's own balance isn't proof of that: after a send the receiver has
// claimed, it went on showing the sent sats as locked for 18 seconds and more
// (funded REGTEST, 2 runs of 10, each time right after a locked leaf had
// freed up and been sent). So locked sats count as left only up to what the
// wallet held at the start and hasn't delivered since. The first sweep's
// error is the caller's; a later one stops the loop and leaves the rest for
// --check-old.
const SETTLE_WAITS = 6;
const SETTLE_SWEEPS = 10;
const SETTLE_WAIT_MS = 3_000;
const unsettled = (b) => b.sats > 0n || b.lockedSats > 0n || b.incomingSats > 0n;
async function readSats(wallet) {
  const sb = (await wallet.getBalance()).satsBalance ?? {};
  const sats = BigInt(sb.available ?? 0n);
  const owned = BigInt(sb.owned ?? sats);
  return { sats, lockedSats: owned > sats ? owned - sats : 0n, incomingSats: BigInt(sb.incoming ?? 0n) };
}
export async function sweepAll(from, to, holdings, { log = () => {}, waitMs = SETTLE_WAIT_MS } = {}) {
  const heldAtStart = holdings.sats + (holdings.lockedSats ?? 0n) + (holdings.incomingSats ?? 0n);
  let swept = await sweep(from, to, holdings, { log });
  let movedSats = holdings.sats;
  const readLeft = async () => {
    const b = await readSats(from);
    const undelivered = heldAtStart > movedSats ? heldAtStart - movedSats : 0n;
    return { ...b, lockedSats: b.lockedSats < undelivered ? b.lockedSats : undelivered };
  };
  let left = await readLeft();
  for (let waits = 0, sweeps = 0; unsettled(left) && waits < SETTLE_WAITS && sweeps < SETTLE_SWEEPS;) {
    try {
      if (left.sats > 0n) {
        swept = { ...swept, balanceSats: (await sweep(from, to, { sats: left.sats, tokens: [] }, { log })).balanceSats };
        movedSats += left.sats;
        sweeps++;
        waits = 0;
      } else {
        await new Promise((r) => setTimeout(r, waitMs));
        waits++;
      }
      left = await readLeft();
    } catch (err) {
      log(`the rest stays in the old wallet for --check-old --sweep (${err?.message ?? err})`);
      break;
    }
  }
  return { swept, movedSats, left };
}
const stillThere = (left) => (unsettled(left)
  ? `${left.sats + left.lockedSats + left.incomingSats} sats (${[left.lockedSats > 0n && `${left.lockedSats} locked`, left.incomingSats > 0n && `${left.incomingSats} incoming`, left.sats > 0n && `${left.sats} spendable`].filter(Boolean).join(", ")})`
  : null);

// --- Stage 1 (before anything moves): both seeds on disk. The state file
// goes first, exclusive: it is the lock against a second rotation, and it
// lets --resume tell how far staging got. Written last, a crash after `.next`
// left a rotation that neither --execute nor --resume would touch (review
// 2026-11-09, ROT-4). It holds the two identities and the start time; the
// paths are derived from them, never read back (ROT-7).
export async function stageSeeds({ seedPath, passphrase, oldPayload, newMnemonic, oldKey, newHoldings, now = new Date() }) {
  const state = {
    schema: "sparkbtcbot.rotation.v1", state: "staging", startedAt: now.toISOString(),
    old: { identityPublicKey: oldKey }, new: { identityPublicKey: newHoldings.identityPublicKey, sparkAddress: newHoldings.address },
  };
  try {
    await atomicWriteFile(statePath(seedPath), JSON.stringify(state, null, 2) + "\n", { mode: 0o600, exclusive: true });
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    throw new Refusal(`Another rotation is under way or was interrupted (${statePath(seedPath)}). Run \`sparkbtcbot rotate --resume\`. Nothing changed.`);
  }
  const run = withPaths(seedPath, state);
  await mkdir(run.retiredDir, { recursive: true, mode: 0o700 });
  await keepRetiredSeed({ retiredDir: run.retiredDir, passphrase, payload: oldPayload });
  await saveEncryptedMnemonic({ mnemonic: newMnemonic, passphrase, path: run.nextPath, policy: oldPayload.policy }); // exclusive
  state.state = "staged";
  await atomicWriteFile(statePath(seedPath), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  return { ...run, state: "staged" };
}

const withPaths = (seedPath, state) => ({ ...state, nextPath: `${seedPath}.next`, retiredDir: retiredDirFor(seedPath, state.startedAt, state.old.identityPublicKey) });

// The old seed's copy in its retired dir: written exclusive, or kept when a
// copy with the same words is there already (left by a run cut off while
// staging, which used to block every rotation that UTC day). A copy holding
// other words is never replaced.
async function keepRetiredSeed({ retiredDir, passphrase, payload }) {
  const path = join(retiredDir, "seed.enc");
  if (await exists(path)) {
    if ((await loadSeedPayload({ passphrase, path })).mnemonic === payload.mnemonic) return;
    throw new Refusal(`${path} already holds a different seed, so this wallet's copy can't go there. Nothing moved; tell the user.`);
  }
  await saveEncryptedMnemonic({ mnemonic: payload.mnemonic, passphrase, path, policy: payload.policy });
}

// --- Stage 2 (after a verified sweep): the new seed in place, the old wallet's
// files beside its retired seed, the ledger under the new key.
// A sealed ledger is signed with a key from the mnemonic. Read its window
// BEFORE anything moves (a ledger that fails verification stops the rotation
// there), so the commit can sign the same spends again under the new key: the
// budget doesn't restart because the seed did. null when nothing is sealed.
// --resume passes the new seed's words too: a commit cut off after the
// re-sign left the ledger under the new key.
export async function readSealedWindow(oldPayload, ledgerPath, newMnemonic = null) {
  if (oldPayload.policy?.dailyBudgetSats == null) return null;
  const read = async (mnemonic) => (await createSpendLedger({
    path: ledgerPath, budgetSats: oldPayload.policy.dailyBudgetSats, hmacKey: deriveLedgerHmacKey(mnemonic), bound: true,
  }).status()).entries;
  try {
    return await read(oldPayload.mnemonic);
  } catch (err) {
    if (err?.code !== "SPEND_LEDGER_BAD_SIGNATURE" || !newMnemonic) throw err;
    return await read(newMnemonic);
  }
}

export async function commitRotation({ seedPath, ledgerPath, vaultPath, state, sealedEntries, passphrase, oldMnemonic, newMnemonic, oldHoldings, swept, now = new Date() }) {
  // The words seed.enc is about to lose must be on disk elsewhere first.
  if ((await loadSeedPayload({ passphrase, path: join(state.retiredDir, "seed.enc") })).mnemonic !== oldMnemonic) {
    throw new Refusal(`${join(state.retiredDir, "seed.enc")} doesn't hold the seed being retired, so ${seedPath} is left as it is. Run \`sparkbtcbot rotate --resume\`; tell the user if it says the same.`);
  }
  // Re-read now, under the ledger's lock, rather than re-signing the window
  // read at the start; an old-key spend recorded meanwhile stays counted.
  if (sealedEntries) {
    await rekeyLedger({ path: ledgerPath, fromKeys: [deriveLedgerHmacKey(oldMnemonic), deriveLedgerHmacKey(newMnemonic)], toKey: deriveLedgerHmacKey(newMnemonic), keep: sealedEntries });
  }
  await rename(state.nextPath, seedPath); // atomic: seed.enc is old or new, never partial
  await fileOldVault(vaultPath, state.retiredDir);
  return await writeManifest(seedPath, state, oldHoldings, swept, now);
}

// The old wallet's backup goes beside its retired seed, unless a copy is
// there already.
async function fileOldVault(vaultPath, retiredDir) {
  const dest = join(retiredDir, "leaf-vault.json");
  if (!(await exists(vaultPath)) || (await exists(dest))) return;
  try { await rename(vaultPath, dest); } catch { await copyFile(vaultPath, dest); await unlink(vaultPath); }
}

async function writeManifest(seedPath, state, oldHoldings, swept, now) {
  const manifest = {
    schema: "sparkbtcbot.retired-seed.v1",
    retiredAt: now.toISOString(),
    identityPublicKey: oldHoldings.identityPublicKey,
    sparkAddress: oldHoldings.address,
    staticDepositAddress: oldHoldings.depositAddress,
    sweptSats: swept.sats == null ? null : String(swept.sats),
    sweptTokens: swept.tokens.map((t) => ({ tokenIdentifier: t.tokenIdentifier, amount: String(t.amount), ticker: t.ticker })),
    tokensLeftBehind: (swept.leftBehind ?? []).map((t) => ({ tokenIdentifier: t.tokenIdentifier, amount: String(t.amount), ticker: t.ticker, reason: t.reason })),
    successor: state.new,
    ...(swept.note ? { note: swept.note } : {}),
  };
  await atomicWriteFile(join(state.retiredDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { mode: 0o600 });
  await unlink(statePath(seedPath)).catch(() => {});
  return manifest;
}

const fmt = (h) => [
  `  address        ${h.address}`,
  `  sats           ${h.sats} spendable${h.lockedSats > 0n ? `, ${h.lockedSats} locked` : ""}${h.incomingSats > 0n ? `, ${h.incomingSats} incoming` : ""}`,
  ...h.tokens.map((t) => `  token          ${t.amount} ${t.ticker} (${t.tokenIdentifier.slice(0, 24)}…)`),
  ...(h.tokensPending ?? []).map((t) => `  token          ${t.amount} ${t.ticker} (${t.tokenIdentifier.slice(0, 24)}…) not spendable yet`),
  ...h.pendingDeposits.map((d) => `  L1 deposit     ${d.txid.slice(0, 16)}…:${d.vout} waiting to be claimed${d.type === "single-use" ? " (single-use address: the operators don't claim these now)" : ""}`),
  ...(h.depositsUnknown ? [`  L1 deposits    couldn't be checked (${h.depositsUnknown}): run this again`] : []),
].join("\n");

function leftBehind(h) {
  const notes = [];
  if (h.lockedSats > 0n) notes.push(`${h.lockedSats} sats locked: a send still in flight may yet take them, or they come back to the old wallet`);
  if (h.incomingSats > 0n) notes.push(`${h.incomingSats} sats incoming stay with the old wallet until they settle`);
  if (h.pendingDeposits.length) notes.push(`${h.pendingDeposits.length} L1 deposit(s) waiting to be claimed stay at the old deposit address`);
  if (h.depositsUnknown) notes.push(`L1 deposits couldn't be checked (${h.depositsUnknown}), so any there stay at the old address`);
  if (h.tokensPending?.length) notes.push(`${h.tokensPending.length} token balance(s) not spendable yet stay with the old wallet`);
  return notes;
}

// Payments made before a rotation show only in the old wallet's history, and
// every check-first rule says getTransfers(), which reads the wallet the agent
// opened: after a rotation it answered "not paid" for a payment that left
// (review 2026-11-09, ROT-3). The plan, AFTER and --check-old say where to look.
const HISTORY_NOTE =
  "Payments made from this wallet stay in its own history: after the rotation, getTransfers()\n" +
  "reads the new wallet and won't list them; `rotate --check-old` does. If an earlier payment\n" +
  "ended in PAYMENT_COMMITTED (outcome unknown), check it before rotating.\n";

// The retired wallet's latest sats transfers, newest first, for check-first.
async function recentTransfers(wallet, limit = 10) {
  try {
    const { transfers = [] } = (await wallet.getTransfers(limit, 0)) ?? {};
    return transfers.map((t) => {
      const sent = t.transferDirection === "OUTGOING";
      const sats = (sent ? t.valueSentByWallet : t.valueReceivedByWallet) || t.totalValue;
      const peer = sent ? t.receivers?.[0]?.identityPublicKey ?? t.receiverIdentityPublicKey : t.senders?.[0]?.identityPublicKey ?? t.senderIdentityPublicKey;
      const when = t.createdTime instanceof Date ? t.createdTime.toISOString().slice(0, 16).replace("T", " ") : "";
      return `    ${when}  ${sent ? "sent" : "received"} ${sats} sats ${sent ? "to" : "from"} ${String(peer ?? "?").slice(0, 16)}…  ${t.type ?? ""} ${t.status ?? ""}  id ${t.id}`;
    });
  } catch (err) {
    return [`    (its transfers couldn't be read: ${err?.code ?? err?.message ?? err})`];
  }
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
  "  - Payments made before the rotation show only in the OLD wallet's history: getTransfers()\n" +
  "    now reads this one. Before paying again for anything whose outcome was unknown, run\n" +
  "    `sparkbtcbot rotate --check-old`, which lists the old wallet's recent transfers.\n" +
  "  - The spending limits are unchanged. A running agent process still holds the old\n" +
  "    wallet: restart it.\n";

// --- The three runs. Each returns an exit code and writes its own report.
export async function runRotate({ execute = false, deps = defaultDeps, out = (s) => stdout.write(s), log = (s) => stderr.write(`  ${s}\n`), environment = env, settleWaitMs = SETTLE_WAIT_MS } = {}) {
  const network = environment.SPARK_NETWORK || "MAINNET";
  const seedPath = environment.SPARK_SEED_PATH || DEFAULT_SEED_PATH;
  if (await exists(`${seedPath}.next`) || await exists(statePath(seedPath))) {
    throw new Refusal(`A rotation was interrupted (${await exists(`${seedPath}.next`) ? `${seedPath}.next, the new wallet, is on disk` : statePath(seedPath)}). Run \`sparkbtcbot rotate --resume\` to finish it. Nothing changed.`);
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
    // Only --execute asks for the deposit address: asking can create one at
    // the operators, and the dry run says nothing was written (ROT-10).
    const old = await readHoldings(oldWallet, { depositAddress: execute });
    out(`Rotation plan (${network}):\nThis wallet, to be retired:\n${fmt(old)}\nEverything spendable moves to a freshly generated wallet.\n`);
    for (const n of leftBehind(old)) out(`Left behind: ${n}; \`rotate --check-old\` picks them up later.\n`);
    out(HISTORY_NOTE);
    if (!execute) {
      out("\nDry run: nothing moved, nothing written. Show the user this plan; run `sparkbtcbot rotate --execute` only on their yes.\n");
      return 0;
    }
    fresh = await deps.generateWallet(network);
    const neu = await readHoldings(fresh.wallet);
    log(`new wallet ${neu.address}`);
    const state = await stageSeeds({ seedPath, passphrase, oldPayload, newMnemonic: fresh.mnemonic, oldKey: old.identityPublicKey, newHoldings: neu });
    log(`old seed kept at ${join(state.retiredDir, "seed.enc")}; new seed staged at ${state.nextPath}`);
    return await finish({ seedPath, network, environment, state, sealedEntries, passphrase, oldMnemonic: oldPayload.mnemonic, newMnemonic: fresh.mnemonic, oldWallet, newWallet: fresh.wallet, old, out, log, settleWaitMs });
  } finally {
    await oldWallet.cleanup?.().catch?.(() => {});
    await fresh?.wallet.cleanup?.().catch?.(() => {});
  }
}

async function finish({ seedPath, network, environment, state, sealedEntries, passphrase, oldMnemonic, newMnemonic, oldWallet, newWallet, old, out, log, settleWaitMs }) {
  if (privacyPreferenceFromEnv(environment)) {
    try { await ensureWalletPrivacy(newWallet); log("privacy on for the new wallet"); }
    catch (err) { log(`privacy could not be turned on for the new wallet yet (${err?.message ?? err}); its next boot retries`); }
  }
  let swept;
  let movedSats;
  let left;
  try {
    // What the old wallet holds now, not at the plan, and then whatever
    // becomes spendable while this runs (review 2026-11-09, ROT-8; sweepAll).
    const now = await readHoldings(oldWallet);
    ({ swept, movedSats, left } = await sweepAll(oldWallet, newWallet, now, { log, waitMs: settleWaitMs }));
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
    state, sealedEntries, passphrase, oldMnemonic, newMnemonic, oldHoldings: old,
    swept: { sats: movedSats, tokens: swept.sent.tokens, leftBehind: swept.sent.leftBehind },
  });
  if (environment.SPARK_LEAF_VAULT !== "off") {
    try {
      const snap = await snapshotLeafVault(newWallet, { path: vaultPath, networkLabel: network });
      log(snap?.leafCount ? `backup written for the new wallet (${snap.leafCount} leaves)` : "the new wallet holds nothing to back up yet");
    } catch (err) {
      log(`the new wallet's backup failed (${err?.message ?? err}); the next SparkAgent boot writes it`);
    }
  }
  const behind = swept.sent.leftBehind.map((t) => `Left behind in the old wallet: ${t.amount} ${t.ticker} (${t.tokenIdentifier.slice(0, 24)}…): ${t.reason}. \`rotate --check-old --sweep\` tries again.\n`).join("") +
    (stillThere(left) ? `Still in the old wallet: ${stillThere(left)}. They couldn't be sent yet; run \`sparkbtcbot rotate --check-old --sweep\` in a minute to move them.\n` : "");
  out(`\nRotated. ${seedPath} is now the new wallet: ${swept.toAddress}, holding ${swept.balanceSats} sats.\nThe old seed is kept at ${join(state.retiredDir, "seed.enc")}.\n${behind}\n${AFTER}`);
  return 0;
}

export async function runResume({ deps = defaultDeps, out = (s) => stdout.write(s), log = (s) => stderr.write(`  ${s}\n`), environment = env, settleWaitMs = SETTLE_WAIT_MS } = {}) {
  const network = environment.SPARK_NETWORK || "MAINNET";
  const seedPath = environment.SPARK_SEED_PATH || DEFAULT_SEED_PATH;
  let state;
  try {
    state = JSON.parse(await readFile(statePath(seedPath), "utf8"));
  } catch {
    throw new Refusal(`No interrupted rotation to finish (${statePath(seedPath)} isn't there). Nothing changed.`);
  }
  const KEY = /^0[23][0-9a-f]{64}$/;
  if (!KEY.test(state?.old?.identityPublicKey ?? "") || !KEY.test(state?.new?.identityPublicKey ?? "") || !/^\d{4}-\d{2}-\d{2}T/.test(state?.startedAt ?? "")) {
    throw new Refusal(`${statePath(seedPath)} isn't a rotation state this command wrote. Nothing changed; tell the user.`);
  }
  const run = withPaths(seedPath, state);
  const ledgerPath = environment.SPARK_SPEND_LEDGER_PATH || DEFAULT_SPEND_LEDGER_PATH;
  const passphrase = takePassphrase(environment);
  const seedPayload = await loadSeedPayload({ passphrase, path: seedPath });
  const seedWallet = await deps.openWallet(seedPayload.mnemonic, network);
  let newWallet = null;
  try {
    const seedKey = await seedWallet.getIdentityPublicKey();
    if (!(await exists(run.nextPath))) {
      // Cut off after the rename: seed.enc is the new wallet; only the
      // bookkeeping is left. It used to refuse, and --check-old couldn't see
      // the retired wallet without its manifest.
      if (seedKey === state.new.identityPublicKey) return await completeCommit({ seedPath, network, environment, deps, passphrase, run, newWallet: seedWallet, out, log });
      // Cut off while staging: nothing moved (the sweep starts after it).
      if (seedKey === state.old.identityPublicKey) {
        await unlink(statePath(seedPath));
        out("The interrupted rotation stopped while writing the seeds, before anything moved. It is cleared, and nothing moved. On the user's say-so, run `sparkbtcbot rotate` for a fresh plan.\n");
        return 1;
      }
      throw new Refusal(`${run.nextPath} is missing and ${seedPath} is neither wallet this rotation names, so it can't be finished from here. Nothing changed; tell the user.`);
    }
    const newPayload = await loadSeedPayload({ passphrase, path: run.nextPath });
    newWallet = await deps.openWallet(newPayload.mnemonic, network);
    const nextKey = await newWallet.getIdentityPublicKey();
    // Both must be the wallets this rotation staged, and the destination
    // never one already retired. Unchecked, a stale run's state or a planted
    // one moved the money into a retired (leaked) seed and put that seed back
    // in seed.enc (review 2026-11-09, ROT-5 and ROT-7).
    if (seedKey !== state.old.identityPublicKey || nextKey !== state.new.identityPublicKey) {
      throw new Refusal(`${seedPath} and ${run.nextPath} aren't the two wallets this rotation staged, so finishing it could send the money to the wrong one. Nothing changed; tell the user.`);
    }
    if ((await retiredKeys(seedPath)).has(nextKey)) {
      throw new Refusal(`${run.nextPath} is a wallet already retired, so it can't become seed.enc again. Nothing changed; tell the user.`);
    }
    // A spending policy sealed (or changed) since staging goes with the new seed.
    if (JSON.stringify(seedPayload.policy ?? null) !== JSON.stringify(newPayload.policy ?? null)) {
      await saveEncryptedMnemonic({ mnemonic: newPayload.mnemonic, passphrase, path: run.nextPath, policy: seedPayload.policy, allowOverwrite: true });
      log("the new seed now carries the spending policy set since the rotation started");
    }
    await mkdir(run.retiredDir, { recursive: true, mode: 0o700 });
    await keepRetiredSeed({ retiredDir: run.retiredDir, passphrase, payload: seedPayload });
    const sealedEntries = await readSealedWindow(seedPayload, ledgerPath, newPayload.mnemonic);
    const old = await readHoldings(seedWallet, { depositAddress: true });
    out(`Finishing the rotation (${network}). Still in the old wallet:\n${fmt(old)}\n`);
    return await finish({
      seedPath, network, environment, state: run, sealedEntries, passphrase, oldMnemonic: seedPayload.mnemonic, newMnemonic: newPayload.mnemonic,
      oldWallet: seedWallet, newWallet, old, out, log, settleWaitMs,
    });
  } finally {
    await seedWallet.cleanup?.().catch?.(() => {});
    await newWallet?.cleanup?.().catch?.(() => {});
  }
}

// The identities in the retired wallets' manifests.
async function retiredKeys(seedPath) {
  const keys = new Set();
  for (const name of await readdir(retiredRoot(seedPath)).catch(() => [])) {
    try { keys.add(JSON.parse(await readFile(join(retiredRoot(seedPath), name, "manifest.json"), "utf8")).identityPublicKey); } catch {}
  }
  return keys;
}

// The rename happened, the rest didn't: file the old backup, write the
// manifest, clear the state. What the sweep moved isn't known any more.
async function completeCommit({ seedPath, network, environment, deps, passphrase, run, newWallet, out, log }) {
  const oldPayload = await loadSeedPayload({ passphrase, path: join(run.retiredDir, "seed.enc") });
  const oldWallet = await deps.openWallet(oldPayload.mnemonic, network);
  try {
    const old = await readHoldings(oldWallet, { depositAddress: true });
    if (old.identityPublicKey !== run.old.identityPublicKey) {
      throw new Refusal(`${join(run.retiredDir, "seed.enc")} isn't the wallet this rotation retired. Nothing changed; tell the user.`);
    }
    await fileOldVault(environment.SPARK_LEAF_VAULT_PATH || defaultVaultPath(), run.retiredDir);
    if (!(await exists(join(run.retiredDir, "manifest.json")))) {
      await writeManifest(seedPath, run, old, { sats: null, tokens: [], note: "completed by --resume after an interruption; the swept amounts weren't recorded" }, new Date());
    } else {
      await unlink(statePath(seedPath)).catch(() => {});
    }
    const neu = await readHoldings(newWallet);
    log("the money had moved and seed.enc was already the new wallet; the last bookkeeping is done now");
    out(`\nRotated. ${seedPath} is the new wallet: ${neu.address}, holding ${neu.sats} sats.\nThe old seed is kept at ${join(run.retiredDir, "seed.enc")}.\nStill in the old wallet:\n${fmt(old)}\n\n${AFTER}`);
    return 0;
  } finally {
    await oldWallet.cleanup?.().catch?.(() => {});
  }
}

// The retired wallets: open each, report what it holds, and with `sweep`
// claim its deposits and move it all to the wallet in seed.enc.
export async function runCheckOld({ sweepNow = false, deps = defaultDeps, out = (s) => stdout.write(s), log = (s) => stderr.write(`  ${s}\n`), environment = env, makeAgent, settleWaitMs = SETTLE_WAIT_MS } = {}) {
  const network = environment.SPARK_NETWORK || "MAINNET";
  const seedPath = environment.SPARK_SEED_PATH || DEFAULT_SEED_PATH;
  // Every retired seed, manifest or not: a rotation cut off before its
  // manifest still retired that wallet (review 2026-11-09, ROT-4). A copy
  // holding seed.enc's own words is a rotation not yet committed: skipped.
  const dirs = [];
  for (const name of await readdir(retiredRoot(seedPath)).catch(() => [])) {
    const dir = join(retiredRoot(seedPath), name);
    if (await exists(join(dir, "seed.enc"))) dirs.push(dir);
  }
  if (!dirs.length) { out("No retired wallets to check.\n"); return 0; }
  const passphrase = takePassphrase(environment);
  const cur = await loadSeedPayload({ passphrase, path: seedPath });
  let current = null;
  let seedContext;
  let anything = false;
  let checked = 0;
  let unopened = 0;
  try {
    if (sweepNow) {
      current = await deps.openWallet(cur.mnemonic, network);
      // The deposit claim's agent counts against the CURRENT seed's ledger,
      // which a rotation re-signed under the current key: without this a
      // sealed install threw POLICY_NOT_LOADED out of the whole run, leaving
      // this wallet's sats and every retired wallet after it where the leaked
      // words reach them (review 2026-11-09, ROT-2).
      seedContext = cur.policy ? { policy: cur.policy, ledgerHmacKey: deriveLedgerHmacKey(cur.mnemonic) } : null;
    }
    for (const dir of dirs) {
      let wallet;
      try {
        const payload = await loadSeedPayload({ passphrase, path: join(dir, "seed.enc") });
        if (payload.mnemonic === cur.mnemonic) continue;
        checked++;
        wallet = await deps.openWallet(payload.mnemonic, network); // opening it claims transfers that arrived
      } catch (err) {
        unopened++;
        out(`Retired wallet ${dir}: couldn't open it (${err?.code ?? err?.message ?? err}); the others are still checked.\n`);
        continue;
      }
      try {
        let h = await readHoldings(wallet);
        const has = h.sats > 0n || h.tokens.length || h.tokensPending.length || h.pendingDeposits.length || h.depositsUnknown || h.lockedSats > 0n || h.incomingSats > 0n;
        out(`Retired wallet ${dir}:\n${fmt(h)}\n`);
        const recent = await recentTransfers(wallet);
        out(recent.length
          ? `  recent transfers, newest first (sats only; a payment made before the rotation shows here, not in getTransfers()):\n${recent.join("\n")}\n`
          : "  no transfers\n");
        if (!has) continue;
        anything = true;
        if (!sweepNow) continue;
        if (h.pendingDeposits.length) {
          // The claim goes through SparkAgent for its fee caps (the user's limits
          // apply too). Its backup is off here: it would overwrite this wallet's.
          let agent = null;
          try { agent = await (makeAgent ?? defaultMakeAgent)(wallet, network, environment, seedContext); }
          catch (err) { out(`  Couldn't set up the deposit claim (${err?.code ?? err?.message ?? err}); the deposits stay there, check again later.\n`); }
          for (const d of agent ? h.pendingDeposits : []) {
            try { await agent.claimDeposit({ txid: d.txid, vout: d.vout }); log(`claimed ${d.txid.slice(0, 16)}…:${d.vout}`); }
            catch (err) { out(`  Couldn't claim ${d.txid.slice(0, 16)}…:${d.vout} now (${err?.code ?? err?.message ?? err}); it stays there, check again later.\n`); }
          }
          h = await readHoldings(wallet);
        }
        if (unsettled(h) || h.tokens.length) {
          try {
            const { swept: s, movedSats, left } = await sweepAll(wallet, current, h, { log, waitMs: settleWaitMs });
            if (movedSats > 0n || s.sent.tokens.length) out(`  Moved ${movedSats} sats${s.sent.tokens.length ? ` and ${s.sent.tokens.length} token balance(s)` : ""} to this wallet (${s.toAddress}).\n`);
            for (const t of s.sent.leftBehind) out(`  Still in the old wallet: ${t.amount} ${t.ticker}: ${t.reason}.\n`);
            if (stillThere(left)) out(`  Still in the old wallet: ${stillThere(left)}. They couldn't be sent yet; run --check-old --sweep again in a minute.\n`);
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
  if (!checked) out("No retired wallets to check.\n");
  else if (!anything && !unopened) out("Nothing has arrived at the retired wallets.\n");
  else if (anything && !sweepNow) out("\nTell the user what arrived; `sparkbtcbot rotate --check-old --sweep` moves it to this wallet, on their say-so.\n");
  return unopened ? 1 : 0;
}

async function defaultMakeAgent(wallet, network, environment, seedContext) {
  environment.SPARK_LEAF_VAULT = "off"; // this process only: the retired wallet's backup must not replace this one's
  const { SparkAgent } = await import("./spark-agent.js");
  return new SparkAgent(wallet, network, { seedContext });
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
    stderr.write(`rotate: ${err?.code ? `[${err.code}${err.retryable ? `, retry: ${err.retryable}` : ""}] ` : ""}${err?.message ?? err}\n${err?.nextStep ? `Next: ${err.nextStep}\n` : ""}`);
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
