#!/usr/bin/env node
// Show the wallet's 12-word mnemonic ON DEMAND, decrypted from seed.enc, so the
// user can back it up offline — WITHOUT ever writing a persistent plaintext file
// (the old MNEMONIC_BACKUP_*.txt undercut encryption-at-rest until it was rm'd).
//
// This prints a seed phrase. Protections, and their HONEST limits:
//   1. It refuses unless BOTH stdout AND stdin are real TTYs. An agent running
//      this over a plain Bash tool has piped stdio (isTTY=false) — it aborts and
//      prints nothing. Requiring stdin-TTY also stops a piped `y\n` from
//      auto-answering the confirm below.
//   2. It requires an interactive y/N confirmation before printing.
//
// LIMIT (do not oversell this): the TTY check is a backstop against the ACCIDENTAL
// capture — an agent that helpfully runs the command with piped output. It is NOT
// a defense against a determined agent that allocates a full pseudo-terminal
// (under a PTY, isTTY is true and the PTY output is exactly what gets captured).
// Nothing can make "print a secret to a terminal the caller controls" safe. The
// real protection is the behavioral rule "the agent must not run this — the user
// runs it themselves", plus: this adds no attack surface a compromised process
// lacked, since anything with the passphrase + seed file can call loadMnemonic
// directly. So: backstop against a mistake, not a security boundary.
import "dotenv/config";
import { stdin, stdout, stderr, exit, env } from "node:process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { loadMnemonic, DEFAULT_SEED_PATH, MIN_PASSPHRASE_CHARS } from "../../../lib/encrypted-seed.js";
import { promptStderr } from "./prompt.js";

const SEED_PATH = env.SPARK_SEED_PATH || DEFAULT_SEED_PATH;

async function main() {
  // Gate: require a real interactive terminal on BOTH ends. Piped/captured
  // stdout (an agent Bash tool, CI, `| tee`) would land the words somewhere
  // durable; piped stdin would let a canned `y\n` auto-answer the confirm below.
  // (This does NOT stop an agent that allocates a full PTY — see the header; the
  // real guard is "the user runs this, not the agent".)
  if (!stdout.isTTY || !stdin.isTTY) {
    stderr.write(
      "reveal-mnemonic: refusing to print your seed phrase to a non-interactive session.\n" +
      "This is almost always an AI agent capturing output. Run it yourself, in your\n" +
      "own terminal:  npm run reveal-mnemonic\n",
    );
    exit(3);
  }

  stderr.write(
    "\n⚠️  This will print your 12-word seed phrase to THIS screen.\n" +
    "   Anyone who sees it controls the wallet. Make sure nobody is watching\n" +
    "   and your terminal isn't being recorded (tmux/screen/asciinema).\n\n",
  );
  const go = await promptStderr("Print the seed phrase now? [y/N]: ");
  if (!/^y(es)?$/i.test(go.trim())) {
    stderr.write("Aborted — nothing printed.\n");
    exit(0);
  }

  const passphrase = env.SPARK_PASSPHRASE
    ? env.SPARK_PASSPHRASE
    : await promptStderr(`Passphrase (>= ${MIN_PASSPHRASE_CHARS} chars): `, { hidden: true });

  let mnemonic;
  try {
    mnemonic = await loadMnemonic({ passphrase, path: SEED_PATH });
  } catch (e) {
    stderr.write(
      e?.code === "NO_SEED"
        ? `No encrypted seed at ${SEED_PATH}. Run \`npm run setup\` first.\n`
        : "Could not decrypt — wrong passphrase or corrupted seed file.\n",
    );
    exit(1);
  }

  stdout.write("\n" + mnemonic + "\n\n");
  stderr.write(
    "Copy these words to an OFFLINE backup (paper / hardware seed backup), then\n" +
    "clear your terminal scrollback. This is the only recovery path.\n",
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
    stderr.write(`reveal-mnemonic failed: ${e.message}\n`);
    exit(1);
  });
}
