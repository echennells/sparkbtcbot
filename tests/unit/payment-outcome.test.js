// What a failed payment means (lib/payment-outcome.js). A spend is recorded
// before the SDK call; when the call throws, only an error that PROVES no
// funds left may undo it. Before 2026-09-26 every SDK error undid the spend,
// so a loop of ambiguous failures — each of which may have paid — was never
// counted, and the daily budget could not stop it.
import { describe, it, expect } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SparkValidationError, SparkRequestError } from "@buildonspark/spark-sdk";
import { PRE_SEND_VALIDATION_MESSAGES, provesNothingSent, PaymentCommittedError } from "../../lib/payment-outcome.js";

// Raised AFTER a request has gone out, while reading an operator's reply.
const POST_SEND_VALIDATION_MESSAGES = [
  "No transfer response from operator",
  "SSP coop exit response missing L1 transaction fields",
];

const sdkSource = async () => {
  const dist = join("node_modules", "@buildonspark", "spark-sdk", "dist");
  const files = (await readdir(dist)).filter((f) => f.endsWith(".js"));
  return (await Promise.all(files.map((f) => readFile(join(dist, f), "utf8")))).join("\n");
};

describe("provesNothingSent", () => {
  it("is true only for an allowlisted pre-send SparkValidationError", () => {
    expect(provesNothingSent(new SparkValidationError("Total target amount exceeds available balance", { field: "targetAmounts" }))).toBe(true);
    expect(provesNothingSent(new SparkValidationError("Invoice network: REGTEST does not match wallet network: MAINNET"))).toBe(true);
    expect(provesNothingSent(new SparkValidationError("maxFeeSats does not cover fee estimate"))).toBe(true);
  });

  it("is false for anything that may have sent: post-send validation, request and plain errors", () => {
    for (const m of POST_SEND_VALIDATION_MESSAGES) expect(provesNothingSent(new SparkValidationError(m))).toBe(false);
    expect(provesNothingSent(new SparkRequestError("Failed to initiate preimage swap", {}))).toBe(false);
    expect(provesNothingSent(new Error("Total target amount exceeds available balance"))).toBe(false); // right words, wrong type
    expect(provesNothingSent(new Error("deadline exceeded"))).toBe(false);
    expect(provesNothingSent(undefined)).toBe(false);
  });

  it("every allowlisted message is still raised by the installed SDK (re-audit on a mismatch)", async () => {
    const src = await sdkSource();
    for (const m of PRE_SEND_VALIDATION_MESSAGES) {
      const raised = src.includes(`new SparkValidationError("${m}`) || src.includes(`new SparkValidationError(\`${m}`);
      expect(raised, `"${m}" is no longer raised by spark-sdk — re-audit lib/payment-outcome.js`).toBe(true);
    }
    for (const m of POST_SEND_VALIDATION_MESSAGES) expect(src.includes(`new SparkValidationError("${m}`)).toBe(true);
  });
});

describe("PaymentCommittedError", () => {
  it("carries the rule-relevant facts and no secret", () => {
    const cause = new Error("deadline exceeded");
    const err = new PaymentCommittedError("may have paid", { settled: null, op: "lightning_pay", invoiceHash: "ab".repeat(32), cause });
    expect(err).toMatchObject({ name: "PaymentCommittedError", code: "PAYMENT_COMMITTED", settled: null, op: "lightning_pay", cause });
    expect(err).toBeInstanceOf(Error);
    expect(Object.keys(err)).not.toContain("preimage");
  });
});

// The SparkAgent side of this rule (refund only on a proven pre-send error,
// PAYMENT_COMMITTED otherwise) is still on the parked sdk-013 line. This
// branch takes the module for fetchL402's PaymentCommittedError and keeps
// the SDK pins, so the list stays audited against the installed SDK.
