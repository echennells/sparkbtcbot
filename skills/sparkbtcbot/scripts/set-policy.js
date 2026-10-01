#!/usr/bin/env node
// Bind, change, or remove the SEED-BOUND spending policy — the deliberate
// ceremony for "change what my agent may spend".
//
// Why a ceremony: the policy lives INSIDE the encrypted seed payload (v2
// seed.enc), so it inherits the seed's protections — reading it needs the
// passphrase, tampering fails the GCM tag, deleting it deletes the wallet.
// Changing it therefore means decrypt -> modify -> re-encrypt -> atomic swap,
// gated by a real terminal and an explicit confirmation. That friction is
// intentional. A sealed daily budget (sats, or a token's tokenLimits
// dailyBudget) needs a spend ledger SIGNED with this seed's key: one that
// already verifies is kept as it is, a missing one is created, and an
// unsigned (env-budget) one is signed as it stands. Spends already in the
// window keep counting, so tightening one limit never frees headroom under
// another. This ceremony never empties the window — that is `reset-ledger`.
//
// Three modes (lib/policy.js defines the object):
//   set-policy                 interactive: set/remove the daily budget only,
//                              every other sealed rule is preserved
//   set-policy --file p.json   seal the whole object from a JSON file:
//                              { dailyBudgetSats, maxPerTxSats, allowedOps,
//                                allowedRecipients, allowedHosts, deniedHosts,
//                                tokenLimits, expiresAt, exec: { path } }
//                              (exec.sha256 is computed HERE and pinned)
//   set-policy --show          print the current sealed policy as JSON to
//                              stdout (edit it, then --file it back)
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
import { readFile } from "node:fs/promises";
import { loadSeedPayload, saveEncryptedMnemonic, deriveLedgerHmacKey, validateSeedPolicy, DEFAULT_SEED_PATH, MIN_PASSPHRASE_CHARS } from "../../../lib/encrypted-seed.js";
import { initSignedLedger, inspectLedgerForBinding, DEFAULT_SPEND_LEDGER_PATH } from "../../../lib/spend-ledger.js";
import { sha256File, POLICY_OPS, policyHasLedgerBudget } from "../../../lib/policy.js";
import { promptStderr } from "./prompt.js";

const USAGE =
  "Usage: sparkbtcbot set-policy [--file <policy.json> | --show]\n\n" +
  "Bind, change, or remove the policy sealed inside the encrypted seed. Decrypts\n" +
  "seed.enc (prompts for the passphrase — never read from .env), shows the current\n" +
  "policy, confirms, then re-encrypts the seed atomically.\n\n" +
  "  (no flag)      interactively set or remove the daily budget; every other\n" +
  "                 sealed rule is preserved. Spends already in the window keep\n" +
  "                 counting against a changed budget (reset-ledger empties it).\n" +
  "  --file <path>  seal the whole policy object from a JSON file. Keys:\n" +
  "                 dailyBudgetSats, maxPerTxSats, allowedOps [" + POLICY_OPS.join("|") + "],\n" +
  "                 allowedRecipients [addresses], allowedHosts / deniedHosts\n" +
  "                 [\"api.example.com\", \"*.example.com\"] (paid-API hosts),\n" +
  "                 tokenLimits { \"btkn1…\": { maxPerTx: \"25\", dailyBudget: \"100\" } }\n" +
  "                 (token amounts, not base units; a token not listed is refused),\n" +
  "                 expiresAt (ISO-8601),\n" +
  "                 exec: { path } (the executable's sha256 is computed and pinned\n" +
  "                 here; a later change to the file makes every spend fail closed).\n" +
  "                 Unknown keys are refused. An empty object {} removes the policy.\n" +
  "  --show         print the current sealed policy as JSON to stdout (edit, --file).\n\n" +
  "Refuses to run without a real interactive terminal — this is an operator\n" +
  "ceremony, not an agent command.\n\nEnv: SPARK_SEED_PATH, SPARK_SPEND_LEDGER_PATH.\n";

