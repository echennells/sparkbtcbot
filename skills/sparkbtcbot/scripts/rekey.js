#!/usr/bin/env node
// Change the passphrase on seed.enc — the ceremony for "the passphrase leaked,
// the file didn't".
//
// What it does: decrypts seed.enc under the current passphrase, re-encrypts
// the same mnemonic AND the same sealed policy under the new one (fresh salt
// and IV), atomic swap. Nothing else under ~/.spark is passphrase-bound — the
// spend ledger's HMAC key and the leaf-vault derive from the MNEMONIC — so the
// seed file is the whole job.
//
// What it does NOT do: protect copies. Every copy of the OLD seed.enc (a
// backup, a synced folder, a snapshot) still opens with the old passphrase.
// If the FILE may have been copied, or you can't say which leaked, the answer
// is a new wallet (rotate), not a new passphrase.
//
// TTY-gated on BOTH ends like set-policy and reveal-mnemonic: the current
// passphrase is typed, never read from .env, so a present operator is proven;
// the new one is typed twice or generated (--generate) and shown ONCE.
import "dotenv/config";
import { stdin, stdout, stderr, exit, env } from "node:process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { rekeyEncryptedSeed, DEFAULT_SEED_PATH, MIN_PASSPHRASE_CHARS } from "../../../lib/encrypted-seed.js";
import { promptStderr } from "./prompt.js";

const GENERATED_CHARS = 24;

const USAGE =
  "Usage: sparkbtcbot rekey [--generate]\n\n" +
  "Change the passphrase that encrypts seed.enc. Prompts for the CURRENT passphrase\n" +
  "(typed, never read from .env), then the new one twice; re-encrypts the mnemonic\n" +
  "and the sealed policy atomically. The spend ledger and leaf-vault are untouched\n" +
  "(they are keyed by the mnemonic, not the passphrase).\n\n" +
  "  --generate   mint a random " + GENERATED_CHARS + "-character passphrase instead of typing one;\n" +
  "               it is shown ONCE on this terminal — store it before continuing.\n\n" +
  "Afterwards, update SPARK_PASSPHRASE everywhere it is stored (.env, a passphrase\n" +
  "file, systemd/Docker secrets, a hosted deploy's secret). Use this when the\n" +
  "PASSPHRASE leaked and the file stayed put; if seed.enc itself may have been\n" +
  "copied, rotate to a new wallet instead — a new passphrase does not protect old\n" +
  "copies. Refuses to run without a real interactive terminal.\n\nEnv: SPARK_SEED_PATH.\n";

// 18 random bytes -> 24 base64url chars (~144 bits). Far above the 12-char
// floor and above anything a person will choose — the reason to offer it.
function generatePassphrase() {
  return randomBytes(18).toString("base64url");
}

export async function main() {
  // Arg gate FIRST, then the TTY gate — inside main() so IMPORTING this module
  // stays inert (the `sparkbtcbot` dispatcher imports, then calls main once).
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { stdout.write(USAGE); exit(0); }
  let generate = false;
  if (args.length === 1 && args[0] === "--generate") generate = true;
  else if (args.length) { stderr.write(`rekey: unknown argument(s): ${args.join(" ")}\n\n` + USAGE); exit(2); }

  if (!stdout.isTTY || !stdin.isTTY) {
    stderr.write(
      "rekey: refusing to run without a real interactive terminal on both stdin and stdout.\n" +
      "Changing the seed passphrase is an operator ceremony — run it yourself; an agent must not.\n",
    );
    exit(3);
  }

  const seedPath = env.SPARK_SEED_PATH || DEFAULT_SEED_PATH;

  // ALWAYS prompt for the current passphrase — deliberately ignoring
  // SPARK_PASSPHRASE/.env, for the same reason set-policy does: the ceremony
  // proves an operator is present, and in the documented deployment the
  // passphrase sits in .env next to the wallet.
  const passphrase = await promptStderr(`Current passphrase for ${seedPath} (typed, not read from .env): `, { hidden: true });
  if (!passphrase || passphrase.length < MIN_PASSPHRASE_CHARS) {
    stderr.write(`rekey: passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters.\n`);
    exit(1);
  }

  let newPassphrase;
  if (generate) {
    newPassphrase = generatePassphrase();
    stderr.write(
      "\n=== new passphrase (shown once) ===\n" +
      `${newPassphrase}\n` +
      "===================================\n" +
      "Store it now (password manager, secrets store). It is not written anywhere by this command.\n",
    );
    const ack = (await promptStderr("Type 'stored' once you have saved it: ")).trim().toLowerCase();
    if (ack !== "stored") { stderr.write("Aborted — nothing changed; the passphrase above is discarded.\n"); exit(0); }
  } else {
    const a = await promptStderr(`New passphrase (>= ${MIN_PASSPHRASE_CHARS} chars): `, { hidden: true });
    const b = await promptStderr("Confirm new passphrase: ", { hidden: true });
    if (a !== b) { stderr.write("rekey: passphrases do not match — nothing changed.\n"); exit(1); }
    newPassphrase = a;
  }
  if (newPassphrase.length < MIN_PASSPHRASE_CHARS) {
    stderr.write(`rekey: new passphrase must be at least ${MIN_PASSPHRASE_CHARS} characters — nothing changed.\n`);
    exit(1);
  }
  if (newPassphrase === passphrase) { stderr.write("rekey: new passphrase is identical to the current one — nothing changed.\n"); exit(1); }

  const confirm = (await promptStderr(`About to re-encrypt ${seedPath} under the new passphrase.\nType 'yes' to proceed: `)).trim().toLowerCase();
  if (confirm !== "yes") { stderr.write("Aborted — nothing changed.\n"); exit(0); }

  // Decrypt -> re-encrypt (fresh salt + IV) -> atomic swap. A wrong current
  // passphrase fails here (BAD_PASSPHRASE) with the file untouched.
  const { version, policy } = await rekeyEncryptedSeed({ path: seedPath, passphrase, newPassphrase });
  stderr.write(
    `Rekeyed. ${seedPath} rewritten (v${version}${policy ? ", sealed policy carried over unchanged" : ""}).\n\n` +
    "Now update SPARK_PASSPHRASE everywhere the old value is stored:\n" +
    "  - .env next to the agent\n" +
    "  - SPARK_PASSPHRASE_FILE / systemd LoadCredential / Docker secret, if used\n" +
    "  - any hosted deploy's secret (e.g. the Cloudflare Worker)\n" +
    "Then boot the agent once (a balance check is enough) to confirm the new value works.\n\n" +
    "Reminder: copies of the OLD seed.enc elsewhere still open with the OLD passphrase.\n" +
    "If the file itself may have been copied, rotate to a new wallet.\n",
  );
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
    stderr.write(`rekey: ${e?.message ?? e}\n`);
    exit(1);
  });
}
