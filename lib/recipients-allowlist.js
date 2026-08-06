// Optional outbound-recipient allowlist for Spark wallet agents.
//
// EXPORTS:
//   loadRecipientsAllowlist({ path? }) → string[] | null
//   assertRecipientAllowed(address, allowlist)
//   DEFAULT_ALLOWLIST_PATH
//
// File format: one address per line. `#` starts a comment to end-of-line.
// Blank lines and whitespace are ignored. Both Spark addresses (`sp1...`)
// and L1 Bitcoin addresses live in the same file — the gate is a pure
// string-match, not address-type aware.
//
// Enforcement is **opt-in by file presence**:
//   - File missing                  → loadRecipientsAllowlist() returns null
//   - File present but empty / all  → null (treated as "not enforced")
//     comments
//   - File present with ≥1 entry    → returns those entries; sends to any
//                                     address not in the list MUST fail
//
// Bypass = edit the file. That's the entire threat model: this is a
// guardrail against the agent surprising the operator, NOT a defense
// against a compromised agent (which can rewrite the file). No hard-enforced
// spending control exists on this path — the funded balance is the only
// limit that survives compromise.
//
// Read-on-each-call (no caching). The file is tiny and the cost is dwarfed
// by the network roundtrip to Spark — making edits take effect without an
// agent restart is worth the few extra syscalls.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_ALLOWLIST_PATH = join(homedir(), ".spark", "recipients.allow");

export async function loadRecipientsAllowlist({ path } = {}) {
  const allowPath = path ?? DEFAULT_ALLOWLIST_PATH;
  let raw;
  try {
    raw = await readFile(allowPath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }

  const entries = raw
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0);

  // Empty file or all-comments file → treat as not-enforced. Operator who
  // wanted enforcement would have put at least one address in the file;
  // a zero-entry file most likely means "I'm setting this up" or "I
  // commented everything out to disable."
  if (entries.length === 0) return null;

  return entries;
}

export function assertRecipientAllowed(address, allowlist) {
  // Null allowlist = not enforced. Don't throw.
  if (allowlist === null || allowlist === undefined) return;

  if (typeof address !== "string" || !address) {
    const e = new Error("recipient address is required for allowlist check");
    e.code = "RECIPIENT_INVALID";
    throw e;
  }

  if (!allowlist.includes(address)) {
    const e = new Error(
      `Recipient ${address} is not in the allowlist. ` +
        `Add it to ${DEFAULT_ALLOWLIST_PATH} (one address per line) to permit this send.`,
    );
    e.code = "RECIPIENT_NOT_ALLOWED";
    throw e;
  }
}
