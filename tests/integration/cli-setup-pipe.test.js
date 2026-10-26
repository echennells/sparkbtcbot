// The CI path of setup: a passphrase piped on stdin still creates the seed, and
// a short one is still refused. It creates a wallet on hosted REGTEST, so it
// lives here, not in the offline unit tier (it moved out of
// tests/unit/cli-arg-gates.test.js; ToB review 2026-10-26).
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, rm, readdir } from "node:fs/promises";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "../../skills/sparkbtcbot/scripts");

describe("setup on a pipe, with a piped passphrase (REGTEST)", () => {
  const spawnSetup = (args, { stdinLines = null, env = {} } = {}) => new Promise(async (resolve) => {
    const dir = await mkdtemp(join(tmpdir(), "cli-pipe-"));
    const child = spawn("node", [join(SCRIPTS, "setup-encrypted-seed.js"), ...args], {
      cwd: dir,
      env: { ...process.env, SPARK_MNEMONIC: "", SPARK_NETWORK: "REGTEST", SPARK_PRIVACY: "off", SPARK_PASSPHRASE: "", SPARK_SEED_PATH: join(dir, "seed.enc"), ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.on("close", async (code) => {
      const files = await readdir(dir);
      await rm(dir, { recursive: true, force: true });
      resolve({ code, stdout, stderr, files });
    });
    if (stdinLines === null) child.stdin.end();            // EOF, nothing written
    else if (stdinLines.length) child.stdin.end(stdinLines.join("\n") + "\n");
    // stdinLines === [] → leave the pipe open and silent
  });

  it("a piped passphrase (the CI path) still creates the seed; a short one is still refused", async () => {
    const ok = await spawnSetup([], { stdinLines: ["correct horse battery staple", "correct horse battery staple"] });
    expect(ok.code).toBe(0);
    expect(ok.files).toEqual(["seed.enc"]);
    const short = await spawnSetup([], { stdinLines: ["short", "short"] });
    expect(short.code).toBe(1);
    expect(short.files).toEqual([]);
  }, 60_000);
});
