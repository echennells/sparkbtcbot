#!/usr/bin/env node
// Bind, change, or remove the SEED-BOUND spending policy (daily budget) — the
// deliberate ceremony for "change the cap on my agent's spending".
//
// Why a ceremony: the policy lives INSIDE the encrypted seed payload (v2
// seed.enc), so it inherits the seed's protections — reading it needs the
// passphrase, tampering fails the GCM tag, deleting it deletes the wallet.
// Changing it therefore means decrypt -> modify -> re-encrypt -> atomic swap,
// gated by a real terminal and an explicit confirmation. That friction is
// intentional. A bound budget needs a spend ledger SIGNED with this seed's
// key: one that verifies is kept, so spends already in the window count
// against the new budget; an unsigned env-budget ledger is signed as it
// stands; a missing one is created. One that fails verification or can't be
// read stops the ceremony with nothing changed. This ceremony never empties
// the window — that is `reset-ledger`. (It used to write an empty ledger on
// every change, so tightening 50,000 to 20,000 after 30,000 was spent freed
// 20,000 more for the day.)
//
// TTY-gated on BOTH ends like reveal-mnemonic: an agent must not be able to
// loosen the operator's sealed policy by piping answers into this script. The
// gate is a backstop, not a guarantee — the honest statement is that an agent
// with the passphrase can defeat seed-binding by EXECUTING CODE; this CLI just
// refuses to be the convenient path.
import "dotenv/config";
import { stdin, stdout, stderr, exit, env } from "node:process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { loadSeedPayload, saveEncryptedMnemonic, deriveLedgerHmacKey, DEFAULT_SEED_PATH, MIN_PASSPHRASE_CHARS } from "../../../lib/encrypted-seed.js";
import { initSignedLedger, inspectLedgerForBinding, DEFAULT_SPEND_LEDGER_PATH } from "../../../lib/spend-ledger.js";
import { promptStderr } from "./prompt.js";

const USAGE =
  "Usage: sparkbtcbot set-policy\n\n" +
  "Interactively bind, change, or remove the seed-bound daily spending budget.\n" +
  "Decrypts seed.enc (prompts for the passphrase — never read from .env), shows\n" +
  "the current policy,\n" +
  "asks for the new budget ('none' removes the policy), confirms, then\n" +
  "re-encrypts the seed atomically. Spends already in the window keep\n" +
  "counting against a changed budget (reset-ledger empties it). Takes no arguments; refuses\n" +
  "to run without a real interactive terminal — this is an operator ceremony,\n" +
  "not an agent command.\n\nEnv: SPARK_SEED_PATH, SPARK_SPEND_LEDGER_PATH.\n";

