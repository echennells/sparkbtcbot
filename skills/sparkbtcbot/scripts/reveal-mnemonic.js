// Show the wallet's 12-word mnemonic ON DEMAND, decrypted from seed.enc, so the
// user can back it up offline — WITHOUT ever writing a persistent plaintext file
// (the old MNEMONIC_BACKUP_*.txt undercut encryption-at-rest until it was rm'd).
//
// This prints a seed phrase. Two protections keep it out of an agent's transcript:
//   1. It REFUSES to run unless stdout is a real TTY. An AI agent running this
//      over a Bash tool captures stdout into a pipe (isTTY=false) — so it aborts
//      and prints nothing. Run it yourself, in your own terminal.
//   2. It requires an explicit y/N confirmation before printing.
//
// (This adds no attack surface a compromised process didn't already have: any
// process with the passphrase + seed file can call loadMnemonic directly. The
// TTY gate defends the *honest-agent-captures-stdout* mistake, not a compromise.)
import "dotenv/config";
import { stdout, stderr, exit, env } from "node:process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { loadMnemonic, DEFAULT_SEED_PATH, MIN_PASSPHRASE_CHARS } from "../../../lib/encrypted-seed.js";
import { promptStderr } from "./prompt.js";

const SEED_PATH = env.SPARK_SEED_PATH || DEFAULT_SEED_PATH;

async function main() {
  // Gate 1: only a real interactive terminal. A captured/piped stdout (an agent
  // Bash tool, CI, a `| tee`) means the words would land somewhere durable —
  // refuse and say why.
  if (!stdout.isTTY) {
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