function parseArgs(args) {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  if (args.length === 0) return { mode: "budget" };
  if (args.length === 1 && args[0] === "--show") return { mode: "show" };
  if (args.length === 2 && args[0] === "--file" && args[1] && !args[1].startsWith("-")) return { mode: "file", file: args[1] };
  return { error: `unknown argument(s): ${args.join(" ")}` };
}

async function readPolicyFile(file) {
  let raw;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (err) {
    throw new Error(`could not read policy JSON from ${file}: ${err?.message ?? err}`);
  }
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("policy file must contain a JSON object");
  }
  if (Object.keys(raw).length === 0) return null; // {} = remove the policy
  // exec.sha256 is pinned by THIS ceremony from the file on disk. A provided
  // sha256 that disagrees with the file is refused rather than trusted — the
  // operator must be looking at the same bytes we pin.
  if (raw.exec && typeof raw.exec === "object" && typeof raw.exec.path === "string") {
    const actual = await sha256File(raw.exec.path).catch((err) => {
      throw new Error(`exec.path ${raw.exec.path} is unreadable: ${err?.message ?? err}`);
    });
    if (raw.exec.sha256 !== undefined && raw.exec.sha256 !== actual) {
      throw new Error(`exec.sha256 in the file (${String(raw.exec.sha256).slice(0, 12)}…) does not match the executable on disk (${actual.slice(0, 12)}…) — refusing to pin a hash you are not looking at`);
    }
    raw = { ...raw, exec: { ...raw.exec, sha256: actual } };
  }
  const policy = validateSeedPolicy(raw); // throws on any unknown key / bad value
  // lib/policy.js checks a token id's shape only (it stays SDK-free); verify
  // the bech32m checksum here, so a typo is caught at the seal rather than as
  // a refused send later.
  if (policy?.tokenLimits) {
    const { decodeBech32mTokenIdentifier } = await import("@buildonspark/spark-sdk");
    for (const id of Object.keys(policy.tokenLimits)) {
      try {
        decodeBech32mTokenIdentifier(id);
      } catch {
        throw new Error(`tokenLimits key ${id} is not a valid bech32m token identifier (bad checksum?) — copy it again from the token's balance entry`);
      }
    }
  }
  return policy;
}


const show = (policy) => (policy ? JSON.stringify(policy, null, 2) : "null");

