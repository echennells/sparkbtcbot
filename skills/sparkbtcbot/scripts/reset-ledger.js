#!/usr/bin/env node
// Legitimate reset of the SIGNED spend ledger — the replacement for `rm`.
//
// With a seed-bound policy, a missing or unverifiable ledger fails CLOSED
// (deleting the file must not restore the budget — `rm` used to be both the
// attack and the documented reset, indistinguishable). This CLI is the
// distinguishable reset: writing a fresh signed ledger requires the HMAC key,
// which is derived from the decrypted mnemonic, which requires the passphrase.
// TTY-gated on both ends: resetting the spend window is an operator decision.
import "dotenv/config";
import { stdin, stdout, stderr, exit, env } from "node:process";
import { loadSeedPayload, deriveLedgerHmacKey, DEFAULT_SEED_PATH, MIN_PASSPHRASE_CHARS } from "../../../lib/encrypted-seed.js";
import { initSignedLedger, DEFAULT_SPEND_LEDGER_PATH } from "../../../lib/spend-ledger.js";
import { promptStderr } from "./prompt.js";

const USAGE =
  "Usage: sparkbtcbot-reset-ledger\n\n" +
  "Write a fresh, EMPTY, signed spend ledger for a wallet whose seed carries a\n" +
  "bound spending policy — the legitimate reset after a machine migration or a\n" +
  "deliberate window restart. Requires the passphrase (the signature key derives\n" +
  "from the decrypted seed). Takes no arguments; refuses to run without a real\n" +
  "interactive terminal.\n\nEnv: SPARK_SEED_PATH, SPARK_SPEND_LEDGER_PATH.\n";

{
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { stdout.write(USAGE); exit(0); }
  if (args.length) { stderr.write(`reset-ledger: unknown argument(s): ${args.join(" ")}\n\n` + USAGE); exit(2); }
}

if (!stdout.isTTY || !stdin.isTTY) {
  stderr.write(
    "reset-ledger: refusing to run without a real interactive terminal on both stdin and stdout.\n" +
    "Resetting the spend window is an operator decision — run it yourself; an agent must not.\n",
  );
  exit(3);
}

async function main() {
  const seedPath = env.SPARK_SEED_PATH || DEFAULT_SEED_PATH;
  const ledgerPath = env.SPARK_SPEND_LEDGER_PATH || DEFAULT_SPEND_LEDGER_PATH;

  // ALWAYS prompt — deliberately ignoring SPARK_PASSPHRASE/.env. These
  // ceremonies exist to prove an OPERATOR is present; in the documented
  // deployment the passphrase lives in .env right next to the wallet, so
  // accepting it from the environment would reduce "requires the passphrase"
  // to "requires a PTY", which an agent can allocate.
  const passphrase = await promptStderr(`Passphrase for ${seedPath} (typed, not read from .env): `, { hidden: true });
  if (!passphrase || passphrase.length < MIN_PASSPHRASE_CHARS) {
    stderr.write(`reset-ledger: passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters.\n`);
    exit(1);
  }

  const payload = await loadSeedPayload({ passphrase, path: seedPath });
  if (!payload.policy) {
    stderr.write(
      "reset-ledger: this seed carries no bound policy — the ledger is unsigned and resets by deleting the file.\n" +
      "(Bind a budget first with sparkbtcbot-set-policy if you want a signed, deletion-proof ledger.)\n",
    );
    exit(1);
  }

  const confirm = (await promptStderr(
    `About to RESET the signed spend ledger at ${ledgerPath} — the ${payload.policy.dailyBudgetSats}-sat window restarts empty.\nType 'yes' to proceed: `,
  )).trim().toLowerCase();
  if (confirm !== "yes") { stderr.write("Aborted — nothing changed.\n"); exit(0); }

  await initSignedLedger({ path: ledgerPath, hmacKey: deriveLedgerHmacKey(payload.mnemonic) });
  stderr.write(`Reset. Fresh signed ledger at ${ledgerPath}; the budget window starts now.\n`);
}

main().catch((e) => {
  stderr.write(`reset-ledger: ${e?.message ?? e}\n`);
  exit(1);
});
