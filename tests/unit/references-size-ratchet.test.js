// The references load on demand, but an agent that opens one pays for all of
// it. Nothing watched their size until agent-class.md had grown to 250 KB, 210
// KB of it a copy of scripts/spark-agent.js that grew with every feature (cut
// 2026-11-09). Like SKILL.md's ratchet: one in, one out, or raise a cap
// deliberately, with the reason in the commit message.
import { describe, it, expect } from "vitest";
import { readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DIR = join(dirname(fileURLToPath(import.meta.url)), "../../skills/sparkbtcbot/references");
// 252 KB in all and 40 KB at most per file on 2026-11-09.
const MAX_TOTAL = 275_000;
const MAX_FILE = 45_000;

describe("references size ratchet", () => {
  it(`all references together stay under ${MAX_TOTAL} bytes, and each under ${MAX_FILE}`, async () => {
    const files = (await readdir(DIR)).filter((f) => f.endsWith(".md"));
    const sizes = await Promise.all(files.map(async (f) => [f, (await stat(join(DIR, f))).size]));
    const total = sizes.reduce((sum, [, size]) => sum + size, 0);
    const big = sizes.filter(([, size]) => size >= MAX_FILE).map(([f, size]) => `${f} (${size})`);
    expect(total, `references total ${total} bytes: move detail out or cut, or raise MAX_TOTAL deliberately`).toBeLessThan(MAX_TOTAL);
    expect(big, "a reference past the per-file cap: split it, or cut what an agent doesn't need").toEqual([]);
  });
});