export async function main() {
  // Arg gate FIRST, then the TTY gate — inside main() so IMPORTING this module
  // stays inert (the `sparkbtcbot` dispatcher imports, then calls main once).
  {
    const args = process.argv.slice(2);
    if (args.includes("--help") || args.includes("-h")) { stdout.write(USAGE); exit(0); }
    if (args.length) { stderr.write(`set-policy: unknown argument(s): ${args.join(" ")}\n\n` + USAGE); exit(2); }
  }

  if (!stdout.isTTY || !stdin.isTTY) {
    stderr.write(
      "set-policy: refusing to run without a real interactive terminal on both stdin and stdout.\n" +
      "Changing the seed-bound spending policy is an operator ceremony — run it yourself; an agent must not.\n",
    );
    exit(3);
  }

  const seedPath = env.SPARK_SEED_PATH || DEFAULT_SEED_PATH;
  const ledgerPath = env.SPARK_SPEND_LEDGER_PATH || DEFAULT_SPEND_LEDGER_PATH;

  // ALWAYS prompt — deliberately ignoring SPARK_PASSPHRASE/.env. These
  // ceremonies exist to prove an OPERATOR is present; in the documented
  // deployment the passphrase lives in .env right next to the wallet, so
  // accepting it from the environment would reduce "requires the passphrase"
  // to "requires a PTY", which an agent can allocate.
  const passphrase = await promptStderr(`Passphrase for ${seedPath} (typed, not read from .env): `, { hidden: true });
  if (!passphrase || passphrase.length < MIN_PASSPHRASE_CHARS) {
    stderr.write(`set-policy: passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters.\n`);
    exit(1);
  }

  const payload = await loadSeedPayload({ passphrase, path: seedPath });
  const current = payload.policy?.dailyBudgetSats;
  stderr.write(current != null
    ? `Current seed-bound daily budget: ${current} sats.\n`
    : "No seed-bound policy (v1 seed — budget, if any, comes from SPARK_DAILY_BUDGET_SATS).\n");

  const answer = (await promptStderr("New daily budget in sats ('none' to remove the bound policy, empty to abort): ")).trim();
  if (!answer) { stderr.write("Aborted — nothing changed.\n"); exit(0); }

  let policy = null;
  if (answer.toLowerCase() !== "none") {
    const sats = Number(answer);
    if (!Number.isSafeInteger(sats) || sats <= 0) {
      stderr.write(`set-policy: "${answer}" is not a positive integer number of sats.\n`);
      exit(1);
    }
    policy = { dailyBudgetSats: sats };
  }

  // A bound budget needs a ledger signed with this seed's key. Look BEFORE
  // confirming, so a ledger that can't be kept stops the ceremony with
  // nothing changed (replacing it would empty the window, which is
  // reset-ledger's job).
  const hmacKey = deriveLedgerHmacKey(payload.mnemonic);
  let ledger = null;
  if (policy) {
    try {
      ledger = await inspectLedgerForBinding({ path: ledgerPath, hmacKey });
    } catch (err) {
      stderr.write(
        `set-policy: ${err.message}\nNothing changed. ` +
          (err.code === "SPEND_LEDGER_BAD_SIGNATURE" || err.code === "SPEND_LEDGER_UNREADABLE"
            ? "Start a fresh window deliberately with `sparkbtcbot reset-ledger`, then run set-policy again.\n"
            : "\n"),
      );
      exit(1);
    }
    // A seed that ALREADY carries a sealed budget had its ledger signed when it
    // was bound. Missing or unsigned now means it was deleted or replaced, and
    // signing what is there would let whoever replaced it choose the window
    // (the running agent refuses that same file as tampered). Only a first
    // bind adopts an unsigned env-budget ledger or creates a missing one.
    if (current != null && ledger.state !== "signed") {
      stderr.write(
        `set-policy: this seed already has a sealed budget, but the spend ledger at ${ledgerPath} is ` +
          `${ledger.state === "missing" ? "missing" : "unsigned"} — it was deleted or replaced.\nNothing changed. ` +
          "Start a fresh window deliberately with `sparkbtcbot reset-ledger`, then run set-policy again.\n",
      );
      exit(1);
    }
  }
  const n = ledger?.entries.length ?? 0;
  const ledgerNote = !ledger
    ? ""
    : ledger.state === "signed"
      ? ", keeping the signed spend ledger (spends already in the window count against the new budget)"
      : ledger.state === "missing"
        ? ` and creating a signed spend ledger at ${ledgerPath}`
        : ` and signing the existing spend ledger as it stands (${n} entr${n === 1 ? "y" : "ies"}; spends already in the window count)`;
  const summary = policy
    ? `BIND daily budget = ${policy.dailyBudgetSats} sats into the encrypted seed (v2)${ledgerNote}`
    : "REMOVE the seed-bound policy (seed returns to v1; env-var budget semantics apply)";
  // A running agent keeps the policy it read at boot: one started before the
  // first bind writes the new signed ledger back unsigned on its next spend,
  // and the bound boot then refuses it (ToB review of 375e6fb..HEAD).
  const confirm = (await promptStderr(
    `About to ${summary}.\n` +
      `Stop every running agent that uses this wallet first, and start it again afterwards: ` +
      `one still running keeps its old policy and can overwrite the new spend ledger.\n` +
      `Type 'yes' to proceed: `,
  )).trim().toLowerCase();
  if (confirm !== "yes") { stderr.write("Aborted — nothing changed.\n"); exit(0); }

  // Re-read BEFORE touching the seed: a running agent may have appended to the
  // unsigned ledger while the operator was typing, and a file that no longer
  // validates must stop the ceremony with nothing changed, not after the seed
  // is already rewritten.
  let latest = ledger;
  if (policy && ledger.state !== "signed") {
    try {
      latest = await inspectLedgerForBinding({ path: ledgerPath, hmacKey });
    } catch (err) {
      stderr.write(`set-policy: ${err.message}\nNothing changed.\n`);
      exit(1);
    }
  }

  // Atomic swap: the new blob replaces seed.enc in one rename — a crash leaves
  // either the old seed or the new one, never a partial file.
  await saveEncryptedMnemonic({ mnemonic: payload.mnemonic, passphrase, path: seedPath, policy, allowOverwrite: true });
  if (policy) {
    const carried = latest.entries.length;
    if (latest.state !== "signed") await initSignedLedger({ path: ledgerPath, hmacKey, entries: latest.entries });
    stderr.write(`Bound. seed.enc rewritten (v2, budget ${policy.dailyBudgetSats} sats); signed spend ledger at ${ledgerPath} (${carried} entr${carried === 1 ? "y" : "ies"} kept).\n`);
    stderr.write("Deleting or editing the ledger now fails closed; empty the window deliberately with `sparkbtcbot reset-ledger`.\n");
  } else {
    stderr.write("Removed. seed.enc rewritten (v1, no bound policy). Env-var budget (if set) applies again.\n");
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
    stderr.write(`set-policy: ${e?.message ?? e}\n`);
    exit(1);
  });
}
