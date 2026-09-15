#!/usr/bin/env node
// `sparkbtcbot viewer` — read-only access to a PRIVATE wallet without the seed.
//
// Spark wallets are publicly readable by default; the runtime turns the
// per-wallet privacy setting on (lib/wallet-privacy.js), after which the
// operators answer balance/transfer queries only to the owner. The viewer key
// (spark-sdk >= 0.12) is the one exception: the owner names exactly ONE other
// identity public key that may read — a dashboard, an accountant, a second
// monitoring agent — and that party authenticates with its OWN seed, never the
// owner's. Read-only by construction: nothing in the signing or transfer path
// consults the key. With privacy off the grant is meaningless (everyone can
// already read), so this command is only interesting alongside SPARK_PRIVACY.
//
// Two sides, four verbs:
//   owner   → `status`            what the operators hold for this wallet
//             `grant <hex-pubkey>` name the viewer (asks y/N — see below)
//             `revoke`            clear it
//   viewer  → `pubkey`            this install's viewer key, to hand to an owner
//             `balance <address>` read an owner wallet that granted this key
//
// `grant` hands a third party what privacy protects — the balance and the
// full spending log — durably, until revoked. That is a consent decision, not
// a seed-tier secret (it moves no money and `revoke` undoes it), so it gets
// the skill's confirm-before-acting treatment rather than a TTY wall: the
// command prints exactly what it is about to do and asks y/N, and the agent
// rule (SKILL.md / security.md) is to confirm with the user WHO the key
// belongs to before answering yes. `revoke` only tightens, `pubkey` prints a
// public key, `balance` reads a wallet that chose to share with us.
import "dotenv/config";
import { stdout, stderr, exit, env } from "node:process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { promptStderr } from "./prompt.js";

const USAGE =
  "Usage: sparkbtcbot viewer <status | grant <hex-pubkey> | revoke | pubkey | balance <spark-address>>\n\n" +
  "Read-only access to a PRIVATE wallet without sharing its seed (spark-sdk >= 0.12).\n\n" +
  "Owner side (this install's wallet is the one being read):\n" +
  "  status              print the privacy setting and the granted viewer key, if any\n" +
  "  grant <hex-pubkey>  grant ONE identity public key read access (asks y/N; replaces any\n" +
  "                      prior grant; confirm with the user whose key it is before saying yes)\n" +
  "  revoke              clear the viewer grant\n\n" +
  "Viewer side (this install reads someone else's wallet):\n" +
  "  pubkey              print this install's viewer identity public key — hand it to the\n" +
  "                      owner for `grant`. Offline; derived from the local encrypted seed.\n" +
  "  balance <address>   read the available balance of an owner wallet that granted this key\n\n" +
  "Env: SPARK_PASSPHRASE (decrypts seed.enc), SPARK_NETWORK, SPARK_SEED_PATH, SPARK_ACCOUNT_NUMBER.\n";

const VERBS = ["status", "grant", "revoke", "pubkey", "balance"];
const HEX_PUBKEY = /^0[23][0-9a-fA-F]{64}$/;

// Parse argv into { verb, arg } or throw a usage error. Exported for tests: the
// gate must refuse a typo'd verb before any seed is decrypted.
export function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) return { help: true };
  const [verb, arg, ...rest] = argv;
  if (!verb) throw new Error("missing verb");
  if (!VERBS.includes(verb)) throw new Error(`unknown verb "${verb}"`);
  if (verb === "grant") {
    if (!arg) throw new Error("grant needs the viewer's identity public key (66 hex chars, 02/03-prefixed)");
    if (!HEX_PUBKEY.test(arg)) throw new Error(`"${arg}" is not a compressed secp256k1 public key (66 hex chars starting 02 or 03)`);
  } else if (verb === "balance") {
    if (!arg) throw new Error("balance needs the owner's Spark address");
    if (!/^spark(rt|l|t|s)?1[a-z0-9]+$/i.test(arg)) throw new Error(`"${arg}" does not look like a Spark address`);
  } else if (arg !== undefined) {
    throw new Error(`${verb} takes no argument, got "${arg}"`);
  }
  if (rest.length) throw new Error(`unexpected argument(s): ${rest.join(" ")}`);
  return { verb, arg };
}

function accountNumberFromEnv() {
  const raw = env.SPARK_ACCOUNT_NUMBER;
  if (raw == null || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`SPARK_ACCOUNT_NUMBER="${raw}" is not an integer`);
  return n;
}

