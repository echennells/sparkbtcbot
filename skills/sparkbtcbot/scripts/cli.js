#!/usr/bin/env node
// Single CLI entry point: `sparkbtcbot <command>`.
//
// One bin whose name matches an npm name this project OWNS (the `sparkbtcbot`
// stub package reserves it on the registry — see stub/sparkbtcbot/) — so a
// wrong-directory `npx sparkbtcbot ...` registry fallback lands on OUR code,
// never a squatter's. The 0.4.x–0.5.x per-command bins (sparkbtcbot-setup,
// sparkbtcbot-reveal-mnemonic, ...) were five unregistered registry names,
// each a separate hostile landing spot for that fallback.
//
// One argument gate, no default action: an unknown or missing command cannot
// fall through to anything (the 0.4.3 --help-minted-a-wallet class of bug).
// A subcommand module is imported ONLY after its name validates, and every
// module is inert on import — the dispatcher calls its exported main() exactly
// once.
import { stdout, stderr, exit } from "node:process";
import { pathToFileURL } from "node:url";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";

export const COMMANDS = {
  "setup":           { module: "./setup-encrypted-seed.js", summary: "one-time wallet bootstrap — encrypt a new/imported mnemonic to seed.enc" },
  "reveal-mnemonic": { module: "./reveal-mnemonic.js",      summary: "display the seed phrase once for offline backup (USER-run, TTY only)" },
  "leaf-vault":      { module: "./leaf-vault-cli.js",       summary: "unilateral-exit recovery bundle: snapshot, or `verify`" },
  "set-policy":      { module: "./set-policy.js",           summary: "bind/change/remove the seed-bound spending budget (operator ceremony)" },
  "reset-ledger":    { module: "./reset-ledger.js",         summary: "write a fresh signed spend ledger — the legitimate reset (operator ceremony)" },
  "viewer":          { module: "./viewer-key.js",           summary: "read-only access to a PRIVATE wallet without its seed: status, grant, revoke, pubkey, balance" },
};

export function usage() {
  const rows = Object.entries(COMMANDS)
    .map(([name, c]) => `  sparkbtcbot ${name.padEnd(16)} ${c.summary}`)
    .join("\n");
  return (
    "Usage: sparkbtcbot <command> [args]\n\n" +
    rows + "\n" +
    "  sparkbtcbot help             show this list\n" +
    "  sparkbtcbot version          print the package version\n\n" +
    "Command-specific flags go after the command (`sparkbtcbot setup --import`,\n" +
    "`sparkbtcbot <command> --help`).\n"
  );
}

export async function main() {
  const cmd = process.argv[2];
  if (cmd === undefined) {
    stderr.write(usage());
    exit(1);
  }
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    stdout.write(usage());
    exit(0);
  }
  if (cmd === "version" || cmd === "--version") {
    stdout.write(createRequire(import.meta.url)("../../../package.json").version + "\n");
    exit(0);
  }
  // hasOwn, not COMMANDS[cmd]: a plain-object lookup walks the prototype chain,
  // so `sparkbtcbot constructor` / `toString` / `__proto__` returned a truthy
  // non-entry and fell through to `import(undefined)` — a crash instead of the
  // usage message, in the one gate that promises no fall-through.
  const entry = Object.hasOwn(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
  if (!entry) {
    stderr.write(`sparkbtcbot: unknown command "${cmd}"\n\n` + usage());
    exit(2);
  }
  // Drop the command token so the module's own arg gate sees exactly its flags
  // at argv[2+]. argv[1] stays this file, so the modules' direct-run guards do
  // NOT fire on import — main() below is the single invocation.
  process.argv.splice(2, 1);
  const mod = await import(entry.module);
  await mod.main();
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
    stderr.write(`sparkbtcbot: ${e?.message ?? e}\n`);
    exit(1);
  });
}
