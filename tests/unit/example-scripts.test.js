// The example scripts are the files an agent copies, and the README says they
// open the wallet through SparkAgent — so a run carries the allowlist, budget,
// sealed policy, privacy setting, and leaf-vault. Until 2026-09 they booted the
// raw SDK: the same unguarded path the field test caught an agent building on.
// Pin both halves of the claim, plus the one-shot rule: each script exits after
// one pass, and booting alone claims pending inbound transfers in the
// background (a claim can start the leaf optimizer that cleanup() would then
// interrupt), so every SparkAgent.create() here turns optimization off.
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), "../../skills/sparkbtcbot/scripts");

const EXAMPLES = [
  "balance-and-deposits.js",
  "payment-flow.js",
  "token-operations.js",
  "l402-paywalls.js",
];

// Code lines only: comments in these files show calls that must not count.
const code = (text) =>
  text.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");

// spark-agent.js is the class itself; only its demo is an example.
async function exampleSource(name) {
  const text = await readFile(join(SCRIPTS, name), "utf8");
  return name === "spark-agent.js" ? text.slice(text.indexOf("// --- Demo ---")) : text;
}

describe("example scripts", () => {
  it.each(EXAMPLES)("%s boots through SparkAgent, not the raw SDK", async (name) => {
    const src = code(await exampleSource(name));
    expect(src, `${name} imports the raw SDK`).not.toMatch(/from\s+["']@buildonspark\/spark-sdk["']/);
    expect(src, `${name} calls SparkWallet directly`).not.toMatch(/\bSparkWallet\./);
    expect(src, `${name} never opens a SparkAgent`).toMatch(/\bSparkAgent\.create\(/);
  });

  it.each([...EXAMPLES, "spark-agent.js"])("%s opens the wallet with optimizeLeaves: false", async (name) => {
    const calls = code(await exampleSource(name)).match(/SparkAgent\.create\([^)]*\)/g) ?? [];
    expect(calls.length, `${name} has no SparkAgent.create() call`).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call, `${name}: a one-shot script must not race the leaf optimizer (references/wallet.md → Cleanup)`)
        .toMatch(/optimizeLeaves:\s*false/);
    }
  });
});
