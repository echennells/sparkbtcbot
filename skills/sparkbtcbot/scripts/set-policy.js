#!/usr/bin/env node
// Bind, change, or remove the SEED-BOUND spending policy (daily budget) — the
// deliberate ceremony for "change the cap on my agent's spending".
//
// Why a ceremony: the policy lives INSIDE the encrypted seed payload (v2
// seed.enc), so it inherits the seed's protections — reading it needs the
// passphrase, tampering fails the GCM tag, deleting it deletes the wallet.
// Changing it therefore means decrypt -> modify -> re-encrypt -> atomic swap,
// gated by a real terminal and an explicit confirmation. That friction is
// intentional. Binding (or changing) a policy also writes a fresh SIGNED spend
// ledger, since the budget window restarts under the new policy.
//
// TTY-gated on BOTH ends like reveal-mnemonic: an agent must not be able to
// loosen the operator's sealed policy by piping answers into this script. The
// gate is a backstop, not a guarantee — the honest statement is that an agent
// with the passphrase can defeat seed-binding by EXECUTING CODE; this CLI just
// refuses to be the convenient path.
import "dotenv/config";
import { stdin, stdout, stderr, exit, env } from "node:process";
import { loadSeedPayload, saveEncryptedMnemonic, deriveLedgerHmacKey, DEFAULT_SEED_PATH, MIN_PASSPHRASE_CHARS } from "../../../lib/encrypted-seed.js";
import { initSignedLedger, DEFAULT_SPEND_LEDGER_PATH } from "../../../lib/spend-ledger.js";
import { promptStderr } from "./prompt.js";

const USAGE =
  "Usage: sparkbtcbot-set-policy\n\n" +
  "Interactively bind, change, or remove the seed-bound daily spending budget.\n" +
  "Decrypts seed.enc (SPARK_PASSPHRASE or prompt), shows the current policy,\n" +
  "asks for the new budget ('none' removes the policy), confirms, then\n" +
  "re-encrypts the seed atomically. Binding/changing a budget also writes a\n" +
  "fresh signed spend ledger (the window restarts). Takes no arguments; refuses\n" +
  "to run without a real interactive terminal — this is an operator ceremony,\n" +
  "not an agent command.\n\nEnv: SPARK_PASSPHRASE, SPARK_SEED_PATH, SPARK_SPEND_LEDGER_PATH.\n";

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

async function main() {
  const seedPath = env.SPARK_SEED_PATH || DEFAULT_SEED_PATH;
  const ledgerPath = env.SPARK_SPEND_LEDGER_PATH || DEFAULT_SPEND_LEDGER_PATH;

  let passphrase = env.SPARK_PASSPHRASE;
  if (!passphrase) passphrase = await promptStderr(`Passphrase for ${seedPath}: `, { hidden: true });
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

  const summary = policy
    ? `BIND daily budget = ${policy.dailyBudgetSats} sats into the encrypted seed (v2) and reset the signed spend ledger`
    : "REMOVE the seed-bound policy (seed returns to v1; env-var budget semantics apply)";
  const confirm = (await promptStderr(`About to ${summary}.\nType 'yes' to proceed: `)).trim().toLowerCase();
  if (confirm !== "yes") { stderr.write("Aborted — nothing changed.\n"); exit(0); }

  // Atomic swap: the new blob replaces seed.enc in one rename — a crash leaves
  // either the old seed or the new one, never a partial file.
  await saveEncryptedMnemonic({ mnemonic: payload.mnemonic, passphrase, path: seedPath, policy, allowOverwrite: true });
  if (policy) {
    await initSignedLedger({ path: ledgerPath, hmacKey: deriveLedgerHmacKey(payload.mnemonic) });
    stderr.write(`Bound. seed.enc rewritten (v2, budget ${policy.dailyBudgetSats} sats); fresh signed ledger at ${ledgerPath}.\n`);
    stderr.write("Deleting or editing the ledger now fails closed; reset legitimately with sparkbtcbot-reset-ledger.\n");
  } else {
    stderr.write("Removed. seed.enc rewritten (v1, no bound policy). Env-var budget (if set) applies again.\n");
  }
}

main().catch((e) => {
  stderr.write(`set-policy: ${e?.message ?? e}\n`);
  exit(1);
});