export async function main() {
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2));
  } catch (err) {
    stderr.write(`viewer: ${err.message}\n\n` + USAGE);
    exit(2);
  }
  if (parsed.help) { stdout.write(USAGE); exit(0); }
  const { verb, arg } = parsed;

  const network = env.SPARK_NETWORK || "MAINNET";
  const accountNumber = accountNumberFromEnv();
  const [{ SparkWallet, SparkReadonlyClient, deriveViewerIdentityPublicKey }, { loadMnemonicFromEnv }] =
    await Promise.all([import("@buildonspark/spark-sdk"), import("../../../lib/encrypted-seed.js")]);
  const mnemonic = await loadMnemonicFromEnv();

  // --- viewer side: no wallet of our own is opened at the operators ---
  if (verb === "pubkey") {
    const key = await deriveViewerIdentityPublicKey({ network }, mnemonic, accountNumber);
    stdout.write(key + "\n");
    stderr.write(
      `(viewer identity key for ${network}, account ${accountNumber ?? "default"} — the owner runs ` +
      `\`sparkbtcbot viewer grant ${key.slice(0, 10)}…\`; a key derived for another network or account is accepted and reads nothing)\n`,
    );
    return;
  }
  if (verb === "balance") {
    const reader = await SparkReadonlyClient.createWithViewerKey({ network }, mnemonic, accountNumber);
    try {
      const sats = await reader.getAvailableBalance(arg);
      const pending = await reader.getPendingTransfers(arg);
      stdout.write(`available: ${sats} sats\npending transfers: ${pending.length}\n`);
      stderr.write(
        "(a private wallet that has NOT granted this key answers with an empty view — 0 sats, no transfers — " +
        "not an error; confirm the grant with `sparkbtcbot viewer status` on the owner's install)\n",
      );
    } finally {
      await reader.cleanupConnections?.();
    }
    return;
  }

  // --- owner side ---
  const { wallet } = await SparkWallet.initialize({
    mnemonicOrSeed: mnemonic,
    accountNumber,
    options: { network, optimizationOptions: { auto: false } },
  });
  try {
    const show = (s) =>
      stdout.write(
        `network:      ${network}\n` +
        `privacy:      ${s?.privateEnabled ? "enabled" : "OFF — balance/history publicly readable; a viewer grant changes nothing until it is on"}\n` +
        `viewer key:   ${s?.viewerIdentityPublicKey ?? "(none)"}\n`,
      );
    if (verb === "status") {
      show(await wallet.getWalletSettings());
      return;
    }
    if (verb === "revoke") {
      const before = await wallet.getWalletSettings();
      if (!before?.viewerIdentityPublicKey) {
        stdout.write("no viewer key is granted — nothing to revoke\n");
        return;
      }
      show(await wallet.clearViewerIdentityPublicKey());
      stdout.write(`revoked ${before.viewerIdentityPublicKey}\n`);
      return;
    }
    // grant
    const before = await wallet.getWalletSettings();
    stderr.write(
      `This grants READ access to the wallet's balance and full transfer history to:\n  ${arg}\n` +
      (before?.viewerIdentityPublicKey ? `replacing the current viewer ${before.viewerIdentityPublicKey}\n` : "") +
      (before?.privateEnabled ? "" : "NOTE: privacy is OFF on this wallet, so everyone can already read it; the grant only matters once it is on.\n") +
      "The viewer cannot spend. Revoke any time with `sparkbtcbot viewer revoke`.\n",
    );
    const answer = (await promptStderr("Grant read access? [y/N] ")).trim().toLowerCase();
    if (answer !== "y" && answer !== "yes") {
      stderr.write("aborted — nothing changed\n");
      exit(1);
    }
    const after = await wallet.setViewerIdentityPublicKey(arg);
    if (after?.viewerIdentityPublicKey?.toLowerCase() !== arg.toLowerCase()) {
      stderr.write(`viewer grant: operators returned viewer key ${after?.viewerIdentityPublicKey ?? "(none)"} — the grant did not take\n`);
      exit(1);
    }
    show(after);
    stdout.write("granted\n");
  } finally {
    await wallet.cleanup();
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
  main().catch((err) => {
    stderr.write(`viewer: ${err?.message ?? err}\n`);
    exit(1);
  });
}
