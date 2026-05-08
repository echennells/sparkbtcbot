// Interactive one-time setup: encrypts a BIP39 mnemonic at rest.
//
// Three modes:
//   1. SPARK_MNEMONIC env set → use it as the mnemonic to encrypt
//   2. --import flag → read mnemonic from stdin
//   3. default (neither) → generate a fresh mnemonic via @buildonspark/spark-sdk
//
// Passphrase comes from:
//   - SPARK_PASSPHRASE env var if set
//   - otherwise prompted on stderr
//
// On success, writes ~/.spark/seed.enc with mode 0600 (or SPARK_SEED_PATH).
// Prints the wallet's Spark address so the user can verify the right wallet
// loaded. Surfaces the mnemonic ONCE to the user with explicit save-offline
// instructions if generated fresh.

import "dotenv/config";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { stdin, stdout, stderr, exit, env } from "node:process";
import { saveEncryptedMnemonic, DEFAULT_SEED_PATH } from "../../../lib/encrypted-seed.js";
import { existsSync } from "node:fs";

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
    const onData = (chunk) => {
      const data = chunk.toString();
      for (const ch of data) {
        if (ch === "\n" || ch === "\r") {
          stdin.pause();
          stdin.removeListener("data", onData);
          stderr.write("\n");
          resolve(input);
          return;
        }
        input += ch;
        if (!hidden) stderr.write(ch);
      }
    };
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
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

async function getMnemonicSource() {
  // Order: explicit --import flag, then SPARK_MNEMONIC env, then generate fresh.
  const args = process.argv.slice(2);
  if (args.includes("--import")) {
    const m = await promptStderr("Paste your existing 12 or 24 word mnemonic: ");
    return { mnemonic: m.trim(), source: "imported" };
  }
  if (env.SPARK_MNEMONIC) {
    info("Encrypting mnemonic from SPARK_MNEMONIC env var.");
    return { mnemonic: env.SPARK_MNEMONIC.trim(), source: "env" };
  }
  // Generate fresh
  info(`Generating a fresh ${NETWORK} mnemonic...`);
  const { SparkWallet } = await import("@buildonspark/spark-sdk");
  const result = await SparkWallet.initialize({ options: { network: NETWORK } });
  const mnemonic = result.mnemonic;
  await result.wallet.cleanupConnections();
  return { mnemonic, source: "generated" };
}

async function main() {
  if (existsSync(SEED_PATH)) {
    err(`Encrypted seed already exists at ${SEED_PATH}.`);
    err("Refusing to overwrite. Delete the file first, or set SPARK_SEED_PATH to a different location.");
    exit(2);
  }

  const { mnemonic, source } = await getMnemonicSource();
  if (!mnemonic || mnemonic.split(/\s+/).length < 12) {
    err("Mnemonic looks invalid (must be 12 or 24 words).");
    exit(1);
  }

  const passphrase = await getPassphrase();
  if (passphrase.length < 12) {
    err("Passphrase must be at least 12 characters.");
    exit(1);
  }

  info("\nEncrypting...");
  await saveEncryptedMnemonic({ mnemonic, passphrase, path: SEED_PATH });
  info(`Wrote ${SEED_PATH} (mode 0600)`);

  // Verify by loading wallet and showing the address
  info("\nVerifying — initializing wallet from the encrypted seed...");
  const { SparkWallet } = await import("@buildonspark/spark-sdk");
  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: mnemonic,
    options: { network: NETWORK },
  });
  const address = await wallet.getSparkAddress();
  await wallet.cleanupConnections();

  // Surface the bare facts user needs
  stdout.write("\n=== setup complete ===\n");
  stdout.write(`network:        ${NETWORK}\n`);
  stdout.write(`spark address:  ${address}\n`);
  stdout.write(`encrypted seed: ${SEED_PATH}\n`);

  if (source === "generated") {
    stdout.write("\n=== !!! BACK UP THIS MNEMONIC OFFLINE NOW !!! ===\n");
    stdout.write(`  ${mnemonic}\n`);
    stdout.write("=== this is the ONLY recovery path; this is the LAST time you'll see it ===\n");
    stdout.write("After saving, clear your terminal scrollback.\n");
  } else if (source === "env") {
    stdout.write("\nNext: remove SPARK_MNEMONIC from .env and replace with SPARK_PASSPHRASE.\n");
  }

  stdout.write("\nIn your app:\n");
  stdout.write("  import { loadMnemonicFromEnv } from \"./lib/encrypted-seed.js\";\n");
  stdout.write("  const mnemonic = await loadMnemonicFromEnv();\n");
  stdout.write("  const { wallet } = await SparkWallet.initialize({ mnemonicOrSeed: mnemonic, ... });\n");
}

main().catch((e) => {
  err(`setup failed: ${e.message}`);
  exit(1);
});
