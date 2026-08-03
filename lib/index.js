// Public entry point for `npm install sparkbtcbot-skill`.
//
// Two flavors of export:
//   1. The encryption library (saveEncryptedMnemonic, loadMnemonic, etc.)
//      Used by code an LLM agent generates when it needs a Spark wallet.
//   2. Skill-content helpers (getSkillContent, getReference, ...) for
//      non-Claude LLM frameworks (Cursor, LangChain, OpenAI Agents SDK,
//      Aider, etc.) — load the skill's instructions into the LLM's
//      context however your framework supports it.
//
// Claude Code users do NOT need to npm-install this. They use the plugin
// marketplace path documented in the README. This package is for everyone
// else.

import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

// --- 1. Encryption library re-exports ---
export {
  saveEncryptedMnemonic,
  loadMnemonic,
  loadEncryptedMnemonic,
  loadMnemonicFromEnv,
  writeMnemonicBackupFile,
  DEFAULT_SEED_PATH,
} from "./encrypted-seed.js";

// --- 1b. Recipient allowlist helpers (opt-in guardrail) ---
export {
  loadRecipientsAllowlist,
  assertRecipientAllowed,
  DEFAULT_ALLOWLIST_PATH,
} from "./recipients-allowlist.js";

// --- 2. Skill-content helpers ---

// Resolve paths to the bundled skill files. Works whether the package was
// installed to node_modules/sparkbtcbot-skill or symlinked via `npm link`.
const PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

export const skillPath = join(PKG_ROOT, "skills/sparkbtcbot/SKILL.md");
export const referencesDir = join(PKG_ROOT, "skills/sparkbtcbot/references");

// Returns the always-loaded skill body as a string.
// Pass to your LLM framework's system-prompt / context-injection mechanism.
export async function getSkillContent() {
  return await readFile(skillPath, "utf8");
}

// Returns a specific reference doc by name (without the .md extension).
// Example: getReference("encrypted-seed") → contents of references/encrypted-seed.md
//
// The name typically comes from LLM output, so treat it as untrusted:
// restrict it to the actual naming scheme (lowercase letters, digits,
// hyphens) so a crafted name can't traverse out of referencesDir and read
// arbitrary .md files elsewhere on disk.
export async function getReference(name) {
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(`Invalid reference name: ${JSON.stringify(name)}`);
  }
  return await readFile(join(referencesDir, `${name}.md`), "utf8");
}

// Returns the names of all reference docs (without .md extension).
// Useful for "tools/dynamic loading" patterns where the agent decides which
// reference to load based on the user's task.
export async function listReferences() {
  const entries = await readdir(referencesDir);
  return entries
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}
