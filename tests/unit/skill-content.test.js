import { describe, it, expect } from "vitest";
import {
  getSkillContent,
  getReference,
  listReferences,
  skillPath,
  referencesDir,
} from "../../lib/index.js";
import { statSync } from "node:fs";

describe("skill-content helpers", () => {
  it("skillPath points at an existing SKILL.md", () => {
    expect(skillPath).toMatch(/skills\/sparkbtcbot\/SKILL\.md$/);
    expect(statSync(skillPath).isFile()).toBe(true);
  });

  it("referencesDir points at an existing directory", () => {
    expect(referencesDir).toMatch(/skills\/sparkbtcbot\/references$/);
    expect(statSync(referencesDir).isDirectory()).toBe(true);
  });

  it("getSkillContent returns the full SKILL.md as a string", async () => {
    const content = await getSkillContent();
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(500);
    // SKILL.md is YAML-frontmatter + markdown; the frontmatter delimiter should be present
    expect(content.startsWith("---")).toBe(true);
  });

  it("listReferences returns only the basenames of .md files in references/", async () => {
    const names = await listReferences();
    expect(Array.isArray(names)).toBe(true);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      expect(name).not.toMatch(/\.md$/);
      expect(name).not.toMatch(/\//);
    }
  });

  it("listReferences includes the docs the README promises", async () => {
    const names = await listReferences();
    // Anti-drift: if any of these get renamed without updating the README,
    // catch it here rather than in a user's LLM prompt.
    const expected = [
      "agent-class",
      "architecture",
      "encrypted-seed",
      "extras",
      "l402",
      "lightning",
      "spark-invoices",
      "tokens",
      "wallet",
    ];
    for (const name of expected) {
      expect(names).toContain(name);
    }
  });

  it("getReference returns content for every name listReferences yields", async () => {
    const names = await listReferences();
    for (const name of names) {
      const doc = await getReference(name);
      expect(typeof doc).toBe("string");
      expect(doc.length).toBeGreaterThan(0);
    }
  });

  it("getReference throws ENOENT for unknown names", async () => {
    await expect(getReference("definitely-not-a-real-reference")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("getReference rejects path-traversal names", async () => {
    // Names come from LLM output — a crafted name must not escape referencesDir.
    const malicious = [
      "../../../package",
      "../../../../../../etc/hosts",
      "..\\..\\secret",
      "l402.md", // suffix is added by the helper; dots are not allowed
      "l402/extras",
      "",
    ];
    for (const name of malicious) {
      await expect(getReference(name)).rejects.toThrow(/Invalid reference name/);
    }
  });
});
