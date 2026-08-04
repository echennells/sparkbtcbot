import { describe, it, expect } from "vitest";
import {
  decodeInvoiceSats,
  invoicePaymentHash,
  paymentHashMatches,
  invoiceSecondsRemaining,
  invoiceIsExpired,
} from "../../lib/bolt11.js";

// A 7-day-expiry invoice from a live 2026-08-04 test (timestamp 1785852311,
// expiry 604800). Used to pin the expiry helpers at a known point in time.
const INVOICE_7D_EXPIRY =
  "lnbc200u1p48ruvhpp57pq3rhd3ukwxg8y5qdhuwkumj02uvcxsykxqh2k3gna07c4hsuhqcqzyssp57ahuxvygweykvt5d70u5tuu2j4nj98zc2l9xl8cudmf852hyrhus9q7sqqqqqqqqqqqqqqqqqqqsqqqqqysgqdqqmqz9gxqyjw5qrzjqwryaup9lh50kkranzgcdnn2fgvx390wgj5jd07rwr3vxeje0glcll64zuj6grcehyqqqqlgqqqqqeqqjq8wunu8wrddkshf9jyxf97kt7jsfzzsnze8ljdspcg90q4glw4xtj0vrs90v2589ut88hsddh902pmklzku8rlagv9atkshmrv4lrufspk3gk4t";
const INVOICE_7D_TS = 1785852311; // creation, seconds
const INVOICE_7D_EXPIRES = (INVOICE_7D_TS + 604800) * 1000; // ms

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

// The gap the on-ramp transcript exposed: a BOLT11's clock starts at creation,
// so any delayed-payment flow (esp. the L1 on-ramp's 3-confirmation wait) must
// check the invoice can outlive the delay BEFORE committing funds.
describe("invoiceSecondsRemaining / invoiceIsExpired", () => {
  it("computes remaining life against a fixed now (7-day-expiry sample)", () => {
    const justAfterCreation = (1785852311 + 60) * 1000; // 1 min in
    const rem = invoiceSecondsRemaining(INVOICE_7D_EXPIRY, justAfterCreation);
    expect(Math.round(rem)).toBe(604800 - 60); // ~7 days minus a minute
    expect(invoiceIsExpired(INVOICE_7D_EXPIRY, justAfterCreation)).toBe(false);
  });
  it("goes negative / reports expired once past the deadline", () => {
    const oneSecondAfterExpiry = INVOICE_7D_EXPIRES + 1000;
    expect(invoiceSecondsRemaining(INVOICE_7D_EXPIRY, oneSecondAfterExpiry)).toBeLessThan(0);
    expect(invoiceIsExpired(INVOICE_7D_EXPIRY, oneSecondAfterExpiry)).toBe(true);
  });
  it("an on-ramp buffer check would ACCEPT this 7-day invoice", () => {
    const now = (1785852311 + 300) * 1000; // 5 min after creation
    expect(invoiceSecondsRemaining(INVOICE_7D_EXPIRY, now)).toBeGreaterThan(2 * 60 * 60);
  });
  it("fails closed on an undecodable invoice (null remaining, expired=true)", () => {
    expect(invoiceSecondsRemaining("lnbc1notreal")).toBe(null);
    expect(invoiceSecondsRemaining("")).toBe(null);
    expect(invoiceIsExpired("lnbc1notreal")).toBe(true); // can't read the clock => don't pay
    expect(invoiceIsExpired(undefined)).toBe(true);
  });
});
