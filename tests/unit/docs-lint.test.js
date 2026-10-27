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
      expect(text.includes("npx -y --package"), `${rel} teaches the remote-fetch npx form — use local resolution (npm install --ignore-scripts sparkbtcbot-skill, then npm exec --no -- sparkbtcbot <command>)`).toBe(false);
    }
  });

  it("nothing tells the user to run a subcommand through bare npx or npm exec without --no", async () => {
    // `npx sparkbtcbot <command>` falls back to a registry fetch when the local
    // bin is missing (wrong directory), and with no TTY it installs and runs
    // silently. `npm exec` without `--no` is the same thing, and `-y`,
    // `sparkbtcbot-skill` or an `@version` make the fetch explicit. The taught
    // form is `npm exec --no -- sparkbtcbot <command>`. Runtime error messages
    // count: an agent copies the command a thrown error hands it. Prose that
    // explains the bare form (`npx sparkbtcbot ...`) is fine; a subcommand or
    // `<command>` placeholder after it is the instruction this catches.
    const BARE = /\b(?:npx|npm\s+(?:exec|x))\s+(?:(?!--no\b)-\S+\s+)*(?:--\s+)?sparkbtcbot(?:-skill)?(?:@\S+)?\s+[<a-z]/i;
    const refDir = join(ROOT, "skills/sparkbtcbot/references");
    const refs = (await readdir(refDir)).filter((f) => f.endsWith(".md")).map((f) => join("skills/sparkbtcbot/references", f));
    const code = [];
    for (const dir of ["lib", "skills/sparkbtcbot/scripts"]) {
      const files = (await readdir(join(ROOT, dir))).filter((f) => /\.(js|d\.ts)$/.test(f));
      code.push(...files.map((f) => join(dir, f)));
    }
    for (const rel of [...DOCS, "SECURITY.md", ...refs, "skills/sparkbtcbot/evals/evals.json", ...code]) {
      const text = await readFile(join(ROOT, rel), "utf8");
      const hit = text.match(BARE);
      expect(hit, `${rel} has \`${hit?.[0]}…\` — use \`npm exec --no -- sparkbtcbot <command>\``).toBeNull();
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

  it("every file README links relatively is shipped in the npm package", async () => {
    // AGENTS.md is linked as required pre-flight reading for AI agents but was
    // missing from `files` — npm consumers got a 404 on the doc that carries
    // the never-echo-passphrase rules. Any ./-relative README link must resolve
    // inside the published tarball.
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    const links = [...readme.matchAll(/\]\(\.\/([^)#]+)\)/g)].map((m) => m[1]);
    expect(links.length).toBeGreaterThan(0);
    for (const rel of links) {
      const shipped = pkg.files.some((f) => (f.endsWith("/") ? rel.startsWith(f) : rel === f));
      expect(shipped, `README links ./${rel} but package.json "files" doesn't ship it — npm consumers get a broken link`).toBe(true);
    }
  });

  it("no living doc references the retired per-command bins", async () => {
    // 0.6 collapsed five bins (sparkbtcbot-setup, ...) into one `sparkbtcbot`
    // dispatcher whose name matches a registry package we own. The old names
    // are owned too (0.6.3 published refusing stubs for them), but a doc that
    // resurrects one still teaches a command that no longer exists and sends
    // readers to the registry for it. (CHANGELOG is history and exempt.)
    const RETIRED = ["sparkbtcbot-setup", "sparkbtcbot-reveal-mnemonic", "sparkbtcbot-leaf-vault", "sparkbtcbot-set-policy", "sparkbtcbot-reset-ledger"];
    const refDir = join(ROOT, "skills/sparkbtcbot/references");
    const refs = (await readdir(refDir)).filter((f) => f.endsWith(".md")).map((f) => join("skills/sparkbtcbot/references", f));
    for (const rel of [...DOCS, ...refs, "skills/sparkbtcbot/evals/evals.json"]) {
      const text = await readFile(join(ROOT, rel), "utf8");
      for (const name of RETIRED) {
        expect(text.includes(name), `${rel} references retired bin ${name} — use \`sparkbtcbot ${name.replace("sparkbtcbot-", "")}\``).toBe(false);
      }
    }
  });

  it("every SDK install pin in the docs admits the version package.json ships", async () => {
    // The SDK bump to 0.14 left SKILL.md teaching `spark-sdk@^0.12.0`, and a
    // caret on 0.x allows patch releases only, so a reader got 0.12 and none
    // of the upgrade. Found by an eval, not a review.
    const pkg = JSON.parse(await readFile(join(ROOT, "package.json"), "utf8"));
    const caretAdmits = (range, version) => {
      const [a, b, c] = range.split(".").map(Number);
      const [x, y, z] = version.split(".").map(Number);
      if (a > 0) return x === a && (y > b || (y === b && z >= c));
      if (b > 0) return x === 0 && y === b && z >= c;
      return x === 0 && y === 0 && z === c;
    };
    const refDir = join(ROOT, "skills/sparkbtcbot/references");
    const refs = (await readdir(refDir)).filter((f) => f.endsWith(".md")).map((f) => join("skills/sparkbtcbot/references", f));
    let pins = 0;
    for (const rel of [...DOCS, ...refs]) {
      const text = await readFile(join(ROOT, rel), "utf8");
      for (const [, name, range] of text.matchAll(/(@buildonspark\/[a-z-]+)@\^(\d+\.\d+\.\d+)/g)) {
        pins++;
        const shipped = pkg.dependencies[name];
        expect(shipped, `${rel} pins ${name}, which package.json doesn't depend on`).toBeTruthy();
        expect(caretAdmits(range, shipped), `${rel} teaches ${name}@^${range}, which can't install the ${shipped} that package.json ships`).toBe(true);
      }
    }
    expect(pins).toBeGreaterThan(0);
  });

  it("README's listReferences() example names every shipped reference", async () => {
    // The example drifted to 12 names while 16 shipped — the four missing ones
    // were the merchant-purchase docs for a headline capability.
    const refDir = join(ROOT, "skills/sparkbtcbot/references");
    const names = (await readdir(refDir)).filter((f) => f.endsWith(".md")).map((f) => f.replace(/\.md$/, ""));
    const readme = await readFile(join(ROOT, "README.md"), "utf8");
    for (const name of names) {
      expect(readme.includes(`'${name}'`), `references/${name}.md exists but the README listReferences() example doesn't list '${name}'`).toBe(true);
    }
  });
});
