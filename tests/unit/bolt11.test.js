import { describe, it, expect } from "vitest";
import {
  decodeInvoiceSats,
  invoicePaymentHash,
  paymentHashMatches,
} from "../../lib/bolt11.js";

// Amount-ful sample (2,000 sats embedded) from light-bolt11-decoder's README —
// the same constant the SparkAgent lightning tests use.
const INVOICE_2000_SATS =
  "lnbc20u1p3y0x3hpp5743k2g0fsqqxj7n8qzuhns5gmkk4djeejk3wkp64ppevgekvc0jsdqcve5kzar2v9nr5gpqd4hkuetesp5ez2g297jduwc20t6lmqlsg3man0vf2jfd8ar9fh8fhn2g8yttfkqxqy9gcqcqzys9qrsgqrzjqtx3k77yrrav9hye7zar2rtqlfkytl094dsp0ms5majzth6gt7ca6uhdkxl983uywgqqqqlgqqqvx5qqjqrzjqd98kxkpyw0l9tyy8r8q57k7zpy9zjmh6sez752wj6gcumqnj3yxzhdsmg6qq56utgqqqqqqqqqqqeqqjq7jd56882gtxhrjm03c93aacyfy306m4fq0tskf83c0nmet8zc2lxyyg3saz8x6vwcp26xnrlagf9semau3qm2glysp7sv95693fphvsp54l567";

describe("decodeInvoiceSats", () => {
  it("reads the embedded amount in whole sats", () => {
    expect(decodeInvoiceSats(INVOICE_2000_SATS)).toBe(2000);
  });
  it("returns null for undecodable input (treated as amountless downstream)", () => {
    expect(decodeInvoiceSats("lnbc1notarealinvoice")).toBe(null);
    expect(decodeInvoiceSats("")).toBe(null);
    expect(decodeInvoiceSats(undefined)).toBe(null);
  });
});

describe("invoicePaymentHash / paymentHashMatches", () => {
  it("extracts a 64-char lowercase hex payment hash", () => {
    const hash = invoicePaymentHash(INVOICE_2000_SATS);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
  it("matches case-insensitively against the checkout's echoed hash", () => {
    const hash = invoicePaymentHash(INVOICE_2000_SATS);
    expect(paymentHashMatches(INVOICE_2000_SATS, hash)).toBe(true);
    expect(paymentHashMatches(INVOICE_2000_SATS, hash.toUpperCase())).toBe(true);
  });
  it("fails CLOSED: mismatched, missing, or undecodable => false, never true", () => {
    expect(paymentHashMatches(INVOICE_2000_SATS, "ab".repeat(32))).toBe(false);
    expect(paymentHashMatches(INVOICE_2000_SATS, undefined)).toBe(false);
    expect(paymentHashMatches(INVOICE_2000_SATS, "")).toBe(false);
    expect(paymentHashMatches("lnbc1notarealinvoice", "ab".repeat(32))).toBe(false);
  });
});
