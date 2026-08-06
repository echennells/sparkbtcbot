// Docs lint: the install story is "one runtime" — sparkbtcbot-skill installed
// into the user's project, CLIs resolved LOCALLY. The banned pattern below
// (`npx -y --package=...`) was the old workaround: an unpinned registry fetch at
// wallet-bootstrap time that bypassed the user's lockfile and hardening policy.
// It was scrubbed from every doc on 2026-08-06; this lint keeps it from creeping
// back through copy-paste. Also pins the README Node badge to package.json's
// engines floor — they drifted once (badge said >=18 after engines moved to >=20).
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const DOCS = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "skills/sparkbtcbot/SKILL.md",
];

describe("docs lint", () => {
  it("no doc teaches the unpinned remote-npx fetch (npx -y --package=)", async () => {
    const refDir = join(ROOT, "skills/sparkbtcbot/references");
    const refs = (await readdir(refDir)).filter((f) => f.endsWith(".md")).map((f) => join("skills/sparkbtcbot/references", f));
    for (const rel of [...DOCS, ...refs, "skills/sparkbtcbot/evals/evals.json"]) {
      const text = await readFile(join(ROOT, rel), "utf8");
      expect(text.includes("npx -y --package"), `${rel} teaches the remote-fetch npx form — use local resolution (npm install sparkbtcbot-skill, then npx <cli>)`).toBe(false);
    }
  });

  it("README Node badge matches package.json engines floor", async () => {
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    const floor = pkg.engines.node.match(/\d+/)[0]; // ">=20" -> "20"
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    const badge = readme.match(/badge\/node-%E2%89%A5(\d+)/); // %E2%89%A5 = "≥"
    expect(badge, "README has no Node version badge").not.toBeNull();
    expect(badge[1], `README badge says Node >=${badge?.[1]} but engines says ${pkg.engines.node}`).toBe(floor);
  });

  it("clone instructions use npm ci, not npm install", async () => {
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    // Any code block that clones this repo must install with npm ci.
    const cloneBlocks = readme.split("```").filter((b) => b.includes("git clone") && b.includes("sparkbtcbot.git"));
    expect(cloneBlocks.length).toBeGreaterThan(0);
    for (const b of cloneBlocks) {
      expect(/npm ci/.test(b), `clone block installs without npm ci: ${b.slice(0, 120)}`).toBe(true);
      expect(/npm install\s*$/m.test(b), "clone block uses bare npm install").toBe(false);
      // Post-install verification: the offline unit suite doubles as an
      // install check (it asserts the installed SDK's surface/shapes).
      expect(/npm test/.test(b), "clone block skips the npm test verification step").toBe(true);
    }
  });
});
