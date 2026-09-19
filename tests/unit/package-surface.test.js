// The published PACKAGE must expose every import the docs tell an agent to
// write. This is the regression test for the field-test finding that
// `import { SparkAgent } from "sparkbtcbot-skill/…"` had never worked: the
// exports map (added 2026-05-10) allow-listed three subpaths, the wrapper was
// not one of them, and nothing noticed for four months because every eval and
// every dogfood run happened in the cloned repo, where a relative import
// resolves regardless of the exports map.
//
// So this test does what a consumer does: `npm pack` the real tarball (the
// "files" whitelist decides what ships), unpack it into a scratch project as
// node_modules/sparkbtcbot-skill, and import — by PACKAGE NAME, from outside
// the repo — every specifier and every named symbol that appears in an
// `import { … } from "sparkbtcbot-skill…"` anywhere in the shipped docs. The
// expectations are DERIVED from the docs, so a reference that starts telling
// agents to import a new subpath or symbol fails here until the package
// actually exports it. It also runs the published CLI from the unpacked
// tarball, since the bin is part of the same surface.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, readdir, symlink, writeFile, readFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = createRequire(import.meta.url)(join(ROOT, "package.json"));

// Every `import { a, b } from "sparkbtcbot-skill[/sub]"` in the docs an agent reads.
async function documentedImports() {
  const files = [];
  const walk = async (dir) => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.name.endsWith(".md")) files.push(p);
    }
  };
  await walk(join(ROOT, "skills"));
  for (const f of ["README.md", "AGENTS.md"]) {
    try { await access(join(ROOT, f)); files.push(join(ROOT, f)); } catch { /* optional */ }
  }
  const spec = new Map();
  const re = /import\s*\{([^}]*)\}\s*from\s*"(sparkbtcbot-skill[^"]*)"/g;
  for (const f of files) {
    const text = await readFile(f, "utf8");
    for (const m of text.matchAll(re)) {
      const names = m[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
      if (!spec.has(m[2])) spec.set(m[2], new Set());
      for (const n of names) spec.get(m[2]).add(n);
    }
  }
  return spec;
}

let work;       // scratch "consumer project"
let installed;  // <work>/node_modules/sparkbtcbot-skill (the unpacked tarball)

beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "sbb-consumer-"));
  const nm = join(work, "node_modules");
  await mkdir(nm, { recursive: true });
  // 1. the REAL tarball — what `npm publish` would ship
  const { stdout } = await run("npm", ["pack", "--pack-destination", work, "--ignore-scripts", "--json"], { cwd: ROOT });
  const tarball = join(work, JSON.parse(stdout)[0].filename);
  // 2. unpack it where a consumer's install would put it
  installed = join(nm, pkg.name);
  await mkdir(installed, { recursive: true });
  await run("tar", ["-xzf", tarball, "--strip-components=1", "-C", installed]);
  // 3. the package's own dependencies: link the repo's node_modules entries
  //    beside it, so `@buildonspark/spark-sdk` etc. resolve exactly as they
  //    would after `npm install` — without a second 160-package install.
  for (const entry of await readdir(join(ROOT, "node_modules"))) {
    if (entry === pkg.name || entry === ".bin" || entry === ".package-lock.json") continue;
    await symlink(join(ROOT, "node_modules", entry), join(nm, entry), "dir");
  }
  await writeFile(join(work, "package.json"), JSON.stringify({ name: "consumer", type: "module", private: true }));
}, 120_000);

afterAll(async () => { if (work) await rm(work, { recursive: true, force: true }); });

describe("published package surface (npm pack → consumer import)", () => {
  it("the tarball ships the wrapper and the CLI (the files whitelist)", async () => {
    await access(join(installed, "skills/sparkbtcbot/scripts/spark-agent.js"));
    await access(join(installed, "skills/sparkbtcbot/scripts/cli.js"));
    await access(join(installed, "lib/index.js"));
  });

  it("every specifier and named symbol the docs tell an agent to import resolves from a consumer project", async () => {
    const spec = await documentedImports();
    expect(spec.size).toBeGreaterThanOrEqual(3); // ".", "/agent", "/leaf-vault" at minimum
    const probe = join(work, "probe.mjs");
    const lines = [];
    for (const [specifier, names] of spec) {
      lines.push(`{ let m; try { m = await import(${JSON.stringify(specifier)}); } catch (e) { out[${JSON.stringify(specifier)}] = { error: e.code ?? String(e) }; }
        if (m) out[${JSON.stringify(specifier)}] = { missing: ${JSON.stringify([...names])}.filter((n) => typeof m[n] === "undefined") }; }`);
    }
    await writeFile(probe, `const out = {};\n${lines.join("\n")}\nprocess.stdout.write("\\n__PROBE__" + JSON.stringify(out));\n`);
    const { stdout } = await run("node", [probe], { cwd: work, env: { ...process.env, SPARK_LEAF_VAULT: "off" } });
    const out = JSON.parse(stdout.slice(stdout.lastIndexOf("__PROBE__") + "__PROBE__".length));
    const problems = Object.entries(out)
      .filter(([, r]) => r.error || r.missing.length)
      .map(([s, r]) => `${s}: ${r.error ? `does not resolve (${r.error})` : `missing exports ${r.missing.join(", ")}`}`);
    expect(problems, `docs promise imports the published package does not provide:\n  ${problems.join("\n  ")}`).toEqual([]);
  }, 60_000);

  it("the published CLI runs from the unpacked tarball", async () => {
    const { stdout } = await run("node", [join(installed, "skills/sparkbtcbot/scripts/cli.js"), "--help"], { cwd: work });
    expect(stdout).toMatch(/Usage: sparkbtcbot <command>/);
    for (const cmd of ["setup", "set-policy", "rekey", "rotate", "reveal-mnemonic"]) expect(stdout).toContain(`sparkbtcbot ${cmd}`);
  });
});
