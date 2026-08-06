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
  // Arg gate FIRST — before the TTY gate, so `--help` answers even when piped
  // (usage text holds no secrets). This CLI's default action reveals the seed
  // phrase, so any argument other than -h/--help fails closed with usage: a
  // typo'd flag must never fall through to a reveal.
  const args = process.argv.slice(2);
  const usage =
    "Usage: sparkbtcbot-reveal-mnemonic\n\n" +
    "Decrypts the seed file and displays the mnemonic ONCE on a temporary screen\n" +
    "(alternate buffer where the terminal supports it — wiped when you continue), for the human\n" +
    "operator to copy to an offline backup. Takes no arguments. Refuses to run without a\n" +
    "real interactive terminal on both stdin and stdout — run it yourself, not\n" +
    "through an agent. Env: SPARK_PASSPHRASE (prompted if unset), SPARK_SEED_PATH.\n";
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(usage);
    return exit(0);
  }
  if (args.length) {
    stderr.write(`reveal-mnemonic: unknown argument(s): ${args.join(" ")}\n\n` + usage);
    return exit(2);
  }
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
    "\n⚠️  This will display your seed phrase on a temporary screen that is wiped\n" +
    "   when you continue — on most terminals (xterm, tmux, iTerm, Windows\n" +
    "   Terminal) it never enters scrollback. GNU screen users: see the note\n" +
    "   printed afterwards. Anyone who sees these words controls the wallet:\n" +
    "   make sure nobody is watching and the session isn't being recorded\n" +
    "   (asciinema, screen sharing, shoulder cams).\n\n",
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

  // Display on the ALTERNATE screen buffer (the mechanism less/vim use): the
  // words render outside the normal scrollback, and once the user confirms
  // they've copied them the buffer is wiped and the terminal returns to the
  // primary screen — nothing lands in scrollback, tmux/screen history, or
  // naive terminal logs. Fallback for TERM=dumb: print on the primary screen,
  // then best-effort erase display + scrollback (CSI 2J / 3J).
  const altScreen = Boolean(env.TERM) && env.TERM !== "dumb";
  let wiped = false; // idempotent: the exit hook below must never re-wipe the RESTORED primary screen
  const wipe = () => {
    if (wiped) return;
    wiped = true;
    try {
      stdout.write("\x1b[2J\x1b[3J\x1b[H"); // erase display + scrollback, home cursor
      if (altScreen) stdout.write("\x1b[?1049l"); // back to the primary screen
    } catch { /* terminal already gone */ }
  };
  // NO exit path may strand the words on screen. 'exit' covers returns, throws,
  // and process.exit — including Ctrl-C, which prompt.js handles itself in raw
  // mode via exit(130), so a SIGINT handler would never fire for it. But 'exit'
  // does NOT run on default-disposition signals: an unhandled SIGTERM/SIGHUP
  // would leave the seed on screen (and the terminal stuck in the alt buffer)
  // indefinitely. Handle those explicitly, then re-raise so the exit status
  // still reflects the signal.
  process.once("exit", wipe);
  for (const sig of ["SIGTERM", "SIGHUP"]) {
    process.once(sig, () => {
      wipe();
      try { stdin.setRawMode?.(false); } catch { /* not a tty anymore */ }
      process.kill(process.pid, sig); // listener already removed by once() -> default disposition
    });
  }

  const numbered = mnemonic
    .trim()
    .split(/\s+/)
    .map((w, i) => `  ${String(i + 1).padStart(2)}. ${w}`)
    .join("\n");

  if (altScreen) stdout.write("\x1b[?1049h\x1b[H"); // enter alt screen
  stdout.write(
    "\n  Your seed phrase — copy it to PAPER or a hardware seed backup NOW:\n\n" +
    numbered +
    "\n\n  This screen is wiped as soon as you continue.\n",
  );
  await promptStderr("\nPress Enter AFTER you have copied all the words... ");
  wipe();
  // Honest completion message: we REQUEST the alternate screen, we cannot
  // verify the terminal honored it. GNU screen ships `altscreen off` by
  // default, so under TERM=screen* the words went to the pane's normal buffer
  // and its copy-mode history — which our CSI 3J does not clear. Say so, and
  // give those users the manual step instead of false assurance.
  const multiplexed = /^screen/.test(env.TERM ?? "") || Boolean(env.STY);
  stderr.write(
    "Screen cleared. Your offline copy is now the only recovery path — verify you can read every word.\n" +
    (multiplexed
      ? "\n⚠️  You appear to be inside GNU screen, which disables the alternate screen by default.\n" +
        "   If so, the words went to this pane's scrollback: clear it now (Ctrl-A then :scrollback 0,\n" +
        "   or detach and start a fresh window) — they are NOT removed automatically there.\n"
      : altScreen
        ? ""
        : "\nNote: TERM has no alternate-screen support, so this was a best-effort erase of the\nprimary screen. If your terminal keeps its own scrollback, clear it manually.\n"),
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
