// The Claude Code plugin path ships sources with NO node_modules, and the
// plugin cache is wiped on update — so setup/reveal/leaf-vault must be runnable
// via the published package's bin commands (npx -y --package=sparkbtcbot-skill
// sparkbtcbot-setup, etc.). That's the one supported answer SKILL.md gives
// plugin/npm users. These tests pin the wiring: bin entries present, targets
// exist, and each target has the shebang npm requires to make it executable.
// Losing any of these silently strands plugin users with no runnable setup and
// no user-executable seed backup.
import { describe, it, expect } from "vitest";
import { readFile, access } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));

const EXPECTED = {
  "sparkbtcbot-setup": "skills/sparkbtcbot/scripts/setup-encrypted-seed.js",
  "sparkbtcbot-reveal-mnemonic": "skills/sparkbtcbot/scripts/reveal-mnemonic.js",
  "sparkbtcbot-leaf-vault": "skills/sparkbtcbot/scripts/leaf-vault-cli.js",
};

describe("published CLI (plugin-path lifeline)", () => {
  it("declares all three bin commands with the expected targets", () => {
    expect(pkg.bin).toEqual(EXPECTED);
  });

  for (const [cmd, rel] of Object.entries(EXPECTED)) {
    it(`${cmd}: target exists and carries the node shebang`, async () => {
      const p = join(ROOT, rel);
      await access(p); // throws if missing
      const firstLine = (await readFile(p, "utf8")).split("\n", 1)[0];
      expect(firstLine).toBe("#!/usr/bin/env node");
    });
  }

  it("bin targets are inside the published files whitelist", () => {
    // Every target must be covered by package.json "files" (or there is no
    // whitelist and everything ships). A bin pointing at an unpublished file
    // installs a broken symlink for every consumer.
    if (!pkg.files) return; // no whitelist -> everything ships
    for (const rel of Object.values(EXPECTED)) {
      const covered = pkg.files.some((f) => rel === f || rel.startsWith(f.replace(/\/$/, "") + "/"));
      expect(covered, `${rel} not covered by files: ${JSON.stringify(pkg.files)}`).toBe(true);
    }
  });
});
