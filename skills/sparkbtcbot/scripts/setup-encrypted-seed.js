// Interactive one-time setup: encrypts a BIP39 mnemonic at rest.
//
// Mode selection (first match wins):
//   1. --import flag → prompt for mnemonic on stderr (hidden input, no echo, no shell-history exposure)
//   2. SPARK_MNEMONIC env set → encrypt that mnemonic (one-time migration path)
//   3. default → generate a fresh mnemonic via @buildonspark/spark-sdk
//
// Passphrase comes from:
//   - SPARK_PASSPHRASE env var if set
//   - otherwise prompted on stderr (with confirmation)
//
// On success, writes ~/.spark/seed.enc with mode 0600 (or SPARK_SEED_PATH).
// Prints the wallet's Spark address so the user can verify the right wallet
// loaded. Surfaces the mnemonic ONCE to the user with explicit save-offline
// instructions if generated fresh.

import "dotenv/config";
import { stdin, stdout, stderr, exit, env } from "node:process";
import { saveEncryptedMnemonic, writeMnemonicBackupFile, DEFAULT_SEED_PATH } from "../../../lib/encrypted-seed.js";
import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

const SEED_PATH = env.SPARK_SEED_PATH || DEFAULT_SEED_PATH;
const NETWORK = env.SPARK_NETWORK || "MAINNET";

function err(msg) {
  stderr.write(`\n${msg}\n`);
}

function info(msg) {
  stderr.write(`${msg}\n`);
}

async function promptStderr(question, { hidden = false } = {}) {
  // readline writes prompts to stdout by default, which is wrong for secrets.
  // Manual loop on stderr.
  return new Promise((resolve, reject) => {
    stderr.write(question);
    let input = "";
    const cleanup = () => {
      stdin.pause();
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
    };
    const onData = (chunk) => {
      const data = chunk.toString();
      for (const ch of data) {
        if (ch === "\n" || ch === "\r") {
          cleanup();
          stderr.write("\n");
          resolve(input);
          return;
        }
        input += ch;
        if (!hidden) stderr.write(ch);
      }
    };
    // Without this, a closed/empty stdin leaves the promise pending and Node
    // exits 0 with no error and no seed written — a silent false success.
    const onEnd = () => {
      cleanup();
      reject(new Error("stdin closed without input"));
    };
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", reject);
  });
}

async function getPassphrase() {
  if (env.SPARK_PASSPHRASE) {
    info("Using SPARK_PASSPHRASE from env.");
    return env.SPARK_PASSPHRASE;
  }
  const a = await promptStderr("Set encryption passphrase (>= 12 chars): ", { hidden: true });
  const b = await promptStderr("Confirm passphrase: ", { hidden: true });
  if (a !== b) {
    err("Passphrases do not match.");
    exit(1);
  }
  return a;
}

// Collapse any whitespace runs (spaces, tabs, newlines) into single spaces and
// trim ends. BIP39 mnemonics are space-separated words; anything else is
// stray formatting from copy-paste or shell-pipe weirdness.
function normalizeMnemonic(s) {
  if (typeof s !== "string") return "";
  return s.trim().replace(/\s+/g, " ");
}

// Valid BIP39 mnemonic word counts.
const VALID_WORD_COUNTS = new Set([12, 15, 18, 21, 24]);

async function getMnemonicSource() {
  // Order: explicit --import flag, then SPARK_MNEMONIC env, then generate fresh.
  const args = process.argv.slice(2);
  if (args.includes("--import")) {
    // Hidden: stderr (and anything capturing it, e.g. an agent transcript)
    // must not get a verbatim copy of the mnemonic. Paste corruption is
    // still caught — the SDK verifies the mnemonic below and the printed
    // Spark address lets the user confirm the right wallet loaded.
    const m = await promptStderr("Paste your existing 12 or 24 word mnemonic: ", { hidden: true });
    return { mnemonic: normalizeMnemonic(m), source: "imported" };
  }
  if (env.SPARK_MNEMONIC) {
    info("Encrypting mnemonic from SPARK_MNEMONIC env var.");
    return { mnemonic: normalizeMnemonic(env.SPARK_MNEMONIC), source: "env" };
  }
  // Generate fresh
  info(`Generating a fresh ${NETWORK} mnemonic...`);
  const { SparkWallet } = await import("@buildonspark/spark-sdk");
  const result = await SparkWallet.initialize({ options: { network: NETWORK } });
  const mnemonic = normalizeMnemonic(result.mnemonic);
  await result.wallet.cleanup();
  return { mnemonic, source: "generated" };
}

