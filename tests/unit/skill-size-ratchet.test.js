// SKILL.md is ALWAYS-LOADED once the skill triggers — every byte here is a
// context tax on every wallet conversation. The body doubled over a month of
// individually-justified additions before the 2026-08-06 diet trimmed it back
// (~10.0k -> ~9.0k tokens; informational detail moved to references/). This
// ratchet stops silent regrowth: adding always-on prose must displace or
// compress something else ("one in, one out"), or consciously raise the cap in
// this file WITH justification in the commit message. New incident fixes
// default to a reference + a one-line body pointer; body placement is earned
// (e.g. by an eval showing agents skip the reference), not default.
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const SKILL = join(dirname(fileURLToPath(import.meta.url)), "../../skills/sparkbtcbot/SKILL.md");

// Current size ~35.9KB (~9.0k tokens). Cap set with ~6% headroom for normal
// editing churn — raising it is a deliberate act, not a drive-by.
const MAX_BYTES = 38_000;

describe("SKILL.md size ratchet", () => {
  it(`always-loaded body stays under ${MAX_BYTES} bytes (one in, one out)`, async () => {
    const size = Buffer.byteLength(await readFile(SKILL, "utf8"));
    expect(size, `SKILL.md is ${size} bytes — over the ratchet. Move detail to references/ (leave a one-line pointer) or compress elsewhere; raise MAX_BYTES only deliberately, with justification.`).toBeLessThan(MAX_BYTES);
  });
});
