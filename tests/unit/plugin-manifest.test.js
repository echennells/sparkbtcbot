import { describe, it, expect } from "vitest";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, "../../.claude-plugin/marketplace.json");

describe(".claude-plugin/marketplace.json", () => {
  // The Claude Code plugin marketplace ingests this file. If it breaks,
  // `claude plugin install` fails for end users. This test exists so a typo
  // surfaces in CI rather than in someone else's terminal.
  const raw = readFileSync(manifestPath, "utf8");
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    throw new Error(`marketplace.json is not valid JSON: ${e.message}`);
  }

  it("declares the marketplace name and owner", () => {
    expect(manifest.name).toBe("sparkbtcbot");
    expect(manifest.owner?.name).toBeTruthy();
  });

  it("lists at least one plugin with required fields", () => {
    expect(Array.isArray(manifest.plugins)).toBe(true);
    expect(manifest.plugins.length).toBeGreaterThan(0);
    for (const plugin of manifest.plugins) {
      expect(plugin.name).toBeTruthy();
      expect(plugin.description).toBeTruthy();
      expect(plugin.source).toBeTruthy();
      expect(Array.isArray(plugin.skills)).toBe(true);
      expect(plugin.skills.length).toBeGreaterThan(0);
    }
  });

  it("every referenced skill path resolves to a real SKILL.md", () => {
    const pkgRoot = join(here, "../..");
    for (const plugin of manifest.plugins) {
      for (const skillRelPath of plugin.skills) {
        const skillMdPath = join(pkgRoot, skillRelPath, "SKILL.md");
        expect(
          statSync(skillMdPath).isFile(),
          `expected ${skillMdPath} to exist (referenced from marketplace.json)`,
        ).toBe(true);
      }
    }
  });
});