async function main() {
  if (existsSync(SEED_PATH)) {
    err(`Encrypted seed already exists at ${SEED_PATH}.`);
    err("Refusing to overwrite. Delete the file first, or set SPARK_SEED_PATH to a different location.");
    exit(2);
  }

  const { mnemonic, source } = await getMnemonicSource();
  if (!mnemonic) {
    err("No mnemonic provided.");
    exit(1);
  }
  const wordCount = mnemonic.split(" ").length;
  if (!VALID_WORD_COUNTS.has(wordCount)) {
    err(`Mnemonic looks invalid: got ${wordCount} words, BIP39 requires exactly 12, 15, 18, 21, or 24.`);
    exit(1);
  }
  // Each word must be lowercase ASCII letters. BIP39 wordlist is all lowercase
  // alphabetic — anything else is paste corruption or input-injection.
  if (!/^[a-z]+(?: [a-z]+)*$/.test(mnemonic)) {
    err("Mnemonic looks invalid: contains non-alphabetic characters or non-lowercase words.");
    exit(1);
  }

  const passphrase = await getPassphrase();
  if (passphrase.length < 12) {
    err("Passphrase must be at least 12 characters.");
    exit(1);
  }

  // Verify the mnemonic by initializing a wallet from it BEFORE we write
  // anything. If the SDK rejects it (bad checksum, invalid words, etc.),
  // we exit without leaving an orphan seed.enc or backup file behind.
  info("\nVerifying mnemonic with the Spark SDK...");
  const { SparkWallet } = await import("@buildonspark/spark-sdk");
  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: mnemonic,
    options: { network: NETWORK },
  });
  const address = await wallet.getSparkAddress();
  await wallet.cleanup();

  info("\nEncrypting...");
  await saveEncryptedMnemonic({ mnemonic, passphrase, path: SEED_PATH });
  info(`Wrote ${SEED_PATH} (mode 0600)`);

  // Surface the bare facts user needs
  stdout.write("\n=== setup complete ===\n");
  stdout.write(`network:        ${NETWORK}\n`);
  stdout.write(`spark address:  ${address}\n`);
  stdout.write(`encrypted seed: ${SEED_PATH}\n`);

  if (source === "generated") {
    // CRITICAL: do NOT print the mnemonic to stdout. If this script is being
    // invoked by an AI agent that captures stdout into a conversation log,
    // printing the mnemonic would leak it into the transcript. Instead write
    // the mnemonic to a persistent file (next to seed.enc) and print only
    // the path.
    const backupPath = await writeMnemonicBackupFile(mnemonic, { dir: dirname(SEED_PATH) });
    stdout.write("\n=== !!! BACK UP YOUR MNEMONIC NOW !!! ===\n");
    stdout.write(`The 12-word mnemonic was written to:\n  ${backupPath}\n`);
    stdout.write("\nThis file is on disk, mode 0600, and does NOT auto-delete.\n");
    stdout.write("\nWhat to do next:\n");
    stdout.write("  1. Read the file:  cat \"" + backupPath + "\"\n");
    stdout.write("     (Default: do this in your own terminal so the words don't land\n");
    stdout.write("     in the agent's transcript. Asking the agent to read it is allowed\n");
    stdout.write("     if you'd rather see it here, but accept the trade-off.)\n");
    stdout.write("  2. Copy the words to an offline backup — paper, password manager,\n");
    stdout.write("     or hardware-wallet seed backup. This is the ONLY recovery path.\n");
    stdout.write(`  3. Delete the file:  rm "${backupPath}"\n`);
    stdout.write("\nUntil you delete it, the file persists across reboots.\n");
  } else if (source === "env") {
    stdout.write("\nNext: remove SPARK_MNEMONIC from .env and replace with SPARK_PASSPHRASE.\n");
  }

  stdout.write("\nIn your app:\n");
  stdout.write("  import { loadMnemonicFromEnv } from \"./lib/encrypted-seed.js\";\n");
  stdout.write("  const mnemonic = await loadMnemonicFromEnv();\n");
  stdout.write("  const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, ... });\n");
}

// Run main() only when executed directly (node script.js), not when this
// file is imported as a module. realpathSync handles symlinked invocations
// (e.g. via ~/.claude/skills).
const isMainModule =
  process.argv[1] &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;

if (isMainModule) {
  main().catch((e) => {
    err(`setup failed: ${e.message}`);
    exit(1);
  });
}
