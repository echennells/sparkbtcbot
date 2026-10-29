// lib/spending-limits.js on its own: strict validation (a typo is never "no
// limit"), fail-closed reads, and which changes count as looser.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateLimits, readLimits, writeLimits, checkLimits, limitsChanges } from "../../lib/spending-limits.js";

let dir;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "spending-limits-")); });
afterEach(() => rm(dir, { recursive: true, force: true }));

describe("validateLimits", () => {
  it("normalizes, and treats no rule as no limits", () => {
    expect(validateLimits({ allowedOps: ["lightning_pay", "lightning_pay"], allowedRecipients: [" a "] }))
      .toEqual({ allowedOps: ["lightning_pay"], allowedRecipients: ["a"] });
    expect(validateLimits({})).toBeNull();
    expect(validateLimits(null)).toBeNull();
  });

  it("refuses unknown keys and unreadable values (BAD_INPUT)", () => {
    for (const bad of [{ maxPaymentsSats: 1 }, { dailyBudgetSats: 0 }, { dailyBudgetSats: 1.5 }, { dailyBudgetSats: "100" },
      { allowedOps: [] }, { allowedOps: ["withdraw"] }, { allowedRecipients: ["a b"] }, { maxPaymentSats: 1, updatedAt: "soon" }, []]) {
      expect(() => validateLimits(bad), JSON.stringify(bad)).toThrow(expect.objectContaining({ code: "BAD_INPUT" }));
    }
  });
});

describe("readLimits / writeLimits", () => {
  it("round-trips with updatedAt, mode 0600; null removes the file", async () => {
    const path = join(dir, "sub", "limits.json");
    const written = await writeLimits({ maxPaymentSats: 500, updatedAt: "2000-01-01T00:00:00.000Z" }, path);
    expect(written.updatedAt).not.toBe("2000-01-01T00:00:00.000Z"); // the writer stamps it
    expect(await readLimits(path)).toEqual(written);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await writeLimits(null, path)).toBeNull();
    expect(await readLimits(path)).toBeNull();
    await writeLimits(null, path); // already gone: fine
  });

  it("an unreadable file is LIMITS_UNREADABLE, never null", async () => {
    const asDir = join(dir, "limits.json");
    await mkdir(asDir); // EISDIR, as root too
    await expect(readLimits(asDir)).rejects.toMatchObject({ code: "LIMITS_UNREADABLE", osCode: "EISDIR", retryable: "no" });
    const path = join(dir, "bad.json");
    await writeLimits({ maxPaymentSats: 1 }, path);
    await writeFile(path, "[1,2]"); // valid JSON, not limits
    await expect(readLimits(path)).rejects.toMatchObject({ code: "LIMITS_UNREADABLE" });
    expect(await readFile(path, "utf8")).toBe("[1,2]");
  });
});

describe("checkLimits", () => {
  it("allowedOps applies to inbound claims too; the amount and recipient rules don't", () => {
    const limits = { allowedOps: ["spark_transfer"], maxPaymentSats: 1, allowedRecipients: ["x"] };
    expect(checkLimits({ op: "claim_deposit" }, limits)).toMatchObject({ allow: false, rule: "allowedOps" });
    expect(checkLimits({ op: "claim_deposit", amountsSats: [100], recipients: ["y"] }, { maxPaymentSats: 1, allowedRecipients: ["x"] }))
      .toEqual({ allow: true });
  });

  it("an unreadable amount fails maxPaymentSats closed", () => {
    expect(checkLimits({ op: "fulfill_spark_invoice", amountsSats: [10, NaN] }, { maxPaymentSats: 100 }))
      .toMatchObject({ allow: false, rule: "maxPaymentSats" });
  });
});

describe("limitsChanges", () => {
  it("marks raising, removing and widening as looser; the reverse as tighter", () => {
    const before = { dailyBudgetSats: 100, maxPaymentSats: 10, allowedOps: ["spark_transfer"] };
    const after = { dailyBudgetSats: 50, allowedOps: ["spark_transfer", "lightning_pay"], allowedRecipients: ["a"] };
    expect(limitsChanges(before, after)).toEqual([
      { rule: "dailyBudgetSats", from: 100, to: 50, looser: false },
      { rule: "maxPaymentSats", from: 10, to: null, looser: true },
      { rule: "allowedOps", from: ["spark_transfer"], to: ["spark_transfer", "lightning_pay"], looser: true },
      { rule: "allowedRecipients", from: null, to: ["a"], looser: false },
    ]);
    expect(limitsChanges(after, after)).toEqual([]);
  });
});
