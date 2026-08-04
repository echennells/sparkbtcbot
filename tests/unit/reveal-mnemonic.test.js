// reveal-mnemonic replaced the persistent MNEMONIC_BACKUP_*.txt plaintext file.
// Its load-bearing safety property: it REFUSES to print the seed when stdout is
// not a TTY — i.e. when an AI agent runs it over a Bash tool and captures the
// output. These tests spawn the real script with piped stdio (isTTY=false) and
// assert it aborts without printing, before it ever touches the seed file.
import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const run = promisify(execFile);
const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), "../../skills/sparkbtcbot/scripts/reveal-mnemonic.js");

const exec = (env = {}) =>
  run("node", [SCRIPT], { env: { ...process.env, ...env } }).then(
    (r) => ({ code: 0, ...r }),
    (e) => ({ code: e.code, stdout: e.stdout ?? "", stderr: e.stderr ?? "" }),
  );

describe("reveal-mnemonic non-interactive refusal", () => {
  it("refuses (exit 3) and prints NOTHING to stdout when stdout is not a TTY", async () => {
    // piped stdio under execFile => stdout.isTTY is false, the agent-capture case
    const r = await exec({ SPARK_PASSPHRASE: "correcthorsebatterystaple", SPARK_SEED_PATH: "/nonexistent/seed.enc" });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/refusing to print your seed phrase to a non-interactive session/i);
    expect(r.stdout).toBe(""); // no seed material on stdout, ever
  });

  it("refuses BEFORE reading the seed file (a missing seed still yields the TTY refusal, not a decrypt error)", async () => {
    const r = await exec({ SPARK_SEED_PATH: "/nonexistent/seed.enc" });
    expect(r.code).toBe(3);
    expect(r.stderr).not.toMatch(/decrypt|No encrypted seed/i); // gate fires first
  });
});
