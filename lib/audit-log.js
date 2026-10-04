// Append-only audit log of every policy decision and money-moving outcome:
// one JSON object per line at ~/.spark/audit.jsonl (SPARK_AUDIT_LOG_PATH to
// relocate, SPARK_AUDIT_LOG=off to disable). This is the "what did my agent
// do" file — receives are not here (the wallet's transfer list has those);
// every ATTEMPTED spend is, including denials and SDK failures.
//
// Records MUST NOT contain secrets — passphrases, mnemonics, preimages, raw
// invoices (a BOLT11 can carry a description), tokens. append() enforces the
// obvious key names as a backstop; the real guarantee is that callers build
// entries from the PolicyContext, which never held a secret to begin with.
// Free text is the gap in that guarantee: an SDK error message quotes the
// invoice it failed on ('… [invoice: lnbc…]'), so append() also cuts any
// invoice-shaped string out of every string value (redactInvoices).
//
// Trust boundary, same as everything under ~/.spark: the file is 0600 and
// appended with O_APPEND, which stops interleaving and accidental truncation,
// not an agent that edits it. The audit log is evidence for the operator, not
// a control.

import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export const DEFAULT_AUDIT_LOG_PATH = join(homedir(), ".spark", "audit.jsonl");

const FORBIDDEN_KEYS = /^(mnemonic|passphrase|seed|preimage|paymentPreimage|bolt11|invoice|macaroon|token|apiKey|privateKey)$/i;

// bech32 data characters (no 1, b, i, o). A BOLT11 (or LNURL) is ln + its
// network and amount, then data; a Spark invoice is a Spark address carrying
// invoice fields, so longer than any bare address (62 data characters),
// which stay: the log names payees by address. The SDK still decodes the
// legacy Spark prefixes (sp1, spt1, sprt1, sps1, spl1), so those count too.
const INVOICE_RES = [/\b(ln[a-z]{2,6}[0-9]*[munp]?1)[02-9ac-hj-np-z]{50,}/gi, /\b(sp(?:ark)?[a-z]{0,2}1)[02-9ac-hj-np-z]{90,}/gi];

// `text` with every invoice-shaped run cut to its prefix: the network and
// amount stay readable, the payment hash and description don't.
export function redactInvoices(text) {
  if (typeof text !== "string") return text;
  return INVOICE_RES.reduce((t, re) => t.replace(re, (_, prefix) => `${prefix}…[redacted]`), text);
}

function assertNoSecrets(value, path = "entry") {
  if (value == null || typeof value !== "object") return;
  for (const [k, v] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.test(k)) {
      throw new Error(`audit-log: refusing to write key "${path}.${k}" — audit records must not contain secrets`);
    }
    assertNoSecrets(v, `${path}.${k}`);
  }
}

export function createAuditLog({ path = DEFAULT_AUDIT_LOG_PATH, clock = Date.now } = {}) {
  let dirReady = null;
  return {
    path,
    async append(entry) {
      if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("audit-log: entry must be a plain object");
      }
      assertNoSecrets(entry);
      const line = JSON.stringify({ ts: new Date(clock()).toISOString(), ...entry }, (_, v) => redactInvoices(v)) + "\n";
      dirReady ??= mkdir(dirname(path), { recursive: true, mode: 0o700 });
      await dirReady;
      await appendFile(path, line, { mode: 0o600, flag: "a" });
    },
  };
}

// null when opted out via SPARK_AUDIT_LOG=off/false/0/no.
export function auditLogFromEnv() {
  const flag = String(process.env.SPARK_AUDIT_LOG ?? "").trim().toLowerCase();
  if (["off", "false", "0", "no"].includes(flag)) return null;
  return createAuditLog({ path: process.env.SPARK_AUDIT_LOG_PATH || undefined });
}
