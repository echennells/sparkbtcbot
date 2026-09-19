#!/usr/bin/env node
// Forwarder for the real CLI.
//
// This package exists to own the short name `sparkbtcbot` so a squatter cannot
// have it. It used to REFUSE and print instructions, which meant
// `npm install sparkbtcbot` succeeded silently and the user only discovered
// the mistake when they ran it — and the message then blamed a
// wrong-directory npx fallback, which is not what a deliberate install is.
// Forwarding is simply the better outcome: the short name works.
//
// WHY A PINNED DEPENDENCY, NOT A RANGE.
//
// A caret or `*` would let `npx sparkbtcbot` pull a skill version this
// forwarder has never been tested against, resolved at install time, into a
// process that handles seed material. That is the unpinned-resolution problem
// this project's own supply-chain rules exist to prevent, and it would be
// inconsistent to accept it here. The cost is that this package needs a
// version bump and a `publish-stub` run whenever it should track a new skill
// release. Deliberate: a forwarder that silently follows is worse than one
// that lags visibly.
//
// WHY SPAWN RATHER THAN IMPORT.
//
// sparkbtcbot-skill is ESM; this forwarder stays CommonJS so `require.resolve`
// can locate the dependency's manifest regardless of loader differences. We
// then run its real bin with the current node binary, inheriting stdio so TTY
// detection in the wallet commands (`reveal-mnemonic` is TTY-only) behaves
// exactly as it would when invoked directly.
"use strict";

const { spawnSync } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");

// FIND THE PACKAGE ON DISK, NOT THROUGH `exports`.
//
// require.resolve("sparkbtcbot-skill/package.json") FAILS: the skill's
// exports map lists ".", "./leaf-vault" and "./leaf-vault/core", and modern
// node enforces that encapsulation — an unlisted subpath is refused even for
// the manifest. require.resolve("sparkbtcbot-skill") is no better here, since
// the "." export offers only an "import" condition.
//
// So walk the node_modules search paths node would use and read the manifest
// as a plain file. A filesystem read is not subject to exports.
function findSkillManifest() {
  const roots = require.resolve.paths("sparkbtcbot-skill") || [];
  for (const root of roots) {
    const candidate = path.join(root, "sparkbtcbot-skill", "package.json");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

let cliPath;
try {
  const manifestPath = findSkillManifest();
  if (!manifestPath) throw new Error("sparkbtcbot-skill is not installed alongside this package");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const bin = manifest.bin;
  const rel = typeof bin === "string" ? bin : bin && bin.sparkbtcbot;
  if (!rel) throw new Error("sparkbtcbot-skill declares no `sparkbtcbot` bin");
  cliPath = path.join(path.dirname(manifestPath), rel);
} catch (err) {
  process.stderr.write(
    "sparkbtcbot: could not locate the real CLI (sparkbtcbot-skill).\n\n" +
      `  ${err && err.message ? err.message : err}\n\n` +
      "This package forwards to sparkbtcbot-skill. If you are seeing this, the\n" +
      "dependency is missing or the install was interrupted. Install the real\n" +
      "package directly:\n\n" +
      "  npm install sparkbtcbot-skill\n" +
      "  npx sparkbtcbot <command>\n\n" +
      "https://github.com/echennells/sparkbtcbot\n",
  );
  process.exit(1);
}

const r = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  stdio: "inherit",
});
// Preserve signal deaths as the conventional 128+n rather than reporting 0.
if (r.signal) process.exit(1);
process.exit(r.status === null ? 1 : r.status);