export async function main() {
  // Arg gate FIRST, then the TTY gate — inside main() so IMPORTING this module
  // stays inert (the `sparkbtcbot` dispatcher imports, then calls main once).
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) { stdout.write(USAGE); exit(0); }
  if (opts.error) { stderr.write(`set-policy: ${opts.error}\n\n` + USAGE); exit(2); }

  if (!stdout.isTTY || !stdin.isTTY) {
    stderr.write(
      "set-policy: refusing to run without a real interactive terminal on both stdin and stdout.\n" +
      "Changing the seed-bound spending policy is an operator ceremony — run it yourself; an agent must not.\n",
    );
    exit(3);
  }

  const seedPath = env.SPARK_SEED_PATH || DEFAULT_SEED_PATH;
  const ledgerPath = env.SPARK_SPEND_LEDGER_PATH || DEFAULT_SPEND_LEDGER_PATH;

  // Validate a --file BEFORE asking for the passphrase: a typo in the JSON
  // should not cost a scrypt round-trip, and a bad file must never reach the
  // seal step.
  let next;
  if (opts.mode === "file") next = await readPolicyFile(opts.file);

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
  const current = payload.policy;

  if (opts.mode === "show") {
    stderr.write(current ? "Current sealed policy:\n" : "No seed-bound policy (v1 seed).\n");
    stdout.write(show(current) + "\n");
    exit(0);
  }

  stderr.write(current
    ? `Current sealed policy:\n${show(current)}\n`
    : "No seed-bound policy (v1 seed — budget, if any, comes from SPARK_DAILY_BUDGET_SATS).\n");

  if (opts.mode === "budget") {
    const answer = (await promptStderr("New daily budget in sats ('none' to remove the budget, empty to abort): ")).trim();
    if (!answer) { stderr.write("Aborted — nothing changed.\n"); exit(0); }
    const rest = { ...(current ?? {}) };
    delete rest.dailyBudgetSats;
    if (answer.toLowerCase() === "none") {
      next = Object.keys(rest).length ? validateSeedPolicy(rest) : null;
    } else {
      const sats = Number(answer);
      if (!Number.isSafeInteger(sats) || sats <= 0) {
        stderr.write(`set-policy: "${answer}" is not a positive integer number of sats.\n`);
        exit(1);
      }
      next = validateSeedPolicy({ ...rest, dailyBudgetSats: sats });
    }
  }

  // A sealed budget needs a ledger signed with this seed's key. Look BEFORE
  // confirming, so a ledger that can't be kept stops the ceremony with
  // nothing changed rather than being quietly replaced (that would empty the
  // window, which is reset-ledger's job).
  const hmacKey = deriveLedgerHmacKey(payload.mnemonic);
  let ledger = null;
  if (policyHasLedgerBudget(next)) {
    try {
      ledger = await inspectLedgerForBinding({ path: ledgerPath, hmacKey });
    } catch (err) {
      stderr.write(
        `set-policy: ${err?.message ?? err} Nothing changed.\n` +
          (current
            ? "Start a fresh window deliberately with `sparkbtcbot reset-ledger`, then run set-policy again.\n"
            : "Nothing is sealed yet, so the file isn't protected: inspect it, delete it to start a fresh window, then run set-policy again.\n"),
      );
      exit(1);
    }
  }
  const n = ledger?.entries.length ?? 0;
  const ledgerNote = !ledger
    ? "leaving the spend ledger as it is"
    : ledger.state === "signed"
      ? "keeping the signed spend ledger (spends already in the window count against the new budgets)"
      : ledger.state === "missing"
        ? `and creating a signed spend ledger at ${ledgerPath}`
        : `and signing the existing spend ledger as it stands (${n} entr${n === 1 ? "y" : "ies"}; spends already in the window count)`;
  const summary = next
    ? `SEAL this policy into the encrypted seed (v2):\n${show(next)}\n${ledgerNote}`
    : "REMOVE the seed-bound policy (seed returns to v1; env-var budget semantics apply)";
  const confirm = (await promptStderr(`About to ${summary}.\nType 'yes' to proceed: `)).trim().toLowerCase();
  if (confirm !== "yes") { stderr.write("Aborted — nothing changed.\n"); exit(0); }

  // Atomic swap: the new blob replaces seed.enc in one rename — a crash leaves
  // either the old seed or the new one, never a partial file.
  await saveEncryptedMnemonic({ mnemonic: payload.mnemonic, passphrase, path: seedPath, policy: next, allowOverwrite: true });
  if (next) {
    if (ledger && ledger.state !== "signed") {
      // Re-read: a running agent may have appended to the unsigned ledger
      // since the look above; sign what is there now.
      const latest = await inspectLedgerForBinding({ path: ledgerPath, hmacKey });
      if (latest.state !== "signed") await initSignedLedger({ path: ledgerPath, hmacKey, entries: latest.entries });
      stderr.write(`Sealed. seed.enc rewritten (v2); signed spend ledger at ${ledgerPath} (${latest.entries.length} entr${latest.entries.length === 1 ? "y" : "ies"} carried over).\n`);
      stderr.write("Deleting or editing the ledger now fails closed; empty the window deliberately with `sparkbtcbot reset-ledger`.\n");
    } else {
      stderr.write(`Sealed. seed.enc rewritten (v2); spend ledger ${ledger ? "kept as it is" : "untouched"}.\n`);
    }
    if (next.exec) stderr.write(`Policy executable pinned: ${next.exec.path} sha256 ${next.exec.sha256}\n`);
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
