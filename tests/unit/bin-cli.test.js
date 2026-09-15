// The Claude Code plugin path ships sources with NO node_modules, and the
// plugin cache is wiped on update — so setup/reveal/leaf-vault/set-policy/
// reset-ledger must be runnable via the published package's single bin
// (`npm exec --no -- sparkbtcbot <command>` from the project where
// sparkbtcbot-skill is installed). Since 0.6.0 that is ONE bin, `sparkbtcbot`,
// whose name matches an npm package this project owns (the stub/sparkbtcbot
// reservation) — so a wrong-directory npx registry fallback lands on our code,
// never a squatter's. These tests pin the wiring: the bin entry, the dispatcher
// COMMANDS map, every target's existence + shebang, inert-on-import modules
// with an exported main() (a dispatcher import that silently no-ops would ship
// a setup that "succeeds" without creating a wallet), and files-whitelist
// coverage. Losing any of these strands plugin users with no runnable setup
// and no user-executable seed backup.
import { describe, it, expect } from "vitest";
import { readFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const SCRIPTS = join(ROOT, "skills/sparkbtcbot/scripts");
const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));

const CLI_REL = "skills/sparkbtcbot/scripts/cli.js";
const { COMMANDS } = await import(pathToFileURL(join(ROOT, CLI_REL)).href);

describe("published CLI (plugin-path lifeline)", () => {
  it("declares exactly one bin: sparkbtcbot -> the dispatcher", () => {
    expect(pkg.bin).toEqual({ sparkbtcbot: CLI_REL });
  });

  it("the bin name matches a package name this project owns (the registry stub)", async () => {
    // The whole point of the single-bin design: `npx sparkbtcbot` in the wrong
    // directory falls back to the registry package `sparkbtcbot`, which must be
    // ours. The stub lives in-repo; publishing it is a one-time manual step.
    const stub = JSON.parse(await readFile(join(ROOT, "stub/sparkbtcbot/package.json"), "utf8"));
    expect(stub.name).toBe(Object.keys(pkg.bin)[0]);
    await access(join(ROOT, "stub/sparkbtcbot/cli.js"));
  });

  it("dispatcher covers the five ceremonies plus viewer", () => {
    expect(Object.keys(COMMANDS).sort()).toEqual(
      ["leaf-vault", "reset-ledger", "reveal-mnemonic", "set-policy", "setup", "viewer"],
    );
  });

  for (const rel of [CLI_REL]) {
    it(`${rel}: exists and carries the node shebang`, async () => {
      const firstLine = (await readFile(join(ROOT, rel), "utf8")).split("\n", 1)[0];
      expect(firstLine).toBe("#!/usr/bin/env node");
    });
  }

  it("every COMMANDS target exists, has the shebang, is inert on import, and exports main()", async () => {
    for (const [name, entry] of Object.entries(COMMANDS)) {
      const p = join(SCRIPTS, entry.module);
      await access(p); // throws if missing
      const firstLine = (await readFile(p, "utf8")).split("\n", 1)[0];
      expect(firstLine, `${name} target missing shebang`).toBe("#!/usr/bin/env node");
      // Import must be a no-op (no TTY gate firing, no prompts, no side
      // effects) and must expose main for the dispatcher to call — the
      // "silent no-op setup" failure mode is a module whose guard swallows
      // the dispatcher call path.
      const mod = await import(pathToFileURL(p).href);
      expect(typeof mod.main, `${name} module does not export main()`).toBe("function");
    }
  });

  it("bin target and command modules are inside the published files whitelist", () => {
    // Every target must be covered by package.json "files" (or there is no
    // whitelist and everything ships). A bin pointing at an unpublished file
    // installs a broken symlink for every consumer.
    if (!pkg.files) return; // no whitelist -> everything ships
    const rels = [CLI_REL, ...Object.values(COMMANDS).map((c) => join("skills/sparkbtcbot/scripts", c.module))];
    for (const rel of rels) {
      const covered = pkg.files.some((f) => rel === f || rel.startsWith(f.replace(/\/$/, "") + "/"));
      expect(covered, `${rel} not covered by files: ${JSON.stringify(pkg.files)}`).toBe(true);
    }
  });
});
