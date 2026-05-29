import { describe, it, expect, afterEach } from "vitest";
import {
  loadRecipientsAllowlist,
  assertRecipientAllowed,
  DEFAULT_ALLOWLIST_PATH,
} from "../../lib/recipients-allowlist.js";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let toCleanUp = [];
afterEach(() => {
  for (const p of toCleanUp) {
    try { rmSync(p, { recursive: true, force: true }); } catch {}
  }
  toCleanUp = [];
});

function tmpDir() {
  const dir = mkdtempSync(join(tmpdir(), "spark-test-allow-"));
  toCleanUp.push(dir);
  return dir;
}

const SP_A = "sp1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqaaaaa";
const SP_B = "sp1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqbbbbb";
const SP_C = "sp1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqccccc";
const L1   = "bc1qexampledoesnotmatterherejustaformatcheckxxxxx";

describe("recipients-allowlist", () => {
  describe("DEFAULT_ALLOWLIST_PATH", () => {
    it("points at ~/.spark/recipients.allow", () => {
      expect(DEFAULT_ALLOWLIST_PATH).toMatch(/\.spark\/recipients\.allow$/);
    });
  });

  describe("loadRecipientsAllowlist", () => {
    it("returns null when the file does not exist", async () => {
      const path = join(tmpDir(), "nope.allow");
      expect(await loadRecipientsAllowlist({ path })).toBeNull();
    });

    it("returns null when the file is empty", async () => {
      const path = join(tmpDir(), "empty.allow");
      writeFileSync(path, "");
      expect(await loadRecipientsAllowlist({ path })).toBeNull();
    });

    it("returns null when the file contains only comments / blanks", async () => {
      // Treating an all-comment file as 'not enforced' matches operator
      // intent: someone setting up or temporarily disabling the gate
      // shouldn't accidentally block every send.
      const path = join(tmpDir(), "comments.allow");
      writeFileSync(path, "# header\n\n   # indented\n\n");
      expect(await loadRecipientsAllowlist({ path })).toBeNull();
    });

    it("returns the addresses, stripping inline comments and trimming whitespace", async () => {
      const path = join(tmpDir(), "with-entries.allow");
      writeFileSync(
        path,
        [
          "# Allowed recipients for the swap bot",
          "",
          `${SP_A}   # my exchange deposit`,
          `   ${SP_B}`,
          `${L1}#L1 cold storage (no space before #)`,
          "",
        ].join("\n"),
      );
      const list = await loadRecipientsAllowlist({ path });
      expect(list).toEqual([SP_A, SP_B, L1]);
    });

    it("propagates filesystem errors other than ENOENT", async () => {
      // Pointing at a directory (instead of a file) triggers EISDIR on
      // readFile; we should surface it rather than treating it as 'missing'.
      const dir = tmpDir();
      await expect(loadRecipientsAllowlist({ path: dir })).rejects.toThrow();
    });
  });

  describe("assertRecipientAllowed", () => {
    it("is a no-op when allowlist is null (not enforced)", () => {
      expect(() => assertRecipientAllowed(SP_A, null)).not.toThrow();
    });

    it("is a no-op when allowlist is undefined", () => {
      expect(() => assertRecipientAllowed(SP_A, undefined)).not.toThrow();
    });

    it("permits a destination that is in the allowlist", () => {
      expect(() => assertRecipientAllowed(SP_A, [SP_A, SP_B])).not.toThrow();
    });

    it("rejects a destination that is not in the allowlist with RECIPIENT_NOT_ALLOWED", () => {
      try {
        assertRecipientAllowed(SP_C, [SP_A, SP_B]);
        throw new Error("expected to throw");
      } catch (err) {
        expect(err.code).toBe("RECIPIENT_NOT_ALLOWED");
        expect(err.message).toContain(SP_C);
        expect(err.message).toContain("recipients.allow");
      }
    });

    it("rejects an empty / missing address with RECIPIENT_INVALID", () => {
      // Defensive: never silently 'pass' an empty destination through the
      // gate. If a caller forgot to provide `to`, the check should yell.
      for (const bad of ["", null, undefined, 42]) {
        try {
          assertRecipientAllowed(bad, [SP_A]);
          throw new Error(`expected to throw for ${bad}`);
        } catch (err) {
          expect(err.code).toBe("RECIPIENT_INVALID");
        }
      }
    });

    it("uses exact string match (no substring, no normalization)", () => {
      // Spark addresses are case-sensitive bech32m; we don't want
      // partial / case-insensitive matches creating surprise hits.
      const upper = SP_A.toUpperCase();
      expect(() => assertRecipientAllowed(upper, [SP_A])).toThrow(/not in the allowlist/);
      expect(() => assertRecipientAllowed(SP_A.slice(0, 10), [SP_A])).toThrow(/not in the allowlist/);
    });
  });
});
